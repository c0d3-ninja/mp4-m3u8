import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { ZipArchive } from 'archiver'
import { config } from '../config.js'
import { transcodeToHls } from './transcoder.js'

export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi']
const MAX_FILES = 2000

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
  return jobs.get(id)
}

/**
 * Create a job for a folder. `files` = [{ relativePath, size }], paths relative to the folder.
 */
export function createJob({ folderName, files } = {}) {
  if (typeof folderName !== 'string' || !folderName.trim()) {
    throw new HttpError(400, 'folderName is required')
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new HttpError(400, 'Select at least one video')
  }
  if (files.length > MAX_FILES) {
    throw new HttpError(400, `Too many files (max ${MAX_FILES})`)
  }

  const folder = safeName(folderName)
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
    status: 'uploading', // uploading → processing → zipping → done | failed | cancelled
    createdAt: new Date().toISOString(),
    files: jobFiles,
    uploadsComplete: false,
    zip: null,
    zipProgress: 0,
    error: null,
    cancelled: false,
    uploadDir: path.join(config.uploadsDir, id),
    workDir: path.join(config.hlsDir, id),
    outputRoot: path.join(config.hlsDir, id, folder),
    zipPath: path.join(config.zipsDir, id, `${folder}.zip`),
    controllers: new Set(),
    running: new Set(),
  }
  jobs.set(id, job)
  return job
}

/** The job as sent to the client. */
export function toPublic(job) {
  return {
    id: job.id,
    folderName: job.folderName,
    status: job.status,
    createdAt: job.createdAt,
    uploadsComplete: job.uploadsComplete,
    error: job.error,
    zip: job.zip,
    zipProgress: job.zipProgress,
    hlsBaseUrl: `/hls/${job.id}/${encodeURIComponent(job.folderName)}`,
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

/** Called after a file finished uploading to disk. */
export function markUploaded(job, file, inputPath) {
  file.inputPath = inputPath
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
    // The upload is no longer needed either way; free the disk space.
    if (file.inputPath) await fsp.rm(file.inputPath, { force: true }).catch(() => {})
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
    return
  }

  job.status = 'zipping'
  createZip(job).then(
    (size) => {
      if (job.cancelled) return
      job.zip = { fileName: `${job.folderName}.zip`, size }
      job.status = 'done'
    },
    (err) => {
      if (job.cancelled) return
      console.error(`[${job.folderName}] zip failed:`, err)
      job.status = 'failed'
      job.error = `Could not create zip: ${err.message}`
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
      renditions: f.result.renditions,
    })),
    failed: job.files
      .filter((f) => f.status === 'error')
      .map((f) => ({ source: f.relativePath, error: f.error })),
  }
}

/** Zip "<outputRoot>" as "<FolderName>.zip" containing a "<FolderName>/" folder. */
async function createZip(job) {
  await fsp.writeFile(
    path.join(job.outputRoot, 'manifest.json'),
    JSON.stringify(buildManifest(job), null, 2),
  )
  await fsp.mkdir(path.dirname(job.zipPath), { recursive: true })
  await fsp.rm(job.zipPath, { force: true })

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(job.zipPath)
    // Video segments are already compressed; storing is much faster and the same size.
    const archive = new ZipArchive({ store: true })

    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err)
    })
    archive.on('progress', ({ fs: p }) => {
      if (p.totalBytes > 0) job.zipProgress = Math.min(1, p.processedBytes / p.totalBytes)
    })

    archive.pipe(output)
    archive.directory(job.outputRoot, job.folderName)
    archive.finalize()
  })

  job.zipProgress = 1
  const { size } = await fsp.stat(job.zipPath)
  return size
}

/** Cancel (if running) and delete everything belonging to a job. */
export async function removeJob(job) {
  job.cancelled = true
  if (!['done', 'failed'].includes(job.status)) job.status = 'cancelled'
  jobs.delete(job.id)

  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].job === job) queue.splice(i, 1)
  }
  for (const c of job.controllers) c.abort()
  await Promise.allSettled([...job.running])

  await Promise.all(
    [job.uploadDir, job.workDir, path.dirname(job.zipPath)].map((dir) =>
      fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}),
    ),
  )
}

/** On startup: create storage folders and drop half-finished uploads from a previous run. */
export async function prepareStorage() {
  await fsp.rm(config.uploadsDir, { recursive: true, force: true })
  await Promise.all(
    [config.uploadsDir, config.hlsDir, config.zipsDir].map((dir) => fsp.mkdir(dir, { recursive: true })),
  )
  await fsp.writeFile(path.join(config.uploadsDir, '.gitkeep'), '')
}
