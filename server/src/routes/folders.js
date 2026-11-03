import fs from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import { config } from '../config.js'
import { HttpError, SERIES_DIR, VIDEO_EXTENSIONS, busyJobIds, busyOutputIds } from '../services/jobs.js'
import { episodeGaps } from '../services/episodes.js'
import { folderStats, invalidateStats, isInside, resolveInRoot } from '../services/downloads.js'
import { isConvertedFolderName } from '../services/library.js'
import { isCutBusy } from '../services/cutFrames.js'

const router = Router()

/**
 * Missing episodes of a series folder: from its videos (a folder of MP4s), or from the manifest of converted output
 * ("<uuid>/drama/manifest.json", or "manifest.json" when inside drama/). [] when it isn't a series.
 */
async function seriesGaps(dir, names) {
  const list = names ?? (await fs.readdir(dir).catch(() => []))
  const videos = list.filter((n) => !n.startsWith('.') && VIDEO_EXTENSIONS.includes(path.extname(n).toLowerCase()))
  if (videos.length >= 2) return episodeGaps(videos)
  for (const manifest of [path.join(dir, 'manifest.json'), path.join(dir, SERIES_DIR, 'manifest.json')]) {
    try {
      const data = JSON.parse(await fs.readFile(manifest, 'utf8'))
      if (Array.isArray(data?.episodes)) return episodeGaps(data.episodes.map((e) => e.source || e.title || ''))
    } catch {
      /* not there */
    }
  }
  return []
}

async function describe(dir, name) {
  const p = path.join(dir, name)
  let st
  try {
    st = await fs.lstat(p)
  } catch {
    return null // removed while listing
  }
  const base = { name, modified: st.mtime.toISOString() }
  if (st.isSymbolicLink()) return { ...base, type: 'link', size: 0 }
  if (st.isDirectory()) {
    const [stats, gaps] = await Promise.all([folderStats(p), seriesGaps(p)])
    return { ...base, type: 'dir', ...stats, gaps }
  }
  return { ...base, type: 'file', size: st.size }
}

async function diskSpace(dir) {
  try {
    const s = await fs.statfs(dir)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  } catch {
    return null
  }
}

// List a folder: GET /api/folders?path=My%20Drama/Episode%201
router.get('/', async (req, res) => {
  const { root, parts, full } = await resolveInRoot(req.query.path)

  let real
  try {
    real = await fs.realpath(full)
  } catch {
    throw new HttpError(404, 'Folder not found')
  }
  if (!isInside(root, real)) throw new HttpError(403, 'Path is outside the downloads folder')
  if (!(await fs.stat(real)).isDirectory()) throw new HttpError(400, 'Not a folder')

  const names = await fs.readdir(real)
  const [entries, disk, gaps] = await Promise.all([
    Promise.all(names.map((n) => describe(real, n))),
    diskSpace(root),
    parts.length > 0 ? seriesGaps(real, names) : [], // the downloads folder itself isn't a series
  ])

  res.json({ root: config.downloadsDir, path: parts.join('/'), entries: entries.filter(Boolean), disk, gaps })
})

// Delete a folder (recursively) or a file: DELETE /api/folders?path=My%20Drama
router.delete('/', async (req, res) => {
  const { root, parts, full } = await resolveInRoot(req.query.path)
  if (parts.length === 0) throw new HttpError(400, 'The downloads folder itself cannot be deleted')

  try {
    await fs.lstat(full)
  } catch {
    throw new HttpError(404, 'Not found')
  }

  // Each job writes to "<downloads>/converted/<job id>/". Refuse to delete (inside) one that is still converting or
  // uploading to Cloudflare: ffmpeg / the upload would fail halfway with confusing errors.
  // Output lives in "converted/<job id>/"; deleting "converted" itself would take every job folder with it.
  const [first, second] = path.relative(root, full).split(path.sep)
  const busy = busyJobIds()
  const hit = isConvertedFolderName(first)
    ? second
      ? busy.has(second)
      : busyOutputIds().size > 0
    : busy.has(first) || isCutBusy(first)
  if (hit) {
    throw new HttpError(409, 'This folder is still being converted or uploaded. Cancel that job first, or wait for it to finish.')
  }

  // A symlink is removed as a link; its target is left alone
  await fs.rm(full, { recursive: true, force: true })
  invalidateStats()
  res.json({ deleted: parts.join('/') })
})

export default router
