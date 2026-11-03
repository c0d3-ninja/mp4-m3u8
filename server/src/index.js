import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import healthRouter from './routes/health.js'
import jobsRouter from './routes/jobs.js'
import r2Router from './routes/r2.js'
import foldersRouter from './routes/folders.js'
import moveRouter from './routes/move.js'
import libraryRouter from './routes/library.js'
import autoRouter from './routes/auto.js'
import cutRouter from './routes/cut.js'
import { getJob, prepareStorage } from './services/jobs.js'
import { describeCpuLimit } from './services/cpu.js'

await prepareStorage()

const app = express()

app.use(cors({ origin: config.clientOrigin }))

// Mounted before the global JSON parser: object uploads stream the raw request body
app.use('/api/r2', r2Router)

app.use(express.json({ limit: '5mb' }))

// Converted HLS output of a job, used by the in-app preview player: /hls/<jobId>/EP01/master.m3u8
// Only a job's own output folder is served, never the rest of the downloads folder.
const hlsOptions = {
  fallthrough: false, // a missing file is a 404, never the client app below
  setHeaders(res, filePath) {
    if (filePath.endsWith('.m3u8')) res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    if (filePath.endsWith('.ts')) res.setHeader('Content-Type', 'video/mp2t')
    res.setHeader('Cache-Control', 'no-store')
  },
}
app.use('/hls/:id', (req, res, next) => {
  const job = getJob(req.params.id)
  if (!job) return res.status(404).end()
  // One handler per job instead of a new one on every segment request
  job.serveHls ??= express.static(job.workDir, hlsOptions)
  // Errors from serve-static contain the absolute file path; don't send that to the browser
  job.serveHls(req, res, (err) => (err ? res.status(err.status || 500).json({ error: 'Not found' }) : next()))
})

app.use('/api/health', healthRouter)
app.use('/api/jobs', jobsRouter)
app.use('/api/folders', foldersRouter)
app.use('/api/move', moveRouter)
app.use('/api/library', libraryRouter)
app.use('/api/auto', autoRouter)
app.use('/api/cut', cutRouter)

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Production: serve the built client (npm run build) from this server, so the Linux box only runs one process.
// In development the Vite dev server on :5173 serves the client and proxies /api and /hls here.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist')
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  // Vite puts content-hashed files in /assets, so they can be cached forever
  app.use('/assets', express.static(path.join(clientDist, 'assets'), { immutable: true, maxAge: '1y' }))
  app.use(express.static(clientDist, { index: 'index.html', maxAge: 0 }))
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(clientDist, 'index.html')))
  console.log(`Serving the client from ${clientDist}`)
}

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500
  if (status >= 500) console.error(err)
  if (res.headersSent) return next(err)
  res.status(status).json({ error: err.message || 'Internal Server Error' })
})

const server = app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`)
  console.log(`Converted series go to ${config.convertedDir}/<drama id>/`)
  console.log(describeCpuLimit())
  console.log(`Transcoding with ${config.ffmpegPath} (preset ${config.ffmpegPreset}, ${config.concurrency} at a time)`)
})

// Large episode uploads can take a while; don't cut them off.
server.requestTimeout = 0
