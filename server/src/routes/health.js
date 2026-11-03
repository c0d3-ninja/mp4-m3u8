import { Router } from 'express'
import { availableEncoders } from '../services/transcoder.js'

const router = Router()

router.get('/', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// Which encoders this server can use: { hardware (Apple), nvenc (NVIDIA), nvencGpu, software }
router.get('/encoders', (req, res) => {
  res.json({ ...availableEncoders(), software: true })
})

export default router
