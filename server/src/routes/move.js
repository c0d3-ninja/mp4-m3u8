import fs from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import { config } from '../config.js'
import { DRAMA_FILE, HttpError, cleanDramaJson, dramaSummary } from '../services/jobs.js'
import { invalidateStats, isInside, realRoot } from '../services/downloads.js'
import { episodeGaps } from '../services/episodes.js'
import { isConvertedFolderName } from '../services/library.js'

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
        if (!e.name.startsWith('.') && !isConvertedFolderName(e.name)) folders.push(e.name)
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
 * "  I Raised Two Sons, But One Betrayed Me! " -> "I-Raised-Two-Sons-But-One-Betrayed-Me": letters and numbers only,
 * every other character removed, spaces -> "-". Keep in sync with folderSlug() in client/src/utils.js and
 * folderSlug() in extension/background.js.
 */
export function folderSlug(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s-]+/gu, '') // drop every special character: ' . , ! ? : & ( ) …
    .trim()
    .replace(/[\s-]+/g, '-') // spaces (and runs of "-") -> one "-"
    .replace(/^-+|-+$/g, '')
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
 * Write "<folder>/drama.json" = the pasted JSON. When the folder already has one (more episodes added later), keys
 * that the new JSON doesn't have keep their old values.
 */
async function writeDramaFile(dir, drama) {
  const file = path.join(dir, DRAMA_FILE)
  let old = {}
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object') old = parsed
  } catch {
    /* none yet, or unreadable: start fresh */
  }
  const merged = { ...old, ...drama }
  await fs.writeFile(file, `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

/** Folder name for a drama.json: its app_dramaName, else dramaName. */
const nameOf = (drama) =>
  [drama?.app_dramaName, drama?.dramaName].find((v) => typeof v === 'string' && v.trim())?.trim() || ''

// Move MP4s into a folder: POST /api/move { drama: {...drama.json}, folder?, files?: ["Episode 1.mp4", ...] }
// `drama` is written as drama.json; the folder is named after its app_dramaName (else dramaName), cleaned to e.g.
// "Loves-Story", unless `folder` is given. `files` is the list the UI showed; when it's left out, every MP4
// currently at the top level is moved.
router.post('/', async (req, res) => {
  const root = await realRoot()
  // Validate everything before touching the disk
  if (!req.body?.drama || typeof req.body.drama !== 'object' || Array.isArray(req.body.drama)) {
    throw new HttpError(400, 'Paste the drama JSON (an object with app_dramaName or dramaName)')
  }
  if (!req.body?.folder && !nameOf(req.body.drama)) {
    throw new HttpError(400, 'The drama JSON needs "app_dramaName" or "dramaName" (the folder is named after it)')
  }
  const folder = cleanFolderName(req.body?.folder || nameOf(req.body.drama))
  if (isConvertedFolderName(folder)) {
    throw new HttpError(400, `"${folder}" is where converted output goes; give the drama another folder name`)
  }
  const info = cleanDramaJson(req.body.drama, nameOf(req.body.drama) || folder)
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
  res.json({ folder, created, moved, skipped, drama: dramaSummary(drama), keys: Object.keys(drama).length })
})

export default router
