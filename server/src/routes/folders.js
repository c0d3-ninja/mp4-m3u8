import fs from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import { config } from '../config.js'
import { HttpError, busyJobIds } from '../services/jobs.js'
import { folderStats, invalidateStats, isInside, resolveInRoot } from '../services/downloads.js'

const router = Router()

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
  if (st.isDirectory()) return { ...base, type: 'dir', ...(await folderStats(p)) }
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
  const [entries, disk] = await Promise.all([
    Promise.all(names.map((n) => describe(real, n))),
    diskSpace(root),
  ])

  res.json({ root: config.downloadsDir, path: parts.join('/'), entries: entries.filter(Boolean), disk })
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

  // Each job writes to "<downloads>/<job id>/". Refuse to delete (inside) one that is still converting or
  // uploading to Cloudflare: ffmpeg / the upload would fail halfway with confusing errors.
  const jobFolder = path.relative(root, full).split(path.sep)[0]
  if (busyJobIds().has(jobFolder)) {
    throw new HttpError(409, 'This folder is still being converted or uploaded. Cancel that job first, or wait for it to finish.')
  }

  // A symlink is removed as a link; its target is left alone
  await fs.rm(full, { recursive: true, force: true })
  invalidateStats()
  res.json({ deleted: parts.join('/') })
})

export default router
