import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import healthRouter from './routes/health.js'
import jobsRouter from './routes/jobs.js'
import { prepareStorage } from './services/jobs.js'

await prepareStorage()

const app = express()

app.use(cors({ origin: config.clientOrigin }))
app.use(express.json({ limit: '5mb' }))

// Converted HLS output, used by the in-app preview player
app.use(
  '/hls',
  express.static(config.hlsDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.m3u8')) res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      if (filePath.endsWith('.ts')) res.setHeader('Content-Type', 'video/mp2t')
      res.setHeader('Cache-Control', 'no-store')
    },
  }),
)

app.use('/api/health', healthRouter)
app.use('/api/jobs', jobsRouter)

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' })
})

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500
  if (status >= 500) console.error(err)
  if (res.headersSent) return next(err)
  res.status(status).json({ error: err.message || 'Internal Server Error' })
})

const server = app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`)
  console.log(`Transcoding with ${config.ffmpegPath} (preset ${config.ffmpegPreset}, ${config.concurrency} at a time)`)
})

// Large episode uploads can take a while; don't cut them off.
server.requestTimeout = 0
