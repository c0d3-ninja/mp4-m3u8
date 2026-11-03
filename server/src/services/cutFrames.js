import fsp from 'node:fs/promises'
import path from 'node:path'
import { CONVERTED_FOLDER, config } from '../config.js'
import { cpuLimit, helperThreads } from './cpu.js'
import { findVideos, invalidateStats, isInside, realRoot } from './downloads.js'
import { HttpError, busyJobIds } from './jobs.js'
import { probe, runTool } from './transcoder.js'

// Cut frames tab: removes the first CUT_FRAMES (default 3) frames of every video in a folder, before converting, and
// saves the result over the original file. Folders are cut one after another on the server (it keeps going when the
// page is closed). On the first error the queue pauses and shows it; the original file is never touched on failure.
//
// "<folder>/.frames-cut.json" remembers which files were already cut (by size + modified time), so a file is never
// cut twice, and episodes added to the folder later are still cut.

export const CUT_FRAMES = Math.max(1, Math.floor(Number(process.env.CUT_FRAMES) || 3))
export const CUT_MARKER = '.frames-cut.json'
const CUTTABLE = new Set(['.mp4', '.m4v', '.mov', '.mkv']) // containers that can hold H.264 + AAC
const CRF = 17 // visually lossless; the converter re-encodes again anyway

// ---------- Marker ----------

export async function readCutMarker(dir) {
  try {
    const data = JSON.parse(await fsp.readFile(path.join(dir, CUT_MARKER), 'utf8'))
    return data && typeof data.files === 'object' && data.files ? data : { files: {} }
  } catch {
    return { files: {} }
  }
}

/** Was this video ({ relativePath, size, mtimeMs }) already cut, and not replaced since? */
export function isCutFile(marker, video) {
  const e = marker.files[video.relativePath]
  return Boolean(e && e.size === video.size && Math.abs(e.mtimeMs - video.mtimeMs) < 1)
}

const markerLocks = new Map()
function recordCut(dir, relativePath, st) {
  const run = async () => {
    const marker = await readCutMarker(dir)
    marker.frames = CUT_FRAMES
    marker.files[relativePath] = { size: st.size, mtimeMs: st.mtimeMs, frames: CUT_FRAMES, at: new Date().toISOString() }
    await fsp.writeFile(path.join(dir, CUT_MARKER), `${JSON.stringify(marker, null, 2)}\n`)
  }
  const prev = markerLocks.get(dir) || Promise.resolve()
  const done = prev.then(run, run)
  markerLocks.set(dir, done)
  return done
}

// ---------- After an episode is cut ----------

const cutListeners = new Set()
/** Run `fn(fullPath)` whenever an episode has been cut (e.g. to drop cached preview frames of the old file). */
export function onEpisodeCut(fn) {
  cutListeners.add(fn)
}

function episodeCut(fullPath) {
  invalidateStats() // folder sizes changed
  for (const fn of cutListeners) {
    try {
      fn(fullPath)
    } catch (err) {
      console.error('[cut frames] cache clear failed:', err.message)
    }
  }
}

// ---------- Cutting one file ----------

async function cutFile(video, { signal, onProgress }) {
  const ext = path.extname(video.fullPath).toLowerCase()
  if (!CUTTABLE.has(ext)) throw new Error(`Can't cut ${ext} files (only ${[...CUTTABLE].join(', ')})`)

  const info = await probe(video.fullPath, { signal })
  if (!info.fps) throw new Error('Could not read the frame rate')
  const seconds = CUT_FRAMES / info.fps
  const expected = info.duration - seconds
  if (expected <= 0) throw new Error('The video is shorter than the frames to cut')

  // Hidden temp file next to the original, so the final rename is instant (same disk)
  const dir = path.dirname(video.fullPath)
  const tmp = path.join(dir, `.${path.basename(video.fullPath, ext)}.cutting${ext}`)
  const args = [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-threads', String(helperThreads()),
    '-i', video.fullPath,
    '-map', '0:v:0',
    // Drop exactly the first N frames; timestamps restart at 0
    '-vf', `trim=start_frame=${CUT_FRAMES},setpts=PTS-STARTPTS`,
    '-c:v', 'libx264', '-preset', config.ffmpegPreset, '-crf', String(CRF), '-pix_fmt', 'yuv420p',
    '-threads', String(cpuLimit.limit),
  ]
  if (info.hasAudio) {
    // The same duration off the audio, so it stays in sync
    args.push('-map', '0:a:0', '-af', `atrim=start=${seconds.toFixed(6)},asetpts=PTS-STARTPTS`, '-c:a', 'aac', '-b:a', '192k')
  }
  args.push('-map_metadata', '0', ...(ext === '.mkv' ? [] : ['-movflags', '+faststart']), tmp)

  let buffer = ''
  try {
    await runTool(config.ffmpegPath, args, {
      signal,
      onStdout(chunk) {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          const m = /^out_time_us=(\d+)/.exec(line)
          if (m && expected > 0) onProgress?.(Math.min(0.99, Number(m[1]) / 1e6 / expected))
        }
      },
    })

    // Check the result before it replaces the original
    const out = await probe(tmp, { signal })
    const tolerance = Math.max(0.5, 2 / info.fps)
    if (!(out.duration > 0) || Math.abs(out.duration - expected) > tolerance) {
      throw new Error(`The cut file is ${out.duration.toFixed(2)}s long, expected about ${expected.toFixed(2)}s`)
    }
    await fsp.rename(tmp, video.fullPath)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return fsp.stat(video.fullPath)
}

