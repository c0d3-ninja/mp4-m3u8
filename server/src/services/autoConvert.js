import { HttpError, getJob, toPublic } from './jobs.js'
import { convertFolder, scanLibrary } from './library.js'
import { formatGapList } from './episodes.js'
import { resolveEncoder } from './transcoder.js'

// Auto convert: converts the Convert tab's folders (those with a drama.json) one after another, only when every
// episode is there (video count = drama.json's totalEpisodes), on the server, so it
// keeps going when the page is closed. On any error it pauses with the errors and does not continue until told to.
// State is in memory only: a server restart turns it off (a conversion that was running shows as "Interrupted").

const POLL_MS = 2000
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const state = {
  status: 'off', // off | running | paused
  current: null, // { folder, jobId, startedAt }
  errors: [], // [{ folder, message, files: [{ source, error }], kind: 'gaps' | 'job' | 'start' | 'scan' }]
  completed: [], // [{ folder, jobId, episodes, at }]
  skipped: new Set(), // folders the user chose to skip
  message: null, // e.g. "All folders are converted"
  retry: null, // folder to convert again first on Retry (its last conversion had errors)
  encoder: null, // 'hardware' | 'nvenc' | 'software', set by Start / Retry; every folder of the run uses it
  parallel: null, // episodes at once (software), set the same way
}

let loop = null // the running loop's promise, so only one runs

const isConverted = (src) => src.conversions.some((c) => ['done', 'converting'].includes(c.status))

/** Folders auto mode would still convert, in the Convert tab's order. */
function pending(sources) {
  return sources
    .filter((s) => s.hasDrama && !isConverted(s) && !state.skipped.has(s.name))
    .sort((a, b) => collator.compare(a.name, b.name))
}

function pause(error) {
  state.errors.push({ files: [], ...error })
  if (error.folder && error.kind === 'job') state.retry = error.folder
  state.status = 'paused'
  console.error(`[auto convert] paused: ${error.folder ? `${error.folder}: ` : ''}${error.message}`)
}

/** Wait for the current job to end. Returns true when it finished without any error. */
async function waitForCurrent() {
  const { folder, jobId } = state.current
  for (;;) {
    const job = getJob(jobId)
    if (!job) {
      state.current = null
      pause({ folder, kind: 'job', message: 'The conversion job disappeared (was it cancelled or removed?)' })
      return false
    }
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      const pub = toPublic(job)
      const failedFiles = pub.files
        .filter((f) => f.status === 'error')
        .map((f) => ({ source: f.relativePath, error: f.error || 'Conversion failed' }))
      state.current = null
      if (job.status !== 'done' || failedFiles.length > 0) {
        const message =
          job.status === 'cancelled'
            ? 'The conversion was cancelled'
            : job.error || `${failedFiles.length} of ${pub.files.length} episodes could not be converted`
        pause({ folder, kind: 'job', jobId, message, files: failedFiles })
        return false
      }
      state.completed.push({
        folder,
        jobId,
        episodes: pub.files.filter((f) => f.status === 'done').length,
        at: new Date().toISOString(),
      })
      return true
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
    // Stopped: leave `current` as is; Start picks it up again
    if (state.status !== 'running' || state.current?.jobId !== jobId) return false
  }
}

async function run() {
  while (state.status === 'running') {
    if (state.current) {
      if (!(await waitForCurrent())) return
      continue
    }

    let next
    try {
      const sources = (await scanLibrary()).sources
      // Retry after a failed/partial conversion: that folder again first, even though it now counts as converted
      next = (state.retry && sources.find((s) => s.name === state.retry && !state.skipped.has(s.name))) || pending(sources)[0]
      state.retry = null
    } catch (err) {
      pause({ kind: 'scan', message: `Could not read the downloads folder: ${err.message}` })
      return
    }
    if (!next) {
      state.status = 'off'
      state.message = state.completed.length
        ? `Done — every folder with a drama.json is converted (${state.completed.length} this run).`
        : 'Nothing to convert — every folder with a drama.json is already converted.'
      return
    }

    // Only a complete series is converted: as many videos as drama.json's totalEpisodes, none missing
    if (!next.complete) {
      const why =
        next.totalEpisodes === null
          ? `drama.json has no totalEpisodes, so it can't be checked that every episode is there (${next.videos} videos)`
          : next.videos !== next.totalEpisodes
            ? `Has ${next.videos} of ${next.totalEpisodes} episodes`
            : `Has ${next.videos} videos, but the episode numbers don't run 1–${next.totalEpisodes}`
      const gaps = next.gaps.length ? ` · missing ${formatGapList(next.gaps)}` : ''
      pause({ folder: next.name, kind: 'incomplete', message: why + gaps })
      return
    }

    try {
      const job = await convertFolder(next.name, undefined, state.encoder, state.parallel)
      state.current = { folder: next.name, jobId: job.id, startedAt: new Date().toISOString() }
      console.log(`[auto convert] converting "${next.name}" (${job.files.length} episodes)`)
    } catch (err) {
      pause({ folder: next.name, kind: 'start', message: err.message })
      return
    }
  }
}

function ensureLoop() {
  if (loop) return
  loop = run()
    .catch((err) => pause({ kind: 'scan', message: err.message }))
    .finally(() => {
      loop = null
      // "Stop" while a folder was converting: keep watching it so a later Start knows where it left off
      if (state.status === 'running') ensureLoop()
    })
}

/** Start, or resume after a pause (errors are cleared; the failed folder is tried again unless skipped). */
export function startAuto(encoder, parallel) {
  if (state.status === 'running') return getAutoState()
  // Start / Retry is the "convert" click: its encoder choice is used for the rest of the run. Skip keeps the last one.
  if (encoder !== undefined) state.encoder = resolveEncoder(encoder)
  if (parallel !== undefined) state.parallel = parallel
  state.errors = []
  state.message = null
  if (state.status === 'off') {
    state.completed = []
    state.retry = null
    // Stopped earlier while a folder was converting, and that job is gone now: it is no longer ours to watch
    if (state.current && !getJob(state.current.jobId)) state.current = null
  }
  state.status = 'running'
  ensureLoop()
  return getAutoState()
}

/** Stop picking new folders. A folder that is converting right now finishes on its own. */
export function stopAuto() {
  state.status = 'off'
  state.message = state.current ? `Stopped. "${state.current.folder}" keeps converting until it finishes.` : 'Stopped.'
  return getAutoState()
}

/** Paused on a folder: skip it for this server session and continue with the next one. */
export function skipFolder(folder) {
  if (!folder) throw new HttpError(400, 'folder is required')
  state.skipped.add(String(folder))
  return startAuto()
}

export function getAutoState() {
  let current = null
  if (state.current) {
    const job = getJob(state.current.jobId)
    const files = job ? job.files : []
    current = {
      ...state.current,
      total: files.length,
      done: files.filter((f) => f.status === 'done').length,
      failed: files.filter((f) => f.status === 'error').length,
      converting: files.filter((f) => f.status === 'converting').map((f) => f.relativePath),
    }
  }
  return {
    status: state.status,
    encoder: state.encoder,
    parallel: state.parallel,
    current,
    errors: state.errors,
    completed: state.completed,
    skipped: [...state.skipped],
    message: state.message,
  }
}
