import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { transcodeToHls } from './transcoder.js'
import { recordUpload, updateMarker } from './marker.js'

export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi']
const MAX_FILES = 2000
// Every series is written to "<downloads>/converted/<id>/" (episode folders + manifest.json + drama.json), <id> being
// the "id" in drama.json; the real name is in drama.json next to it
// Old layout only: the episodes used to sit in "<uuid>/drama/". Now they are directly in "<uuid>/" next to
// manifest.json and drama.json; old folders are flattened on startup (see flattenOutput).
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

/** Output folders ("converted/<id>/") that are being written to or uploaded right now. */
export function busyOutputIds() {
  const ids = new Set()
  for (const job of jobs.values()) if (isBusy(job)) ids.add(job.id)
  for (const u of folderUploads.values()) if (u.r2?.status === 'uploading') ids.add(u.id)
  return ids
}

// Finished jobs whose page was closed would otherwise stay in memory forever. Forgetting a done job
// keeps its output in the downloads folder (removeJob only deletes the partial output of failed jobs).
const IDLE_JOB_MS = 6 * 60 * 60 * 1000
// A browser upload whose page was closed or navigated away (no polling, nothing arriving) for this long is finished
// with the episodes that did arrive, so they are converted and get a manifest instead of waiting forever.
const ABANDONED_UPLOAD_MS = 10 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const job of jobs.values()) {
    if (job.status === 'uploading' && !job.files.some((f) => f.status === 'uploading')) {
      if (job.lastSeen < now - ABANDONED_UPLOAD_MS) {
        try {
          finalizeUploads(job)
        } catch {
          /* cancelled meanwhile */
        }
      }
    } else if (!isBusy(job) && job.lastSeen < now - IDLE_JOB_MS) {
      removeJob(job).catch(() => {})
    }
  }
}, 60 * 1000).unref()

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

/** Drama name from drama.json / the Move tab: trimmed, whitespace collapsed; "" -> null. */
export function cleanDramaName(value) {
  const v = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!v) return null
  if (v.length > 200) throw new HttpError(400, 'Drama name is too long (max 200 characters)')
  return v
}

export const DRAMA_FILE = 'drama.json'

const MAX_DRAMA_JSON = 64 * 1024

/**
 * drama.json content: any JSON object (the Move tab stores what was pasted, e.g. an entry of dramas-next.json:
 * { id, dramaName, category: [...], description, posterImageUrl, totalEpisodes, dramaUrl, app_dramaName, ... }).
 * Every key is kept; "dramaName" falls back to `fallbackName`, and "imageUrl", when present, must be http(s).
 */
export function cleanDramaJson(value, fallbackName = null) {
  if (value == null) return fallbackName ? { dramaName: fallbackName } : null
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'drama.json must be a JSON object')
  const text = JSON.stringify(value)
  if (text.length > MAX_DRAMA_JSON) throw new HttpError(400, 'drama.json is too large (max 64 KB)')
  const drama = JSON.parse(text) // a plain copy
  const name = cleanDramaName(drama.dramaName) || fallbackName
  if (name) drama.dramaName = name
  if ('imageUrl' in drama) drama.imageUrl = cleanImageUrl(drama.imageUrl)
  return drama
}

/** What the UI shows of a drama.json: { dramaName, imageUrl, category } (app_dramaName / posterImageUrl preferred). */
export function dramaSummary(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const category = Array.isArray(data.category) ? data.category.filter((c) => typeof c === 'string').join(', ') : data.category
  return {
    dramaName: str(data.app_dramaName) || str(data.dramaName),
    imageUrl: str(data.imageUrl) || str(data.posterImageUrl),
    category: str(category),
  }
}

/**
 * createJob({ folderName, files, drama? }): `drama` is the selected folder's drama.json (written by the Move tab),
 * copied with all its keys to "converted/<id>/drama.json"; without it the drama name is the folder name.
 */
/** A drama.json "id" usable as a folder name, or null. */
export const OUTPUT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export function dramaIdOf(drama) {
  const v = drama?.id
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const id = String(v).trim()
  return OUTPUT_ID.test(id) ? id : null
}
const outputIdOf = (drama) => dramaIdOf(drama) ?? crypto.randomUUID()

