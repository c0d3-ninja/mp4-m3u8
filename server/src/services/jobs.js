import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { transcodeToHls } from './transcoder.js'
import { recordUpload, updateMarker } from './marker.js'

export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi']
const MAX_FILES = 2000
// Every series is written to "<downloads>/<uuid>/drama/"; the real name is in drama.json next to it
export const SERIES_DIR = 'drama'

const jobs = new Map()
const queue = [] // [{ job, file }]
let active = 0

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Make a string safe to use as a single file/folder name. */
function safeName(value) {
  const cleaned = String(value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  return cleaned.slice(0, 150) || '_'
}

/** Path segments of a relative path, without empty, "." or ".." parts. */
function segmentsOf(relativePath) {
  return String(relativePath)
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
}

export function getJob(id) {
  const job = jobs.get(id)
  if (job) job.lastSeen = Date.now()
  return job
}

const isConverting = (job) => ['uploading', 'processing'].includes(job.status)
const isBusy = (job) => isConverting(job) || job.r2?.status === 'uploading'

/** Live jobs, e.g. for the Convert / Upload folder lists. */
export const allJobs = () => jobs.values()

// Cloudflare uploads of converted folders whose job is no longer in memory: id -> { id, workDir, outputRoot, r2, r2Controller }
const folderUploads = new Map()
export const getFolderUpload = (id) => folderUploads.get(id)

/**
 * Top-level names in the downloads folder that must not be deleted right now: output folders (job ids) still being
 * written or uploaded, and source folders a server-side conversion is still reading MP4s from.
 */
export function busyJobIds() {
  const ids = new Set()
  for (const job of jobs.values()) {
    if (isBusy(job)) ids.add(job.id)
    if (job.fromDisk && isConverting(job)) ids.add(job.source)
  }
  for (const u of folderUploads.values()) if (u.r2?.status === 'uploading') ids.add(u.id)
  return ids
}

// Finished jobs whose page was closed would otherwise stay in memory forever. Forgetting a done job
// keeps its output in the downloads folder (removeJob only deletes the partial output of failed jobs).
const IDLE_JOB_MS = 6 * 60 * 60 * 1000
setInterval(() => {
  const cutoff = Date.now() - IDLE_JOB_MS
  for (const job of jobs.values()) {
    if (job.lastSeen >= cutoff) continue
    if (!isBusy(job)) {
      removeJob(job).catch(() => {})
    } else if (job.status === 'uploading' && !job.files.some((f) => f.status === 'uploading')) {
      // Page closed mid-upload and never came back: keep the episodes that arrived, like "Convert uploaded episodes"
      finalizeUploads(job)
    }
  }
}, 15 * 60 * 1000).unref()

/**
 * Create a job for a folder. `files` = [{ relativePath, size }], paths relative to the folder.
 */
/** Optional poster/cover image URL for the drama: "" -> null, otherwise it must be http(s). */
export function cleanImageUrl(value) {
  const v = String(value ?? '').trim()
  if (!v) return null
  let url
  try {
    url = new URL(v)
  } catch {
    throw new HttpError(400, 'Image URL is not a valid URL (e.g. https://example.com/poster.jpg)')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Image URL must start with http:// or https://')
  if (v.length > 2048) throw new HttpError(400, 'Image URL is too long')
  return url.href
}

/** Optional category, e.g. "Romance": trimmed, inner whitespace collapsed; "" -> null. */
export function cleanCategory(value) {
  const v = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!v) return null
  if (v.length > 100) throw new HttpError(400, 'Category is too long (max 100 characters)')
  return v
}

/** Drama name from drama.json / the Move tab: trimmed, whitespace collapsed; "" -> null. */
export function cleanDramaName(value) {
  const v = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!v) return null
  if (v.length > 200) throw new HttpError(400, 'Drama name is too long (max 200 characters)')
  return v
}

export const DRAMA_FILE = 'drama.json'

/**
 * createJob({ folderName, files, drama? }): `drama` is the selected folder's drama.json
 * ({ dramaName, imageUrl, category }, written by the Move tab). It is copied to "<uuid>/drama.json";
 * without it the drama name is the folder name.
 */
