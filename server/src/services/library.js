import fsp from 'node:fs/promises'
import path from 'node:path'
import { CONVERTED_FOLDER, config } from '../config.js'
import { findVideos, folderStats, isInside, realRoot } from './downloads.js'
import { isCutBusy, isCutFile, readCutMarker } from './cutFrames.js'
import { fsLimit } from './limit.js'
import { readMarker } from './marker.js'
import { episodeGaps } from './episodes.js'
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
  dramaSummary,
  OUTPUT_ID,
} from './jobs.js'

// What the downloads folder holds, for the Convert tab (folders of MP4s) and the Upload tab (converted output).

// Output folder names: the drama's id ("7690462225898820616") or, for older output / dramas without an id, a UUID
const isOutputName = (name) => OUTPUT_ID.test(name)

async function readJson(file) {
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

/** A converter output folder: "<downloads>/converted/<id>/" holding manifest.json or .job.json (or old drama/). */
async function isOutputDir(name) {
  if (!isOutputName(name)) return false
  const dir = path.join(config.convertedDir, name)
  const has = (p) => fsp.stat(path.join(dir, p)).then(() => true, () => false)
  return (await has('manifest.json')) || (await has('.job.json')) || (await has(SERIES_DIR))
}

/** "converted" (any case: macOS folders are case-insensitive) is the output folder, never a drama to convert. */
export const isConvertedFolderName = (name) => String(name).toLowerCase() === CONVERTED_FOLDER

const pickDrama = dramaSummary

/** Status of a converted folder: the live job wins over what .job.json says. */
function outputStatus(job, marker, hasManifest) {
  if (job) return ['uploading', 'processing'].includes(job.status) ? 'converting' : job.status
  if (marker?.status === 'converting') return 'interrupted' // server stopped mid-conversion
  if (marker?.status) return marker.status
  return hasManifest ? 'done' : 'interrupted' // converted before .job.json existed
}

async function describeOutput(name, liveJobs) {
  const dir = path.join(config.convertedDir, name)
  const [drama, marker, manifest, stats] = await Promise.all([
    readJson(path.join(dir, DRAMA_FILE)),
    readMarker(dir),
    readJson(path.join(dir, 'manifest.json')),
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
    // Episode numbers missing from the series (e.g. never downloaded): [[6, 15]]
    gaps: Array.isArray(manifest?.episodes) ? episodeGaps(manifest.episodes.map((e) => e.source || e.title || '')) : [],
    size: stats.size,
    createdAt: marker?.createdAt || null,
    completedAt: marker?.completedAt || manifest?.createdAt || null,
    uploads: Array.isArray(marker?.uploads) ? marker.uploads : [],
    r2,
  }
}

async function describeSource(root, name) {
  const dir = path.join(root, name)
  const [videos, drama, st, cutMarker] = await Promise.all([
    findVideos(dir),
    readJson(path.join(dir, DRAMA_FILE)),
    fsp.stat(dir),
    readCutMarker(dir),
  ])
  // Episode count from drama.json ("totalEpisodes", saved by the extension); null when missing or not a number
  const total = Number(drama?.totalEpisodes)
  const totalEpisodes = Number.isInteger(total) && total > 0 ? total : null
  const gaps = episodeGaps(videos.map((v) => v.relativePath), totalEpisodes ?? 0)
  return {
    name,
    videos: videos.length,
    // Videos whose first frames were already cut (Cut frames tab)
    framesCut: videos.filter((v) => isCutFile(cutMarker, v)).length,
    cutting: isCutBusy(name),
    totalEpisodes,
    // Every episode is there: as many videos as drama.json says, and no episode number missing
    complete: totalEpisodes !== null && videos.length === totalEpisodes && gaps.length === 0,
    size: videos.reduce((s, v) => s + v.size, 0),
    gaps,
    modified: st.mtime.toISOString(),
    hasDrama: Boolean(drama), // a readable drama.json object in the folder
    drama: pickDrama(drama),
  }
}

/** GET /api/library: { root, sources: [...], converted: [...] }; each source lists the conversions made from it. */
export async function scanLibrary() {
  const root = await realRoot()
  const liveJobs = new Map([...allJobs()].map((j) => [j.id, j]))
  const dirsIn = async (dir) =>
    (await fsp.readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)

  // Sources: the folders at the top of Downloads (not "converted/"); output: "converted/<id>/"
  const [sourceNames, outputNames] = await Promise.all([dirsIn(root), dirsIn(config.convertedDir)])
  const outputs = (await Promise.all(outputNames.map(async (n) => ((await isOutputDir(n)) ? n : null)))).filter(Boolean)
  const [converted, sources] = await Promise.all([
    Promise.all(outputs.map((n) => describeOutput(n, liveJobs))),
    Promise.all(sourceNames.filter((n) => !isConvertedFolderName(n)).map((n) => describeSource(root, n))),
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
    // Only folders with videos and a drama.json (written by the Move tab / the extension) are offered for conversion
    sources: sources.filter((s) => s.videos > 0 && s.hasDrama),
    converted,
  }
}

/** One converted folder (same shape as scanLibrary().converted[]), or null. */
export async function getConverted(id) {
  if (!isOutputName(id) || !(await isOutputDir(id))) return null
  return describeOutput(id, new Map([...allJobs()].map((j) => [j.id, j])))
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
  if (isConvertedFolderName(folder)) throw new HttpError(400, 'That is the folder of converted output')

  if (isCutBusy(folder)) throw new HttpError(409, `"${folder}" is still having its first frames cut`)
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
    drama: drama && typeof drama === 'object' && !Array.isArray(drama) ? drama : null,
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
