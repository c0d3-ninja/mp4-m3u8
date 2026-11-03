import { Router } from 'express'
import { getAutoState, skipFolder, startAuto, stopAuto } from '../services/autoConvert.js'

// Auto convert: convert every folder with a drama.json, one after another; pause on the first error.
const router = Router()

router.get('/', (req, res) => res.json(getAutoState()))
router.post('/start', (req, res) => res.json(startAuto())) // also "Retry" after a pause
router.post('/stop', (req, res) => res.json(stopAuto()))
router.post('/skip', (req, res) => res.json(skipFolder(req.body?.folder)))

export default router