export function createJob({ folderName, files, drama: info, fromDisk = false } = {}) {
  if (typeof folderName !== 'string' || !folderName.trim()) {
    throw new HttpError(400, 'folderName is required')
  }
  const drama = {
    dramaName: cleanDramaName(info?.dramaName) || folderName.trim(),
    imageUrl: cleanImageUrl(info?.imageUrl),
    category: cleanCategory(info?.category),
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new HttpError(400, 'Select at least one video')
  }
  if (files.length > MAX_FILES) {
    throw new HttpError(400, `Too many files (max ${MAX_FILES})`)
  }

  const folder = safeName(folderName)
  // The job id is a random UUID; the output goes to "<downloads>/<uuid>/drama/"
  const id = crypto.randomUUID()
  const usedOutputs = new Set()

  const sorted = files
    .map((f) => {
      if (!f || typeof f.relativePath !== 'string') throw new HttpError(400, 'Each file needs a relativePath')
      const segments = segmentsOf(f.relativePath)
      if (segments.length === 0) throw new HttpError(400, `Invalid path: ${f.relativePath}`)
      const ext = path.extname(segments[segments.length - 1]).toLowerCase()
      if (!VIDEO_EXTENSIONS.includes(ext)) throw new HttpError(400, `Not a supported video: ${f.relativePath}`)
      return { relativePath: segments.join('/'), size: Number(f.size) || 0, segments, ext }
    })
    .sort((a, b) => collator.compare(a.relativePath, b.relativePath))

  const jobFiles = sorted.map((f, index) => {
    // Output folder mirrors the source path without the extension:
    // "Season 1/Episode 01.mp4" -> "Season 1/Episode 01/"
    const parts = f.segments.map(safeName)
    parts[parts.length - 1] = safeName(path.basename(f.segments[f.segments.length - 1], f.ext))

    // macOS file systems are case-insensitive, so dedupe case-insensitively
    let outputPath = parts.join('/')
    for (let n = 2; usedOutputs.has(outputPath.toLowerCase()); n++) {
      outputPath = `${parts.join('/')}-${n}`
    }
    usedOutputs.add(outputPath.toLowerCase())

    return {
      id: String(index + 1),
      relativePath: f.relativePath,
      ext: f.ext,
      size: f.size,
      outputPath,
      status: 'pending', // pending → uploading → queued → converting → done | error
      progress: 0,
      error: null,
      result: null,
      inputPath: null,
    }
  })

  const job = {
    id,
    folderName: folder,
    // Name of the folder the episodes came from (browser selection or downloads folder); stored in .job.json
    source: folderName.trim(),
    // Converted straight from "<downloads>/<source>/": the MP4s are read in place and never deleted
    fromDisk,
    status: 'uploading', // uploading → processing → done | failed | cancelled
    createdAt: new Date().toISOString(),
    lastSeen: Date.now(),
    // Written to "<downloads>/<uuid>/drama.json" as soon as the job starts
    drama,
    files: jobFiles,
    uploadsComplete: false,
    output: null, // { folder, path, size } once done
    error: null,
    cancelled: false,
    uploadDir: path.join(config.uploadsDir, id),
    workDir: path.join(config.downloadsDir, id),
    outputRoot: path.join(config.downloadsDir, id, SERIES_DIR),
    controllers: new Set(),
    running: new Set(),
    r2: null, // Cloudflare upload of the converted output
    r2Controller: null,
  }
  jobs.set(id, job)
  return job
}

/** The job as sent to the client. */
export function toPublic(job) {
  return {
    id: job.id,
    folderName: job.folderName,
    source: job.source,
    fromDisk: job.fromDisk,
    drama: job.drama,
    status: job.status,
    createdAt: job.createdAt,
    uploadsComplete: job.uploadsComplete,
    error: job.error,
    output: job.output,
    r2: job.r2,
    hlsBaseUrl: `/hls/${job.id}/${SERIES_DIR}`,
    files: job.files.map((f) => ({
      id: f.id,
      relativePath: f.relativePath,
      size: f.size,
      outputPath: f.outputPath,
      status: f.status,
      progress: f.progress,
      error: f.error,
      result: f.result,
    })),
  }
}

/** "<downloads>/<uuid>/drama.json" next to the series folder: { dramaName, imageUrl, category }. */
export async function writeDramaInfo(job) {
  await fsp.mkdir(job.workDir, { recursive: true })
  await fsp.writeFile(path.join(job.workDir, DRAMA_FILE), `${JSON.stringify(job.drama, null, 2)}\n`)
  await updateMarker(job.workDir, () => ({
    id: job.id,
    source: job.source,
    createdAt: job.createdAt,
    status: 'converting',
    uploads: [],
  }))
}

/** Called after a file finished uploading to disk (or, with keepInput, for a file already in the downloads folder). */
export function markUploaded(job, file, inputPath, { keepInput = false } = {}) {
  file.inputPath = inputPath
  file.keepInput = keepInput
  file.status = 'queued'
  queue.push({ job, file })
  pump()
}

