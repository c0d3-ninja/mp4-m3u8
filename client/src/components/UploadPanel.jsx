import { useCallback, useEffect, useRef, useState } from 'react'
import { r2 } from '../api.js'
import {
  cleanPrefix,
  formatBytes,
  isR2Configured,
  percent,
  publicObjectUrl,
  readUploadFolder,
  uploadRank,
} from '../utils.js'
import FolderPicker from './FolderPicker.jsx'

const CONCURRENCY = 6
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.ceil(seconds)}s left`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m ${Math.round(seconds % 60)}s left` : `${Math.floor(m / 60)}h ${m % 60}m left`
}

export default function UploadPanel({ settings, onPreview }) {
  const configured = isR2Configured(settings)
  const [folder, setFolder] = useState(null) // result of readUploadFolder
  const [prefix, setPrefix] = useState('')
  const [skipExisting, setSkipExisting] = useState(true)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const [episodes, setEpisodes] = useState(null) // from manifest.json after upload
  const [series, setSeries] = useState(null)
  const [seriesError, setSeriesError] = useState(null)
  const abortRef = useRef(null)
  const running = progress?.status === 'uploading' || progress?.status === 'checking'

  const loadSeries = useCallback(async () => {
    if (!isR2Configured(settings)) return
    setSeriesError(null)
    try {
      const data = await r2.series(settings)
      setSeries(data.series)
    } catch (e) {
      setSeries(null)
      setSeriesError(e.message)
    }
  }, [settings])

  useEffect(() => {
    loadSeries()
  }, [loadSeries])

  // Warn before closing the tab mid-upload
  useEffect(() => {
    if (!running) return
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [running])

  function handleFolder(fileList) {
    setError(null)
    setProgress(null)
    setEpisodes(null)
    const result = readUploadFolder(fileList)
    if (!result || result.files.length === 0) {
      setFolder(null)
      setError('That folder is empty.')
      return
    }
    setFolder(result)
    setPrefix(result.folderName)
  }

  /** Upload `files` (all, or just previously failed ones). */
  async function upload(files) {
    const dest = cleanPrefix(prefix)
    if (!dest) {
      setError('Enter the destination folder in the bucket.')
      return
    }
    if (
      folder.episodes === 0 &&
      !window.confirm(
        'This folder has no master.m3u8 files, so it does not look like a converted series. Upload anyway?',
      )
    ) {
      return
    }
    setError(null)
    setEpisodes(null)

    const controller = new AbortController()
    abortRef.current = controller
    const signal = controller.signal

    const state = {
      status: 'checking',
      prefix: dest,
      total: files.length,
      done: 0,
      skipped: 0,
      failedFiles: [],
      errors: [],
      fatal: null,
      totalBytes: files.reduce((s, f) => s + f.size, 0),
      bytesDone: 0,
      inFlight: new Map(),
      startedAt: Date.now(),
      speed: 0,
    }
    const snapshot = () => {
      const inflight = [...state.inFlight.values()].reduce((s, v) => s + v, 0)
      setProgress({
        ...state,
        inFlight: undefined,
        failedFiles: [...state.failedFiles],
        errors: [...state.errors],
        sentBytes: state.bytesDone + inflight,
      })
    }
    snapshot()

    // Resume support: skip files already in the bucket with the same size
    let existing = {}
    if (skipExisting) {
      try {
        existing = (await r2.existing(settings, dest)).objects
      } catch (e) {
        setProgress(null)
        setError(e.message)
        abortRef.current = null
        return
      }
    }

    state.status = 'uploading'
    let lastBytes = 0
    let lastTime = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      const sent = state.bytesDone + [...state.inFlight.values()].reduce((s, v) => s + v, 0)
      const instant = ((sent - lastBytes) * 1000) / Math.max(1, now - lastTime)
      state.speed = state.speed ? state.speed * 0.7 + instant * 0.3 : instant
      lastBytes = sent
      lastTime = now
      snapshot()
    }, 500)

    async function uploadOne(item) {
      if (existing[item.relativePath] === item.size) {
        state.skipped++
        state.done++
        state.bytesDone += item.size
        return
      }
      let lastError
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (signal.aborted) return
        try {
          await r2.putObject(settings, `${dest}/${item.relativePath}`, item.file, {
            signal,
            onProgress: (loaded) => state.inFlight.set(item.relativePath, loaded),
          })
          lastError = null
          break
        } catch (e) {
          lastError = e
          if (e.name === 'AbortError' || [0, 400, 401, 403, 404].includes(e.status)) break
          await sleep(700 * attempt)
        } finally {
          state.inFlight.delete(item.relativePath)
        }
      }
      if (signal.aborted) return
      if (lastError) {
        state.failedFiles.push(item)
        if (state.errors.length < 10) state.errors.push(`${item.relativePath}: ${lastError.message}`)
        if ([0, 401, 403, 404].includes(lastError.status)) state.fatal = lastError.message
      } else {
        state.done++
        state.bytesDone += item.size
      }
    }

    // Segments → master playlists → manifest.json, each phase only after the previous one fully succeeded
    for (const rank of [0, 1, 2]) {
      const queue = files.filter((f) => uploadRank(f.relativePath) === rank)
      let next = 0 // index instead of queue.shift(), which is O(n) per call on big series
      const worker = async () => {
        while (next < queue.length && !signal.aborted && !state.fatal) await uploadOne(queue[next++])
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
      if (signal.aborted || state.fatal || state.failedFiles.length > 0) break
    }

    clearInterval(timer)
    abortRef.current = null

    if (signal.aborted) state.status = 'cancelled'
    else if (state.fatal || state.failedFiles.length > 0) {
      state.status = 'failed'
    } else state.status = 'done'
    snapshot()

    if (state.status === 'done') {
      loadSeries()
      const manifest = folder.files.find((f) => f.relativePath === 'manifest.json')
      if (manifest) {
        try {
          const data = JSON.parse(await manifest.file.text())
          setEpisodes(Array.isArray(data.episodes) ? data.episodes : [])
        } catch {
          setEpisodes([])
        }
      }
    }
  }

  function cancel() {
    abortRef.current?.abort()
  }

  function retryFailed() {
    // Re-run everything with "skip existing" on: finished files are skipped, the rest are retried
    setSkipExisting(true)
    upload(folder.files)
  }

  const dest = cleanPrefix(prefix)
  const manifestUrl = dest ? publicObjectUrl(settings, dest, 'manifest.json') : ''

  if (!configured) {
    return (
      <section className="card empty">
        <div className="empty-icon">☁️</div>
        <h2>Connect Cloudflare first</h2>
        <p className="muted">Add your R2 keys above, then pick a converted series folder to upload.</p>
      </section>
    )
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div>
            <p className="eyebrow">Upload a converted series</p>
            <h2>{folder ? `📁 ${folder.folderName}` : 'Choose a converted series folder'}</h2>
            {folder ? (
              <p className="muted">
                {folder.files.length} files · {formatBytes(folder.totalBytes)} · {folder.episodes} episodes
                {!folder.hasManifest && <span className="warn-text"> · no manifest.json</span>}
              </p>
            ) : (
              <p className="muted">
                Choose a <strong>My Drama</strong> folder (the one with <strong>manifest.json</strong>) from this
                computer. To upload a series converted on the server, use the Upload box after converting.
              </p>
            )}
          </div>
          <div className="actions">
            <FolderPicker onSelect={handleFolder} className={folder ? 'btn btn-ghost' : 'btn btn-primary btn-lg'}>
              {folder ? 'Change folder' : 'Choose folder'}
            </FolderPicker>
          </div>
        </div>

        {error && <p className="banner error">{error}</p>}

        {folder && folder.episodes === 0 && (
          <p className="banner warn">
            No master.m3u8 files found. Pick a converted series folder (it contains manifest.json and one folder
            per episode), not the original MP4 folder.
          </p>
        )}

        {folder && (
          <div className="form">
            <label className="field">
              <span>Destination folder in bucket</span>
              <div className="input-prefix">
                <span className="muted">{settings.bucket}/</span>
                <input
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  disabled={running}
                  spellCheck={false}
                />
              </div>
              {series?.includes(dest) && progress?.status !== 'done' && (
                <small className="warn-text">
                  "{dest}" already exists in the bucket. Files with the same name will be replaced
                  {skipExisting ? ' (unchanged files are skipped)' : ''}.
                </small>
              )}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={skipExisting}
                onChange={(e) => setSkipExisting(e.target.checked)}
                disabled={running}
              />
              <span>Skip files already uploaded (same name and size) — lets you resume an interrupted upload</span>
            </label>
          </div>
        )}

        {progress && <UploadProgress progress={progress} />}

        {folder && (
          <div className="card-foot">
            <span className="muted small">
              Uploads go Mac → local server → Cloudflare. Keep this tab open until it finishes.
            </span>
            <div className="actions">
              {running ? (
                <button type="button" className="btn btn-ghost" onClick={cancel}>
                  Cancel upload
                </button>
              ) : progress?.status === 'failed' || progress?.status === 'cancelled' ? (
                <button type="button" className="btn btn-primary btn-lg" onClick={retryFailed}>
                  {progress.status === 'failed' ? 'Retry' : 'Resume upload'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  onClick={() => upload(folder.files)}
                  disabled={!dest || progress?.status === 'done'}
                >
                  {progress?.status === 'done' ? 'Uploaded ✓' : `Upload to ${settings.bucket}`}
                </button>
              )}
            </div>
          </div>
        )}

        {progress?.status === 'done' && (
          <div className="result">
            <p>
              ✅ <strong>{folder.folderName}</strong> is in{' '}
              <code>
                {settings.bucket}/{progress.prefix}/
              </code>
            </p>
            {manifestUrl ? (
              <CopyLink label="Series manifest (use in your app)" url={manifestUrl} />
            ) : (
              <p className="muted small">Add a Public URL in the settings above to get playable links.</p>
            )}
            {episodes && episodes.length > 0 && manifestUrl && (
              <ul className="rows bordered">
                {episodes.map((ep) => {
                  const url = publicObjectUrl(settings, progress.prefix, ep.playlist)
                  return (
                    <li key={ep.playlist} className="row">
                      <span className="num">{ep.number}</span>
                      <span className="name" title={url}>
                        {ep.title}
                      </span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(url)}>
                        Copy URL
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => onPreview({ title: ep.title, src: url, remote: true })}
                      >
                        ▶ Preview
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <p className="eyebrow">In bucket</p>
            <h2>{settings.bucket}</h2>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={loadSeries}>
            ↻ Refresh
          </button>
        </div>
        {seriesError && <p className="banner error">{seriesError}</p>}
        {series && series.length === 0 && <p className="muted">The bucket is empty.</p>}
        {series && series.length > 0 && (
          <ul className="rows bordered">
            {series.map((name) => {
              const url = publicObjectUrl(settings, name, 'manifest.json')
              return (
                <li key={name} className="row">
                  <span className="name">📁 {name}</span>
                  {url && (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(url)}>
                        Copy manifest URL
                      </button>
                      <a className="btn btn-ghost btn-sm" href={url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </>
  )
}

function UploadProgress({ progress: p }) {
  const fraction = p.totalBytes > 0 ? p.sentBytes / p.totalBytes : p.total > 0 ? p.done / p.total : 0
  const remaining = p.speed > 0 ? (p.totalBytes - p.sentBytes) / p.speed : NaN
  const label = {
    checking: 'Checking what is already in the bucket…',
    uploading: `Uploading… ${percent(fraction)}`,
    done: 'Upload complete',
    failed: 'Upload incomplete',
    cancelled: 'Upload cancelled',
  }[p.status]

  return (
    <div className="progress-box">
      <div className="row-top">
        <strong>{label}</strong>
        {p.status === 'uploading' && (
          <span className="muted small">
            {formatBytes(p.speed)}/s · {formatEta(remaining)}
          </span>
        )}
      </div>
      <div className="bar big">
        <div
          className={`fill ${p.status === 'failed' ? 'error' : p.status === 'done' ? 'ok' : ''}`}
          style={{ width: percent(p.status === 'done' ? 1 : fraction) }}
        />
      </div>
      <p className="muted small">
        {p.done} of {p.total} files
        {p.skipped > 0 && ` (${p.skipped} already there, skipped)`} · {formatBytes(p.sentBytes)} of{' '}
        {formatBytes(p.totalBytes)}
        {p.failedFiles.length > 0 && <span className="error-text"> · {p.failedFiles.length} failed</span>}
      </p>
      {p.fatal && <p className="banner error">{p.fatal}</p>}
      {!p.fatal && p.errors.length > 0 && (
        <ul className="error-list">
          {p.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {p.status === 'failed' && !p.fatal && (
        <p className="muted small">
          Playlists and manifest.json are only uploaded after every segment succeeds, so nothing broken is live. Click
          Retry to upload what's missing.
        </p>
      )}
    </div>
  )
}

function CopyLink({ label, url }) {
  return (
    <div className="copy-link">
      <span className="muted small">{label}</span>
      <div className="input-with-btn">
        <input readOnly value={url} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(url)}>
          Copy
        </button>
      </div>
    </div>
  )
}

function copy(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => window.prompt('Copy this URL:', text))
  } else {
    window.prompt('Copy this URL:', text)
  }
}