// ---------- Queue ----------

const states = new Map() // folder -> { folder, status, total, done, current, progress, errors, finishedAt }
let queue = [] // folder names waiting
let running = null // { folder, controller }
let paused = false // set on the first error; nothing continues until resume()

export const isCutBusy = (folder) => running?.folder === folder || queue.includes(folder)

async function resolveFolder(name) {
  const folder = String(name ?? '')
  if (!folder || folder.startsWith('.') || /[\\/\u0000]/.test(folder) || folder === '..') {
    throw new HttpError(400, 'Pick a folder from the list')
  }
  if (folder.toLowerCase() === CONVERTED_FOLDER) throw new HttpError(400, 'That is the folder of converted output')
  const root = await realRoot()
  let real
  try {
    real = await fsp.realpath(path.join(root, folder))
  } catch {
    throw new HttpError(404, `"${folder}" no longer exists in the downloads folder`)
  }
  if (!isInside(root, real) || real === root) throw new HttpError(403, 'Path is outside the downloads folder')
  return { folder, dir: real }
}

/** Queue a folder (POST /api/cut { folder }). */
export async function queueCut(name) {
  const { folder } = await resolveFolder(name)
  if (busyJobIds().has(folder)) throw new HttpError(409, `"${folder}" is being converted right now; cut it before converting`)
  if (!isCutBusy(folder)) {
    queue.push(folder)
    states.set(folder, { folder, status: 'queued', total: null, done: 0, current: null, progress: 0, errors: [] })
  }
  // Asking for a folder is a fresh start: it runs even if an earlier error paused the queue
  paused = false
  pump()
  return getCutState()
}

/** Queue several folders, e.g. every one not fully cut yet. */
export async function queueCutMany(names) {
  for (const n of names) await queueCut(n)
  return getCutState()
}

/** Cancel a queued or running folder. Files already cut stay cut; the one in progress is left as it was. */
export function cancelCut(folder) {
  queue = queue.filter((f) => f !== folder)
  const s = states.get(folder)
  if (running?.folder === folder) running.controller.abort()
  else if (s && ['queued', 'failed'].includes(s.status)) s.status = 'cancelled'
  // Skipping the folder that paused the queue: carry on with the rest
  if (paused && ![...states.values()].some((x) => x.status === 'failed')) {
    paused = false
    pump()
  }
  return getCutState()
}

/** Stop the folder being cut and empty the queue. Files already cut stay cut; the one in progress is left as it was. */
export function cancelAllCut() {
  for (const folder of queue) {
    const s = states.get(folder)
    if (s) s.status = 'cancelled'
  }
  queue = []
  for (const s of states.values()) if (s.status === 'failed') s.status = 'cancelled'
  paused = false
  running?.controller.abort()
  return getCutState()
}

/** After a pause: try the failed folders again first, then the rest of the queue. */
export function resumeCut() {
  const failed = [...states.values()].filter((s) => s.status === 'failed').map((s) => s.folder)
  for (const f of failed) {
    if (!isCutBusy(f)) {
      queue.unshift(f)
      states.set(f, { ...states.get(f), status: 'queued', errors: [], current: null, progress: 0 })
    }
  }
  paused = false
  pump()
  return getCutState()
}

function pump() {
  if (running || paused || queue.length === 0) return
  const folder = queue.shift()
  const controller = new AbortController()
  running = { folder, controller }
  processFolder(folder, controller.signal)
    .catch((err) => {
      const s = states.get(folder)
      s.status = 'failed'
      s.errors.push({ file: null, error: err.message })
      paused = true
    })
    .finally(() => {
      running = null
      pump()
    })
}

async function processFolder(folder, signal) {
  const s = states.get(folder)
  s.status = 'cutting'
  const { dir } = await resolveFolder(folder)
  const videos = (await findVideos(dir)).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }),
  )
  const marker = await readCutMarker(dir)
  const todo = videos.filter((v) => !isCutFile(marker, v))
  s.total = videos.length
  s.done = videos.length - todo.length

  for (const video of todo) {
    if (signal.aborted) break
    s.current = video.relativePath
    s.progress = 0
    try {
      const st = await cutFile(video, { signal, onProgress: (p) => (s.progress = p) })
      await recordCut(dir, video.relativePath, st)
      episodeCut(video.fullPath)
      s.done++
    } catch (err) {
      if (signal.aborted) break
      s.status = 'failed'
      s.errors.push({ file: video.relativePath, error: friendly(err, video) })
      s.current = null
      paused = true
      console.error(`[cut frames] ${folder}/${video.relativePath}: ${err.message}`)
      return
    }
  }
  s.current = null
  s.status = signal.aborted ? 'cancelled' : 'done'
  s.finishedAt = new Date().toISOString()
}

function friendly(err, video) {
  const message = String(err?.message || 'Cutting failed')
  if (/moov atom not found|Invalid data found when processing input/i.test(message)) return 'Not a valid or complete video file'
  return message.split(video.fullPath).join(video.relativePath).replace(/\[[^\]]+ @ 0x[0-9a-f]+\]\s*/gi, '').trim()
}

export function getCutState() {
  return { frames: CUT_FRAMES, paused, running: running?.folder ?? null, queue: [...queue], folders: [...states.values()] }
}
