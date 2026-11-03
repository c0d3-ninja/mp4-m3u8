import express, { Router } from 'express'
import {
  cleanKey,
  cleanPrefix,
  connectionFromRequest,
  listExisting,
  listSeries,
  putObject,
  testConnection,
} from '../services/r2.js'
import { HttpError } from '../services/jobs.js'

// Credentials come from the browser (saved in its localStorage) as X-R2-* headers
// on every request; the server never stores them.
const router = Router()
const json = express.json({ limit: '1mb' })

router.post('/test', json, async (req, res) => {
  const connection = connectionFromRequest(req)
  await testConnection(connection)
  res.json({ ok: true, bucket: connection.bucket })
})

router.get('/series', async (req, res) => {
  const connection = connectionFromRequest(req)
  res.json({ series: await listSeries(connection) })
})

// Objects already under a prefix: { "Episode 1/master.m3u8": 512, ... }
router.get('/existing', async (req, res) => {
  const connection = connectionFromRequest(req)
  const prefix = cleanPrefix(req.query.prefix)
  res.json({ prefix, objects: await listExisting(connection, prefix) })
})

// Upload one object. Body = raw file bytes, key in ?key=
router.put('/object', async (req, res) => {
  const connection = connectionFromRequest(req)
  const key = cleanKey(String(req.query.key || ''))
  const size = Number(req.get('content-length'))
  if (!Number.isFinite(size) || size < 0) {
    throw new HttpError(411, 'Content-Length header is required')
  }

  // Stop the R2 upload if the browser goes away mid-request
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) controller.abort()
  })

  await putObject(connection, key, req, size, { signal: controller.signal })
  res.json({ ok: true, key, size })
})

export default router
