import fs from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import { config } from '../config.js'
import { DRAMA_FILE, HttpError, cleanCategory, cleanDramaName, cleanImageUrl } from '../services/jobs.js'
import { invalidateStats, isInside, realRoot } from '../services/downloads.js'
import { episodeGaps } from '../services/episodes.js'

const router = Router()

const isMp4 = (name) => name.toLowerCase().endsWith('.mp4') && !name.startsWith('.') // skips "._Episode 1.mp4"

/** MP4 files directly inside the downloads folder (not in sub-folders), plus the existing folder names. */
async function scan(root) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const files = []
  const folders = []
  await Promise.all(
    entries.map(async (e) => {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) folders.push(e.name)
        return
      }
      if (!e.isFile() || !isMp4(e.name)) return
      const st = await fs.lstat(path.join(root, e.name)).catch(() => null)
      if (st) files.push({ name: e.name, size: st.size, modified: st.mtime.toISOString() })
    }),
  )
  return { files, folders }
}

/**
 * "  Love's  Story Vol.2 " -> "Loves-Story-Vol2": apostrophes and dots removed, each run of spaces -> one "-".
 * Keep in sync with folderSlug() in client/src/utils.js, which previews the same name.
 */
export function folderSlug(value) {
  return String(value ?? '')
    .replace(/['\u2018\u2019.]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** A single folder name: no slashes, nothing a file system would reject. */
function cleanFolderName(value) {
  const name = folderSlug(value)
  if (!name) throw new HttpError(400, 'Enter a folder name')
  if (/[\\/\u0000]/.test(name)) {
    throw new HttpError(400, 'The folder name cannot contain "/" or "\\"')
  }
  if (Buffer.byteLength(name) > 255) throw new HttpError(400, 'The folder name is too long')
  return name
}

/** rename(), falling back to copy + delete when the target folder is on another disk (a symlinked folder). */
async function moveFile(from, to) {
  try {
    await fs.rename(from, to)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL)
    await fs.rm(from)
  }
}

// Files that would be moved: GET /api/move
router.get('/', async (req, res) => {
  const root = await realRoot()
  const listing = await scan(root)
  res.json({ root: config.downloadsDir, ...listing, gaps: episodeGaps(listing.files.map((f) => f.name)) })
})

/**
 * Write "<folder>/drama.json" = { dramaName, imageUrl, category }. When the folder already has one (more episodes
 * added later), its drama name is kept and empty fields keep their old values, so nothing has to be re-entered.
 */
async function writeDramaFile(dir, { dramaName, imageUrl, category }) {
  const file = path.join(dir, DRAMA_FILE)
  let old = {}
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object') old = parsed
  } catch {
    /* none yet, or unreadable: start fresh */
  }
  const drama = {
    dramaName: (typeof old.dramaName === 'string' && old.dramaName.trim()) || dramaName,
    imageUrl: imageUrl ?? old.imageUrl ?? null,
    category: category ?? old.category ?? null,
  }
  await fs.writeFile(file, `${JSON.stringify(drama, null, 2)}\n`)
  return drama
}

// Move MP4s into a folder: POST /api/move { folder, dramaName?, category?, imageUrl?, files?: ["Episode 1.mp4", ...] }
// `files` is the list the UI showed; when it's left out, every MP4 currently at the top level is moved.
// `folder` is cleaned to e.g. "Loves-Story"; `dramaName` (what was typed, "Love's Story") goes into drama.json.
router.post('/', async (req, res) => {
  const root = await realRoot()
  const folder = cleanFolderName(req.body?.folder)
  // Validate everything before touching the disk
  const info = {
    dramaName: cleanDramaName(req.body?.dramaName) || folder,
    imageUrl: cleanImageUrl(req.body?.imageUrl),
    category: cleanCategory(req.body?.category),
  }
  const { files: current } = await scan(root)
  const available = new Set(current.map((f) => f.name))

  const requested = Array.isArray(req.body?.files) ? req.body.files.map(String) : [...available]
  if (requested.length === 0) throw new HttpError(400, 'There are no MP4 files to move')

  // Create the folder if needed; an existing one must be a real folder inside the downloads folder
  const target = path.join(root, folder)
  let created = false
  const existing = await fs.lstat(target).catch(() => null)
  if (!existing) {
    await fs.mkdir(target)
    created = true
  } else {
    const real = await fs.realpath(target)
    if (!isInside(root, real)) throw new HttpError(403, `"${folder}" points outside the downloads folder`)
    if (!(await fs.stat(real)).isDirectory()) throw new HttpError(409, `"${folder}" already exists and is not a folder`)
  }

  const moved = []
  const skipped = []
  for (const name of requested) {
    if (!available.has(name)) {
      skipped.push({ name, reason: 'Not an MP4 at the top level of the downloads folder (moved or deleted?)' })
      continue
    }
    const to = path.join(target, name)
    if (await fs.lstat(to).catch(() => null)) {
      skipped.push({ name, reason: `A file with this name is already in "${folder}"` })
      continue
    }
    try {
      await moveFile(path.join(root, name), to)
      moved.push(name)
    } catch (err) {
      skipped.push({ name, reason: err.message })
    }
  }

  const drama = await writeDramaFile(target, info)
  invalidateStats()
  res.json({ folder, created, moved, skipped, drama })
})

export default router