/** Client says it's done uploading. Anything not uploaded is marked as failed. */
export function finalizeUploads(job) {
  if (job.cancelled) throw new HttpError(409, 'Job was cancelled')
  if (job.uploadsComplete) return
  if (job.files.some((f) => f.status === 'uploading')) {
    throw new HttpError(409, 'A file is still uploading')
  }
  for (const f of job.files) {
    if (f.status === 'pending') {
      f.status = 'error'
      f.error = 'Not uploaded'
    }
  }
  job.uploadsComplete = true
  job.status = 'processing'
  maybeFinish(job)
}

function pump() {
  while (active < config.concurrency && queue.length > 0) {
    const { job, file } = queue.shift()
    if (job.cancelled) continue
    active++
    const task = convert(job, file).finally(() => {
      active--
      job.running.delete(task)
      maybeFinish(job)
      pump()
    })
    job.running.add(task)
  }
}

async function convert(job, file) {
  const controller = new AbortController()
  job.controllers.add(controller)
  file.status = 'converting'
  file.progress = 0
  const outDir = path.join(job.outputRoot, ...file.outputPath.split('/'))

  try {
    file.result = await transcodeToHls(file.inputPath, outDir, {
      signal: controller.signal,
      onProgress: (p) => {
        file.progress = p
      },
    })
    file.status = 'done'
    file.progress = 1
  } catch (err) {
    if (job.cancelled) return
    file.status = 'error'
    file.error = friendlyError(err, file)
    console.error(`[${job.folderName}] ${file.relativePath}: ${file.error}`)
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {})
  } finally {
    job.controllers.delete(controller)
    // An uploaded copy is no longer needed either way; free the disk space. Source MP4s in the downloads folder stay.
    if (file.inputPath && !file.keepInput) await fsp.rm(file.inputPath, { force: true }).catch(() => {})
  }
}

function friendlyError(err, file) {
  const message = String(err?.message || 'Conversion failed')
  if (/moov atom not found|Invalid data found when processing input/i.test(message)) {
    return 'Not a valid or complete video file'
  }
  return message
    .split(file.inputPath).join(file.relativePath)
    .replace(/\[[^\]]+ @ 0x[0-9a-f]+\]\s*/gi, '')
    .trim()
}

function maybeFinish(job) {
  if (job.cancelled || !job.uploadsComplete || job.status !== 'processing') return
  const busy = job.files.some((f) => ['pending', 'uploading', 'queued', 'converting'].includes(f.status))
  if (busy) return

  if (!job.files.some((f) => f.status === 'done')) {
    job.status = 'failed'
    job.error = 'No video could be converted'
    updateMarker(job.workDir, (m) => ({ ...m, status: 'failed' }))
    return
  }

  writeManifest(job).then(
    (size) => {
      if (job.cancelled) return
      job.output = {
        folder: `${job.id}/${SERIES_DIR}`, // relative to the downloads folder
        path: job.outputRoot,
        size,
      }
      job.status = 'done'
      updateMarker(job.workDir, (m) => ({
        ...m,
        status: 'done',
        completedAt: new Date().toISOString(),
        episodes: job.files.filter((f) => f.status === 'done').length,
      }))
    },
    (err) => {
      if (job.cancelled) return
      console.error(`[${job.folderName}] manifest failed:`, err)
      job.status = 'failed'
      job.error = `Could not write manifest.json: ${err.message}`
      updateMarker(job.workDir, (m) => ({ ...m, status: 'failed' }))
    },
  )
}

function buildManifest(job) {
  const done = job.files.filter((f) => f.status === 'done')
  return {
    title: job.folderName,
    createdAt: new Date().toISOString(),
    episodeCount: done.length,
    episodes: done.map((f, i) => ({
      number: i + 1,
      title: path.posix.basename(f.outputPath),
      source: f.relativePath,
      playlist: `${f.outputPath}/master.m3u8`,
      poster: f.result.poster ? `${f.outputPath}/${f.result.poster}` : null,
      duration: Math.round(f.result.duration * 1000) / 1000,
      width: f.result.width,
      height: f.result.height,
      fps: f.result.fps,
      renditions: f.result.renditions,
    })),
    failed: job.files
      .filter((f) => f.status === 'error')
      .map((f) => ({ source: f.relativePath, error: f.error })),
  }
}

