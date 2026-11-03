import { Router } from 'express'
import { scanLibrary } from '../services/library.js'
import { cancelAllCut, cancelCut, getCutState, queueCut, queueCutMany, resumeCut } from '../services/cutFrames.js'
import { frameJpeg, listEpisodes } from '../services/framePreview.js'

// Cut frames tab: cut the first frames of every video in a folder (in place), before converting.
const router = Router()

/** The Convert tab's folders with how many videos are cut, plus the queue. */
async function full() {
  const { sources } = await scanLibrary()
  return {
    ...getCutState(),
    sources: sources.map((s) => ({
      name: s.name,
      videos: s.videos,
      framesCut: s.framesCut,
      totalEpisodes: s.totalEpisodes,
      complete: s.complete,
      converted: s.conversions.some((c) => c.status === 'done'),
    })),
  }
}

router.get('/', async (req, res) => res.json(await full()))
// A folder's episodes, and one frame of an episode as JPEG (?folder=&file=&n=<0-based frame>&w=<width>&v=<version>)
router.get('/episodes', async (req, res) => res.json({ episodes: await listEpisodes(req.query.folder) }))
router.get('/frame', async (req, res) => {
  const jpeg = await frameJpeg(req.query.folder, req.query.file, req.query.n, req.query.w)
  // The URL carries the file's version (modified time), so a cut file gets a new URL
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }).send(jpeg)
})
router.post('/', async (req, res) => {
  await queueCut(req.body?.folder)
  res.json(await full())
})
// Every folder that still has uncut videos
router.post('/all', async (req, res) => {
  const { sources } = await full()
  await queueCutMany(sources.filter((s) => s.framesCut < s.videos).map((s) => s.name))
  res.json(await full())
})
router.post('/resume', async (req, res) => {
  resumeCut()
  res.json(await full())
})
// Stop everything: the running folder and the whole queue
router.post('/cancel-all', async (req, res) => {
  cancelAllCut()
  res.json(await full())
})
router.delete('/', async (req, res) => {
  cancelCut(String(req.query.folder || ''))
  res.json(await full())
})

export default router
