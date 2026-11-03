import { Router } from 'express'
import path from 'node:path'
import { config } from '../config.js'
import { cleanPrefix, connectionFromRequest, uploadDirectory, verifyDirectory } from '../services/r2.js'
import { DRAMA_FILE, HttpError, SERIES_DIR, cancelFolderUpload, startFolderUpload } from '../services/jobs.js'
import { forgetUpload, recordUpload } from '../services/marker.js'
import { convertFolder, getConverted, scanLibrary } from '../services/library.js'

const router = Router()

// Folders of MP4s (Convert tab) and converted output (Upload tab) in the downloads folder
router.get('/', async (req, res) => {
  res.json(await scanLibrary())
})

// Convert "<downloads>/<folder>/" in place: { folder, files?: [{ relativePath, size }] }
router.post('/convert', async (req, res) => {
  res.status(201).json(await convertFolder(req.body?.folder, req.body?.files))
})

// Upload "<downloads>/<id>/" to Cloudflare R2 (credentials in X-R2-* headers): { prefix?, skipExisting? }
// The bucket folder defaults to the id, so every conversion gets its own folder.
router.post('/:id/upload', async (req, res) => {
  const entry = await getConverted(req.params.id)
  if (!entry) throw new HttpError(404, 'Converted folder not found')
  if (entry.status !== 'done') throw new HttpError(409, 'Only finished conversions can be uploaded')
  const connection = connectionFromRequest(req)
  const prefix = cleanPrefix(req.body?.prefix || entry.id)
  const r2 = startFolderUpload(entry.id, connection, prefix, uploadDirectory, {
    skipExisting: req.body?.skipExisting !== false,
  })
  res.json({ id: entry.id, r2 })
})

// Check that the bucket really holds every local file (name + size): GET /api/library/:id/verify?prefix=
// The prefix defaults to where this folder was last uploaded in this bucket, else the id.
router.get('/:id/verify', async (req, res) => {
  const entry = await getConverted(req.params.id)
  if (!entry) throw new HttpError(404, 'Converted folder not found')
  const connection = connectionFromRequest(req)
  const last = [...entry.uploads].reverse().find((u) => u.bucket === connection.bucket)
  const prefix = cleanPrefix(req.query.prefix || last?.prefix || entry.id)
  const workDir = path.join(config.convertedDir, entry.id)
  const result = await verifyDirectory(connection, path.join(workDir, SERIES_DIR), prefix, {
    extraFiles: [{ relativePath: DRAMA_FILE, fullPath: path.join(workDir, DRAMA_FILE) }],
  })
  // A complete bucket copy counts as uploaded (also for uploads made before verification existed)
  if (result.ok) await recordUpload(workDir, { bucket: connection.bucket, prefix, files: result.total })
  else await forgetUpload(workDir, { bucket: connection.bucket, prefix })
  res.json({ id: entry.id, bucket: connection.bucket, prefix, ...result, missing: result.missing.slice(0, 200) })
})

router.delete('/:id/upload', (req, res) => {
  cancelFolderUpload(req.params.id)
  res.json({ ok: true })
})

export default router