/** Write manifest.json next to the episodes and return the total size of the output folder. */
async function writeManifest(job) {
  await fsp.writeFile(
    path.join(job.outputRoot, 'manifest.json'),
    JSON.stringify(buildManifest(job), null, 2),
  )
  return folderSize(job.outputRoot)
}

async function folderSize(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  const sizes = await Promise.all(
    entries.map((e) => {
      const p = path.join(dir, e.name)
      return e.isDirectory() ? folderSize(p) : fsp.lstat(p).then((st) => st.size, () => 0)
    }),
  )
  return sizes.reduce((a, b) => a + b, 0)
}

/**
 * Upload "<workDir>/drama/" + drama.json to Cloudflare R2 in the background. `target` is a job or a folder upload
 * ({ workDir, outputRoot, r2, r2Controller }); its `r2` state is mutated with progress so it can be polled.
 * `uploadDirectory` is passed in to keep this module free of the S3 dependency.
 */
function runR2Upload(target, connection, prefix, uploadDirectory, { skipExisting = true } = {}) {
  if (target.r2?.status === 'uploading') throw new HttpError(409, 'Already uploading to Cloudflare')

  const controller = new AbortController()
  target.r2Controller = controller
  const state = {
    status: 'uploading', // uploading → done | failed | cancelled
    bucket: connection.bucket,
    prefix,
    total: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    totalBytes: 0,
    uploadedBytes: 0,
    errors: [],
    fatal: null,
    startedAt: new Date().toISOString(),
  }
  target.r2 = state

  uploadDirectory(connection, target.outputRoot, prefix, state, {
    signal: controller.signal,
    skipExisting,
    extraFiles: [{ relativePath: DRAMA_FILE, fullPath: path.join(target.workDir, DRAMA_FILE) }],
  }).then(
    () => {
      if (controller.signal.aborted) state.status = 'cancelled'
      else state.status = state.failed > 0 || state.fatal ? 'failed' : 'done'
      if (state.status === 'done') recordUpload(target.workDir, { bucket: state.bucket, prefix })
    },
    (err) => {
      state.status = controller.signal.aborted ? 'cancelled' : 'failed'
      state.fatal = err.message
    },
  ).finally(() => {
    if (target.r2Controller === controller) target.r2Controller = null
  })
  return state
}

/** Upload the converted output of a finished job (the "Upload" box after converting). */
export function startR2Upload(job, connection, prefix, uploadDirectory, options) {
  if (job.status !== 'done') throw new HttpError(409, 'Convert the episodes first')
  return runR2Upload(job, connection, prefix, uploadDirectory, options)
}

/**
 * Upload a converted "<downloads>/<id>/" folder from the Upload tab's list. Uses the live job when it is still in
 * memory, so both places show the same progress.
 */
export function startFolderUpload(id, connection, prefix, uploadDirectory, options) {
  const job = jobs.get(id)
  if (job) return startR2Upload(job, connection, prefix, uploadDirectory, options)
  let target = folderUploads.get(id)
  if (!target) {
    const workDir = path.join(config.downloadsDir, id)
    target = { id, workDir, outputRoot: path.join(workDir, SERIES_DIR), r2: null, r2Controller: null }
    folderUploads.set(id, target)
  }
  return runR2Upload(target, connection, prefix, uploadDirectory, options)
}

export function cancelFolderUpload(id) {
  ;(jobs.get(id) || folderUploads.get(id))?.r2Controller?.abort()
}

export function cancelR2Upload(job) {
  job.r2Controller?.abort()
}

/**
 * Cancel (if running) and forget a job. Finished output stays in the downloads folder
 * (delete it from the Folders tab); a cancelled or failed job's partial output is removed.
 */
export async function removeJob(job) {
  const keepOutput = job.status === 'done'
  job.cancelled = true
  job.r2Controller?.abort()
  if (!['done', 'failed'].includes(job.status)) job.status = 'cancelled'
  jobs.delete(job.id)

  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].job === job) queue.splice(i, 1)
  }
  for (const c of job.controllers) c.abort()
  await Promise.allSettled([...job.running])

  await Promise.all(
    [job.uploadDir, ...(keepOutput ? [] : [job.workDir])].map((dir) =>
      fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}),
    ),
  )
}

/** On startup: create storage folders and drop half-finished uploads from a previous run. */
export async function prepareStorage() {
  await fsp.rm(config.uploadsDir, { recursive: true, force: true })
  await Promise.all([config.uploadsDir, config.downloadsDir].map((dir) => fsp.mkdir(dir, { recursive: true })))
  await fsp.writeFile(path.join(config.uploadsDir, '.gitkeep'), '')
}
