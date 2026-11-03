import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { CONVERTED_FOLDER, config } from '../config.js'
import { limitedCommand } from './cpu.js'
import { findVideos, isInside, realRoot } from './downloads.js'
import { HttpError } from './jobs.js'
import { createLimiter } from './limit.js'
import { isCutFile, onEpisodeCut, readCutMarker } from './cutFrames.js'

// Cut frames tab: a folder's episodes, and single frames of them as small JPEGs, to check the start of each video.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const ffmpegLimit = createLimiter(3) // a 60-episode folder asks for 120 frames at once
const cache = new Map() // "path|size|mtime|n|width" -> Buffer (newest last)
const CACHE_MAX = 600

/** Drop every cached frame of one video. */
export function clearFrames(fullPath) {
  const prefix = `${fullPath}|`
  let removed = 0
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
      removed++
    }
  }
  return removed
}

// When an episode is cut, its old frames are stale: clear them right away
onEpisodeCut(clearFrames)

async function folderDir(name) {
  const folder = String(name ?? '')
  if (!folder || folder.startsWith('.') || /[\\/\u0000]/.test(folder) || folder.toLowerCase() === CONVERTED_FOLDER) {
    throw new HttpError(400, 'Pick a folder from the list')
  }
  const root = await realRoot()
  let real
  try {
    real = await fsp.realpath(path.join(root, folder))
  } catch {
    throw new HttpError(404, `"${folder}" no longer exists`)
  }
  if (!isInside(root, real) || real === root) throw new HttpError(403, 'Path is outside the downloads folder')
  return real
}

/** Episode number = the last number in the file name ("EP07.mp4" -> 7), as for missing-episode checks. */
function episodeNumber(relativePath) {
  const m = path.posix.basename(relativePath).replace(/\.[^.]+$/, '').match(/(\d+)(?!.*\d)/)
  return m ? Number(m[1]) : null
}

/** GET /api/cut/episodes?folder=: [{ file, episode, size, version, cut }] in episode order. */
export async function listEpisodes(folder) {
  const dir = await folderDir(folder)
  const [videos, marker] = await Promise.all([findVideos(dir), readCutMarker(dir)])
  return videos
    .map((v) => ({
      file: v.relativePath,
      episode: episodeNumber(v.relativePath),
      size: v.size,
      version: Math.round(v.mtimeMs), // changes when the file is cut, so the browser reloads its frames
      cut: isCutFile(marker, v),
    }))
    .sort((a, b) => (a.episode ?? Infinity) - (b.episode ?? Infinity) || collator.compare(a.file, b.file))
}

/** JPEG of frame `n` (0-based) of one video, `width` pixels wide. */
export async function frameJpeg(folder, file, n, width = 180) {
  const dir = await folderDir(folder)
  const rel = String(file ?? '')
  const parts = rel.split('/')
  if (!rel || parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new HttpError(400, 'Bad file')
  const full = path.join(dir, ...parts)
  if (!isInside(dir, full)) throw new HttpError(403, 'Path is outside the folder')
  const st = await fsp.stat(full).catch(() => null)
  if (!st?.isFile()) throw new HttpError(404, 'File not found')

  const frame = Math.max(0, Math.min(1000, Math.floor(Number(n) || 0)))
  const w = Math.max(40, Math.min(640, Math.floor(Number(width) || 180)))
  const key = `${full}|${st.size}|${st.mtimeMs}|${frame}|${w}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }

  const jpeg = await ffmpegLimit(() => extract(full, frame, w))
  cache.set(key, jpeg)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return jpeg
}

function extract(input, frame, width) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1',
      '-i', input,
      '-vf', `select=eq(n\\,${frame}),scale=${width}:-2`,
      '-fps_mode', 'passthrough', '-frames:v', '1',
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1',
    ]
    const [bin, binArgs] = limitedCommand(config.ffmpegPath, args)
    const child = spawn(bin, binArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout.on('data', (c) => chunks.push(c))
    child.stderr.on('data', (c) => (stderr = (stderr + c).slice(-2000)))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const out = Buffer.concat(chunks)
      if (code === 0 && out.length > 0) return resolve(out)
      reject(new HttpError(422, out.length === 0 && code === 0 ? `The video has no frame ${frame + 1}` : stderr.trim().split('\n').pop() || 'Could not read the frame'))
    })
  })
}
