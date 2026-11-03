import { useCallback, useEffect, useRef, useState } from 'react'
import { cut } from '../api.js'
import EpisodeFrames from './EpisodeFrames.jsx'

/**
 * Cut frames tab: removes the first frames (3) of every video in a folder, saved over the original file, before
 * converting. Runs on the server one folder at a time (keeps going if this page is closed); pauses on the first error.
 * Files already cut are remembered, so nothing is ever cut twice.
 */
export default function CutFramesPanel({ active }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(null) // folder whose episodes and frames are shown (only that folder is listed)
  const backTo = useRef(null) // folder to scroll back to after "Back"
  const topRef = useRef(null)

  function openFolder(name) {
    setOpen(name)
    requestAnimationFrame(() => topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }

  function back() {
    backTo.current = open
    setOpen(null)
  }

  // After "Back", bring the folder that was open into view in the full list
  useEffect(() => {
    if (open || !backTo.current) return
    const name = backTo.current
    backTo.current = null
    requestAnimationFrame(() =>
      document.querySelector(`[data-cut-folder="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'center' }),
    )
  }, [open])

  const load = useCallback(async () => {
    try {
      setData(await cut.get())
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  const working = Boolean(data?.running) || (data?.queue.length > 0 && !data?.paused)
  useEffect(() => {
    if (!active) return
    load()
    const timer = setInterval(load, working ? 1500 : 5000)
    return () => clearInterval(timer)
  }, [active, working, load])

  async function act(fn) {
    setBusy(true)
    setError(null)
    try {
      setData(await fn())
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const frames = data?.frames ?? 3
  const stateOf = (name) => data?.folders.find((f) => f.folder === name)
  const failed = data?.folders.filter((f) => f.status === 'failed') || []
  const remaining = data?.sources.filter((s) => s.framesCut < s.videos) || []

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <p className="eyebrow">Before converting</p>
          <h2>✂️ Cut the first {frames} frames</h2>
          <p className="muted small">
            Removes the first {frames} frames of every video (the audio is trimmed to match) and saves it over the
            original file. Files already cut are remembered and never cut twice. Runs on the server one folder at a
            time and stops on the first error.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={load} disabled={busy}>
            ↻ Refresh
          </button>
          {(data?.running || data?.queue.length > 0) && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                const n = (data.running ? 1 : 0) + data.queue.length
                if (window.confirm(`Stop cutting and cancel all ${n} ${n === 1 ? 'folder' : 'folders'}? Files already cut stay cut.`)) {
                  act(cut.cancelAll)
                }
              }}
            >
              Cancel all ({(data.running ? 1 : 0) + data.queue.length})
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || remaining.length === 0}
            onClick={() => act(cut.all)}
          >
            Cut all ({remaining.length})
          </button>
        </div>
      </div>

      {error && <p className="banner error">{error}</p>}

      {data?.paused &&
        failed.map((f) => (
          <div key={f.folder} className="banner error" role="alert">
            <div>
              <strong>Paused on "{f.folder}":</strong>
              <ul className="small">
                {f.errors.map((e, i) => (
                  <li key={i}>
                    {e.file && <code>{e.file}</code>} {e.file && '— '}
                    {e.error}
                  </li>
                ))}
              </ul>
              <span className="muted small">The original file was not changed.</span>
              <div className="actions" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(cut.resume)}>
                  Retry
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => act(() => cut.cancel(f.folder))}
                >
                  Skip this folder
                </button>
              </div>
            </div>
          </div>
        ))}

      {data && data.sources.length === 0 && (
        <p className="muted">No folders with videos and a drama.json. Use the Move tab first.</p>
      )}

      {data && data.sources.length > 0 && (
        <>
        {open && (
          <div className="detail-bar" ref={topRef}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={back}>
              ← Back to all folders
            </button>
            <span className="muted small">3rd and 4th frame of every episode</span>
          </div>
        )}
        <ul className="rows bordered">
          {data.sources.filter((src) => !open || src.name === open).map((src) => {
            const st = stateOf(src.name)
            const isRunning = data.running === src.name
            const isQueued = data.queue.includes(src.name)
            const allCut = src.framesCut >= src.videos
            const chip = isRunning
              ? { tone: 'active', text: 'Cutting…' }
              : isQueued
                ? { tone: 'idle', text: data.paused ? 'Queued (paused)' : 'Queued' }
                : st?.status === 'failed'
                  ? { tone: 'error', text: 'Error' }
                  : allCut
                    ? { tone: 'done', text: 'Cut' }
                    : src.framesCut > 0
                      ? { tone: 'idle', text: 'Partly cut' }
                      : { tone: 'idle', text: 'Not cut' }
            return (
              <li key={src.name} className="cut-item" data-cut-folder={src.name}>
                <div className="row job-row">
                <button
                  type="button"
                  className="row-main row-toggle"
                  aria-expanded={open === src.name}
                  onClick={() => (open === src.name ? back() : openFolder(src.name))}
                  title="Show every episode's 3rd and 4th frame"
                >
                  <div className="row-top">
                    <span className="name" title={src.name}>
                      {open === src.name ? '▾' : '▸'} 📁 {src.name}
                    </span>
                    <span className={`chip ${chip.tone}`}>{chip.text}</span>
                  </div>
                  <span className="muted small">
                    {isRunning && st?.total
                      ? `${st.done}/${st.total} cut · now ${st.current || '…'} ${Math.round((st.progress || 0) * 100)}%`
                      : `${src.framesCut}/${src.videos} videos cut`}
                    {src.converted && <span className="warn-text"> · already converted (convert again to use the cut videos)</span>}
                  </span>
                </button>
                {isRunning || isQueued ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => act(() => cut.cancel(src.name))}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy || allCut}
                    onClick={() => act(() => cut.folder(src.name))}
                  >
                    {allCut ? 'Done' : src.framesCut > 0 ? 'Cut the rest' : `Cut ${frames} frames`}
                  </button>
                )}
                </div>
                {open === src.name && (
                  // Reloads as files get cut, so the frames show the new start of each video
                  <EpisodeFrames folder={src.name} version={`${src.framesCut}|${isRunning ? st?.done : ''}`} />
                )}
              </li>
            )
          })}
        </ul>
        {open && (
          <div className="detail-bar">
            <button type="button" className="btn btn-ghost btn-sm" onClick={back}>
              ← Back to all folders
            </button>
          </div>
        )}
        </>
      )}
    </section>
  )
}
