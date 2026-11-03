import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { HttpError, VIDEO_EXTENSIONS } from './jobs.js'
import { fsLimit } from './limit.js'

// Path helpers that keep every Folders / Move operation inside the downloads folder.

/** "a/b/../c" or "/a//b" -> ["a", "b", "c"]-style clean segments; ".." is rejected outright. */
export function segmentsOf(rel) {
  const parts = String(rel || '')
    .split(/[\\/]+/)
    .filter((p) => p && p !== '.')
  if (parts.includes('..')) throw new HttpError(400, 'Invalid path')
  return parts
}

export async function realRoot() {
  try {
    return await fs.realpath(config.downloadsDir)
  } catch {
    throw new HttpError(404, `Downloads folder not found: ${config.downloadsDir}`)
  }
}

export const isInside = (root, p) => p === root || p.startsWith(root + path.sep)

/**
 * Resolve a path relative to the downloads folder, refusing anything that ends up outside it
 * (including via symlinks in the parent folders).
 */
export async function resolveInRoot(rel) {
  const root = await realRoot()
  const parts = segmentsOf(rel)
  if (parts.length === 0) return { root, parts, full: root }

  let parent
  try {
    parent = await fs.realpath(path.join(root, ...parts.slice(0, -1)))
  } catch {
    throw new HttpError(404, 'Not found')
  }
  if (!isInside(root, parent)) throw new HttpError(403, 'Path is outside the downloads folder')
  return { root, parts, full: path.join(parent, parts[parts.length - 1]) }
}

// ---------- Folder sizes ----------

const STATS_TTL_MS = 10_000
const statsCache = new Map() // real dir path -> { at, promise }

/** Forget cached sizes, e.g. after deleting or moving files. */
export function invalidateStats() {
  statsCache.clear()
}

/**
 * Total bytes, file count and direct item count of a folder tree. Symlinks are counted, never followed.
 * Results are cached briefly: a converted series can hold 100k+ segment files, and the Folders tab
 * would otherwise re-walk all of them on every listing.
 */
export function folderStats(dir) {
  const hit = statsCache.get(dir)
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.promise
  const promise = walkStats(dir, true)
  statsCache.set(dir, { at: Date.now(), promise })
  promise.catch(() => statsCache.delete(dir))
  if (statsCache.size > 5000) statsCache.delete(statsCache.keys().next().value) // oldest first
  return promise
}

// Only the leaf fs calls go through the limiter (never the recursion), so the walk can't deadlock.
async function walkStats(dir, top = false) {
  const entries = await fsLimit(() => fs.readdir(dir, { withFileTypes: true })).catch(() => [])
  const parts = await Promise.all(
    entries.map((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return walkStats(p)
      return fsLimit(() => fs.lstat(p)).then(
        (st) => ({ size: st.size, files: 1 }),
        () => ({ size: 0, files: 0 }), // removed while walking
      )
    }),
  )
  const result = { size: 0, files: 0 }
  for (const s of parts) {
    result.size += s.size
    result.files += s.files
  }
  if (top) result.items = entries.length
  return result
}

// ---------- Videos ----------

const isVideo = (name) => VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase())

/** Every video under `dir` (hidden files and folders skipped), as [{ relativePath, fullPath, size, mtimeMs }]. */
export async function findVideos(dir) {
  const out = []
  async function walk(current, rel) {
    const entries = await fsLimit(() => fs.readdir(current, { withFileTypes: true })).catch(() => [])
    await Promise.all(
      entries.map(async (e) => {
        if (e.name.startsWith('.')) return
        const full = path.join(current, e.name)
        const relPath = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) return walk(full, relPath)
        if (!e.isFile() || !isVideo(e.name)) return
        const st = await fsLimit(() => fs.stat(full)).catch(() => null)
        if (st) out.push({ relativePath: relPath, fullPath: full, size: st.size, mtimeMs: st.mtimeMs })
      }),
    )
  }
  await walk(dir, '')
  return out
}