export function createJob({ folderName, files, drama: info, fromDisk = false } = {}) {
  if (typeof folderName !== 'string' || !folderName.trim()) {
    throw new HttpError(400, 'folderName is required')
  }
  const drama = cleanDramaJson(info ?? null, folderName.trim())
  if (!Array.isArray(files) || files.length === 0) {
    throw new HttpError(400, 'Select at least one video')
  }
  if (files.length > MAX_FILES) {
    throw new HttpError(400, `Too many files (max ${MAX_FILES})`)
  }

  const folder = safeName(folderName)
  // The job id is the drama's "id" from drama.json (e.g. "7690462225898820616"); the output goes to
  // "<downloads>/converted/<id>/". Only a drama without a usable id falls back to a random UUID.
  const id = outputIdOf(drama)
  if (busyJobIds().has(id)) {
    throw new HttpError(409, `Drama ${id} is already being converted or uploaded. Wait for it, or cancel it first.`)
  }
  // Converting the same drama again replaces its earlier output (writeDramaInfo clears the folder). Forget the old
  // job so its idle cleanup can never touch the new one.
  jobs.delete(id)
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
    // Written to "converted/<id>/drama.json" as soon as the job starts
    drama,
    files: jobFiles,
    uploadsComplete: false,
    output: null, // { folder, path, size } once done
    error: null,
    cancelled: false,
    uploadDir: path.join(config.uploadsDir, id),
    workDir: path.join(config.convertedDir, id),
    outputRoot: path.join(config.convertedDir, id), // episodes go straight into the "<id>" folder
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
    hlsBaseUrl: `/hls/${job.id}`,
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

/** "converted/<id>/drama.json" next to the episodes: { cfId: <id>, ...the source folder's drama.json }. */
export async function writeDramaInfo(job) {
  // A new conversion of the same drama starts from an empty folder (createJob refused it while that one was busy)
  await fsp.rm(job.workDir, { recursive: true, force: true, maxRetries: 3 })
  await fsp.mkdir(job.workDir, { recursive: true })
  // "cfId" = this conversion's folder name (and default bucket folder), first in the file: the drama's own "id",
  // or a random UUID for a drama without one. Every other key is copied from the source drama.json.
  const { cfId: _old, ...rest } = job.drama || {}
  const info = { cfId: job.id, ...rest }
  await fsp.writeFile(path.join(job.workDir, DRAMA_FILE), `${JSON.stringify(info, null, 2)}\n`)
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
        folder: `converted/${job.id}`, // relative to the downloads folder
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
    // Old layout (episodes in "drama/"): drama.json sits outside the uploaded folder, so add it
    extraFiles:
      target.outputRoot === target.workDir
        ? []
        : [{ relativePath: DRAMA_FILE, fullPath: path.join(target.workDir, DRAMA_FILE) }],
  }).then(
    () => {
      if (controller.signal.aborted) state.status = 'cancelled'
      else state.status = state.failed > 0 || state.fatal ? 'failed' : 'done'
      // uploadDirectory only finishes without failures once every file was found in the bucket
      if (state.status === 'done') recordUpload(target.workDir, { bucket: state.bucket, prefix, files: state.verify?.total })
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
    const workDir = path.join(config.convertedDir, id)
    target = { id, workDir, outputRoot: workDir, r2: null, r2Controller: null }
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
  // A newer conversion of the same drama reuses the id (and the folder): leave that one alone
  const replaced = jobs.get(job.id) !== job
  if (!replaced) jobs.delete(job.id)

  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].job === job) queue.splice(i, 1)
  }
  for (const c of job.controllers) c.abort()
  await Promise.allSettled([...job.running])

  await Promise.all(
    (replaced ? [] : [job.uploadDir, ...(keepOutput ? [] : [job.workDir])]).map((dir) =>
      fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}),
    ),
  )
}

/** On startup: create storage folders and drop half-finished uploads from a previous run. */
export async function prepareStorage() {
  await fsp.rm(config.uploadsDir, { recursive: true, force: true })
  await Promise.all(
    [config.uploadsDir, config.downloadsDir, config.convertedDir].map((dir) => fsp.mkdir(dir, { recursive: true })),
  )
  await fsp.writeFile(path.join(config.uploadsDir, '.gitkeep'), '')
  await moveOldOutput()
  // Old "<uuid>/drama/<episodes>" folders: move the episodes up into "<uuid>/"
  const converted = await fsp.readdir(config.convertedDir, { withFileTypes: true }).catch(() => [])
  for (const e of converted) {
    if (!e.isDirectory() || !UUID_NAME.test(e.name)) continue
    // Never let tidying up stop the server from starting
    await flattenOutput(path.join(config.convertedDir, e.name)).catch((err) =>
      console.warn(`Could not flatten ${e.name}: ${err.message}`),
    )
  }
}

/** "<uuid>/drama/*" -> "<uuid>/*", then remove the empty drama/. Renames on the same disk, so it is instant. */
export async function flattenOutput(dir) {
  const series = path.join(dir, SERIES_DIR)
  const names = await fsp.readdir(series).catch(() => null)
  if (!names) return false
  let left = 0
  for (const name of names) {
    const to = path.join(dir, name)
    if (await fsp.lstat(to).then(() => true, () => false)) {
      if (name !== '.DS_Store') console.warn(`Not moving ${path.join(series, name)}: ${to} already exists`)
      left++
      continue
    }
    await fsp.rename(path.join(series, name), to)
  }
  if (left === 0 || (left === 1 && names.includes('.DS_Store'))) {
    // Empty now (apart from a .DS_Store): remove it
    await fsp.rm(series, { recursive: true, force: true })
  }
  console.log(`Flattened ${path.basename(dir)}: episodes moved out of ${SERIES_DIR}/`)
  return true
}

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Conversions made before "converted/" existed sit at "<downloads>/<uuid>/": move them into "converted/<uuid>/"
 * (a rename on the same disk, so it is instant). Nothing is converting yet at startup.
 */
async function moveOldOutput() {
  const entries = await fsp.readdir(config.downloadsDir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory() || !UUID_NAME.test(e.name)) continue
    const from = path.join(config.downloadsDir, e.name)
    const to = path.join(config.convertedDir, e.name)
    const isOutput =
      (await fsp.stat(path.join(from, SERIES_DIR)).then((s) => s.isDirectory(), () => false)) ||
      (await fsp.stat(path.join(from, 'manifest.json')).then((s) => s.isFile(), () => false))
    if (!isOutput) continue
    if (await fsp.stat(to).then(() => true, () => false)) {
      console.warn(`Not moving ${from}: ${to} already exists`)
      continue
    }
    try {
      await fsp.rename(from, to)
      console.log(`Moved converted folder ${e.name} into ${config.convertedDir}`)
    } catch (err) {
      console.warn(`Could not move ${from} into ${config.convertedDir}: ${err.message}`)
    }
  }
}
