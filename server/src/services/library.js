import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { folderStats, isInside, realRoot } from './downloads.js'
import { fsLimit } from './limit.js'
import { readMarker } from './marker.js'
import {
  DRAMA_FILE,
  HttpError,
  SERIES_DIR,
  VIDEO_EXTENSIONS,
  allJobs,
  createJob,
  finalizeUploads,
  getFolderUpload,
  markUploaded,
  removeJob,
  toPublic,
  writeDramaInfo,
} from './jobs.js'

// What the downloads folder holds, for the Convert tab (folders of MP4s) and the Upload tab (converted output).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isVideo = (name) => VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase())

async function readJson(file) {
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

/** A converter output folder: "<root>/<uuid>/" holding "drama/". */
async function isOutputDir(root, name) {
  if (!UUID.test(name)) return false
  const st = await fsp.stat(path.join(root, name, SERIES_DIR)).catch(() => null)
  return Boolean(st?.isDirectory())
}

/** Every video under `dir` (hidden files and folders skipped), as [{ relativePath, fullPath, size }]. */
async function findVideos(dir) {
  const out = []
  async function walk(current, rel) {
    const entries = await fsLimit(() => fsp.readdir(current, { withFileTypes: true })).catch(() => [])
    await Promise.all(
      entries.map(async (e) => {
        if (e.name.startsWith('.')) return
        const full = path.join(current, e.name)
        const relPath = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) return walk(full, relPath)
        if (!e.isFile() || !isVideo(e.name)) return
        const st = await fsLimit(() => fsp.stat(full)).catch(() => null)
        if (st) out.push({ relativePath: relPath, fullPath: full, size: st.size })
      }),
    )
  }
  await walk(dir, '')
  return out
}

function pickDrama(data) {
  if (!data) return null
  const pick = (k) => (typeof data[k] === 'string' && data[k].trim() ? data[k].trim() : null)
  return { dramaName: pick('dramaName'), imageUrl: pick('imageUrl'), category: pick('category') }
}

/** Status of a converted folder: the live job wins over what .job.json says. */
function outputStatus(job, marker, hasManifest) {
  if (job) return ['uploading', 'processing'].includes(job.status) ? 'converting' : job.status
  if (marker?.status === 'converting') return 'interrupted' // server stopped mid-conversion
  if (marker?.status) return marker.status
  return hasManifest ? 'done' : 'interrupted' // converted before .job.json existed
}

async function describeOutput(root, name, liveJobs) {
  const dir = path.join(root, name)
  const [drama, marker, manifest, stats] = await Promise.all([
    readJson(path.join(dir, DRAMA_FILE)),
    readMarker(dir),
    readJson(path.join(dir, SERIES_DIR, 'manifest.json')),
    folderStats(dir),
  ])
  const job = liveJobs.get(name)
  const r2 = job?.r2 || getFolderUpload(name)?.r2 || null
  const status = outputStatus(job, marker, Boolean(manifest))
  return {
    id: name,
    drama: pickDrama(drama),
    // Folders converted before .job.json existed only know their drama name
    source: marker?.source || drama?.dramaName || null,
    status,
    progress: job ? job.files.filter((f) => ['done', 'error'].includes(f.status)).length / job.files.length : null,
    episodes: manifest?.episodeCount ?? marker?.episodes ?? null,
    size: stats.size,
    createdAt: marker?.createdAt || null,
    completedAt: marker?.completedAt || manifest?.createdAt || null,
    uploads: Array.isArray(marker?.uploads) ? marker.uploads : [],
    r2,
  }
}

async function describeSource(root, name) {
  const dir = path.join(root, name)
  const [videos, drama, st] = await Promise.all([
    findVideos(dir),
    readJson(path.join(dir, DRAMA_FILE)),
    fsp.stat(dir),
  ])
  return {
    name,
    videos: videos.length,
    size: videos.reduce((s, v) => s + v.size, 0),
    modified: st.mtime.toISOString(),
    drama: pickDrama(drama),
  }
}

