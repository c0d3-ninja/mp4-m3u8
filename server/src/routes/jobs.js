import fs from 'node:fs/promises'
import { Router } from 'express'
import multer from 'multer'
import {
  HttpError,
  createJob,
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

// Create a job: { folderName, files: [{ relativePath, size }] }
router.post('/', (req, res) => {
  const job = createJob(req.body)
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

// All uploads sent; convert what arrived and zip when done
router.post('/:id/finalize', loadJob, (req, res) => {
  finalizeUploads(req.job)
  res.json(toPublic(req.job))
})

router.get('/:id/download', loadJob, (req, res, next) => {
  const { job } = req
  if (job.status !== 'done') return next(new HttpError(409, 'Zip is not ready yet'))
  res.download(job.zipPath, `${job.folderName}.zip`, (err) => {
    if (err && !res.headersSent) next(err)
  })
})

// Cancel a running job, or clean up a finished one
router.delete('/:id', loadJob, async (req, res) => {
  await removeJob(req.job)
  res.json({ ok: true })
})

export default router
