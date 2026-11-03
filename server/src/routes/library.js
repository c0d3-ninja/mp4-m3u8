import { Router } from 'express'
import { cleanPrefix, connectionFromRequest, uploadDirectory } from '../services/r2.js'
import { HttpError, cancelFolderUpload, startFolderUpload } from '../services/jobs.js'
import { convertFolder, getConverted, scanLibrary } from '../services/library.js'

const router = Router()

// Folders of MP4s (Convert tab) and converted output (Upload tab) in the downloads folder
router.get('/', async (req, res) => {
  res.json(await scanLibrary())
})

// Convert "<downloads>/<folder>/" in place: { folder }
router.post('/convert', async (req, res) => {
  res.status(201).json(await convertFolder(req.body?.folder))
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

router.delete('/:id/upload', (req, res) => {
  cancelFolderUpload(req.params.id)
  res.json({ ok: true })
})

export default router