/** GET /api/library: { root, sources: [...], converted: [...] }; each source lists the conversions made from it. */
export async function scanLibrary() {
  const root = await realRoot()
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const liveJobs = new Map([...allJobs()].map((j) => [j.id, j]))

  const kinds = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map(async (e) => ({ name: e.name, output: await isOutputDir(root, e.name) })),
  )
  const [converted, sources] = await Promise.all([
    Promise.all(kinds.filter((k) => k.output).map((k) => describeOutput(root, k.name, liveJobs))),
    Promise.all(kinds.filter((k) => !k.output).map((k) => describeSource(root, k.name))),
  ])

  for (const src of sources) {
    // Match by the recorded source folder; older output (no .job.json) by drama name
    const names = new Set([src.name, src.drama?.dramaName].filter(Boolean))
    src.conversions = converted
      .filter((c) => c.source && names.has(c.source))
      .map((c) => ({ id: c.id, status: c.status, completedAt: c.completedAt, episodes: c.episodes }))
  }

  return {
    root: config.downloadsDir,
    // Folders without videos (e.g. an empty one) are not offered for conversion
    sources: sources.filter((s) => s.videos > 0),
    converted,
  }
}

/** One converted folder (same shape as scanLibrary().converted[]), or null. */
export async function getConverted(id) {
  const root = await realRoot()
  if (!UUID.test(id) || !(await isOutputDir(root, id))) return null
  return describeOutput(root, id, new Map([...allJobs()].map((j) => [j.id, j])))
}

/**
 * POST /api/library/convert { folder, files? }: convert "<downloads>/<folder>/" in place, without uploading anything.
 * `files` ([{ relativePath, size }], e.g. the episodes ticked after picking the folder in the browser) limits it to
 * those videos; each must exist there with the same size, otherwise 409 so the browser uploads its own copy instead.
 */
export async function convertFolder(name, only) {
  const folder = String(name ?? '')
  if (!folder || folder.startsWith('.') || /[\\/\u0000]/.test(folder) || folder === '..') {
    throw new HttpError(400, 'Pick a folder from the list')
  }
  const root = await realRoot()
  const dir = path.join(root, folder)
  let real
  try {
    real = await fsp.realpath(dir)
  } catch {
    throw new HttpError(404, `"${folder}" no longer exists in the downloads folder`)
  }
  if (!isInside(root, real) || real === root) throw new HttpError(403, 'Path is outside the downloads folder')
  if (await isOutputDir(root, folder)) throw new HttpError(400, 'That is already a converted folder')

  for (const job of allJobs()) {
    if (job.fromDisk && job.source === folder && ['uploading', 'processing'].includes(job.status)) {
      throw new HttpError(409, `"${folder}" is already being converted`)
    }
  }

  let videos = await findVideos(real)
  if (videos.length === 0) throw new HttpError(400, `No videos in "${folder}"`)
  if (Array.isArray(only)) {
    const onDisk = new Map(videos.map((v) => [v.relativePath, v]))
    videos = only.map((f) => {
      const v = onDisk.get(String(f?.relativePath ?? ''))
      if (!v || v.size !== Number(f?.size)) {
        throw new HttpError(409, `"${folder}" on the server has different files than the folder you picked`)
      }
      return v
    })
    if (videos.length === 0) throw new HttpError(400, 'Select at least one video')
  }
  const drama = await readJson(path.join(real, DRAMA_FILE))

  const job = createJob({
    folderName: folder,
    files: videos.map((v) => ({ relativePath: v.relativePath, size: v.size })),
    drama: pickDrama(drama),
    fromDisk: true,
  })
  try {
    await writeDramaInfo(job)
  } catch (err) {
    await removeJob(job)
    throw new HttpError(500, `Could not create the output folder: ${err.message}`)
  }

  // createJob sorted and renamed the files; match them back by relative path
  const byPath = new Map(videos.map((v) => [v.relativePath, v.fullPath]))
  for (const file of job.files) {
    const fullPath = byPath.get(file.relativePath)
    if (fullPath) {
      markUploaded(job, file, fullPath, { keepInput: true })
    } else {
      // e.g. a "\" in a Linux file name, which createJob treats as a folder separator
      file.status = 'error'
      file.error = 'Could not read this file name'
    }
  }
  finalizeUploads(job)
  return toPublic(job)
}
