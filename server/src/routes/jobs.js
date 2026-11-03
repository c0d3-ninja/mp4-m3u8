import fs from 'node:fs/promises'
import { Router } from 'express'
import multer from 'multer'
import { cleanPrefix, connectionFromRequest, uploadDirectory } from '../services/r2.js'
import {
  HttpError,
  cancelR2Upload,
  startR2Upload,
  createJob,
  writeDramaInfo,
  finalizeUploads,
  getJob,
  markUploaded,
  removeJob,
  toPublic,
} from '../services/jobs.js'

const router = Router()

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      fs.mkdir(req.job.uploadDir, { recursive: true }).then(() => cb(null, req.job.uploadDir), cb)
    },
    filename(req, file, cb) {
      cb(null, `${req.jobFile.id}${req.jobFile.ext}`)
    },
  }),
  limits: { files: 1 },
})

function loadJob(req, res, next) {
  const job = getJob(req.params.id)
  if (!job) return next(new HttpError(404, 'Job not found'))
  req.job = job
  next()
}

// Create a job: { folderName, drama?: { dramaName, imageUrl, category }, files: [{ relativePath, size }] }
router.post('/', async (req, res) => {
  const job = createJob(req.body)
  try {
    await writeDramaInfo(job)
  } catch (err) {
    await removeJob(job)
    throw new HttpError(500, `Could not create the output folder: ${err.message}`)
  }
  res.status(201).json(toPublic(job))
})

router.get('/:id', loadJob, (req, res) => {
  res.json(toPublic(req.job))
})

// Upload one episode (multipart field "file")
router.post('/:id/files/:fileId', loadJob, (req, res, next) => {
  const { job } = req
  const file = job.files.find((f) => f.id === req.params.fileId)
  if (!file) return next(new HttpError(404, 'File not found in job'))
  if (job.cancelled) return next(new HttpError(409, 'Job was cancelled'))
  if (job.uploadsComplete) return next(new HttpError(409, 'Uploads are already finished for this job'))
  if (file.status !== 'pending') return next(new HttpError(409, `File is already ${file.status}`))

  req.jobFile = file
  file.status = 'uploading'

  upload.single('file')(req, res, async (err) => {
    const fail = async (error) => {
      if (file.status === 'uploading') file.status = 'pending'
      if (req.file?.path) await fs.rm(req.file.path, { force: true }).catch(() => {})
      next(error)
    }

    if (err) return fail(new HttpError(400, `Upload failed: ${err.message}`))
    if (!req.file) return fail(new HttpError(400, 'No file received (expected field "file")'))
    if (job.cancelled) return fail(new HttpError(409, 'Job was cancelled'))

    markUploaded(job, file, req.file.path)
    res.json({ ok: true })
  })
})

// All uploads sent; convert what arrived, then write manifest.json
router.post('/:id/finalize', loadJob, (req, res) => {
  finalizeUploads(req.job)
  res.json(toPublic(req.job))
})

// Upload the converted series to Cloudflare R2 (credentials in X-R2-* headers)
router.post('/:id/r2', loadJob, (req, res) => {
  const connection = connectionFromRequest(req)
  const prefix = cleanPrefix(req.body?.prefix)
  startR2Upload(req.job, connection, prefix, uploadDirectory, { skipExisting: req.body?.skipExisting !== false })
  res.json(toPublic(req.job))
})

router.delete('/:id/r2', loadJob, (req, res) => {
  cancelR2Upload(req.job)
  res.json(toPublic(req.job))
})

// Cancel a running job, or clean up a finished one
router.delete('/:id', loadJob, async (req, res) => {
  await removeJob(req.job)
  res.json({ ok: true })
})

export default router
