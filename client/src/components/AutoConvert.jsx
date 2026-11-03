import { useCallback, useEffect, useRef, useState } from 'react'
import { auto } from '../api.js'

const STATUS = {
  off: { tone: 'idle', text: 'Off' },
  running: { tone: 'active', text: 'Running' },
  paused: { tone: 'error', text: 'Paused — error' },
}

/**
 * Convert tab: converts every folder with a drama.json, one after another, on the server (it keeps going when this
 * page is closed), only when all its episodes are there. Pauses on the first error or incomplete folder and shows it;
 * nothing continues until Retry / Skip.
 */
export default function AutoConvert({ active, onOpenJob, onProgress }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const lastDone = useRef(null)

  const apply = useCallback(
    (next) => {
      setState(next)
      // A folder finished (or a new one started): let the folder list refresh its labels
      const key = `${next.completed.length}|${next.current?.jobId || ''}|${next.status}`
      if (lastDone.current !== null && lastDone.current !== key) onProgress?.()
      lastDone.current = key
    },
    [onProgress],
  )

  const load = useCallback(async () => {
    try {
      apply(await auto.get())
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [apply])

  // Poll while the Convert tab is shown; faster while it is running
  const running = state?.status === 'running'
  useEffect(() => {
    if (!active) return
    load()
    const timer = setInterval(load, running ? 2000 : 5000)
    return () => clearInterval(timer)
  }, [active, running, load])

  async function act(fn) {
    setBusy(true)
    setError(null)
    try {
      apply(await fn())
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!state) return error ? <p className="banner error">{error}</p> : null

  const label = STATUS[state.status] || STATUS.off
  const cur = state.current

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <p className="eyebrow">On the server</p>
          <h2>
            ⚡ Auto convert <span className={`chip ${label.tone}`}>{label.text}</span>
          </h2>
          <p className="muted small">
            Converts every folder with a <strong>drama.json</strong>, one after another, in the order below — only when
            all its episodes are there (as many videos as <code>totalEpisodes</code>) and their first frames are cut.
            Stops on the first error, incomplete or uncut folder. Keeps going if you leave this page.
          </p>
        </div>
        <div className="actions">
          {state.status === 'running' ? (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act(auto.stop)}>
              Stop
            </button>
          ) : state.status === 'paused' ? (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act(auto.stop)}>
                Turn off
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(auto.start)}>
                Retry
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(auto.start)}>
              Start auto convert
            </button>
          )}
        </div>
      </div>

      {error && <p className="banner error">{error}</p>}

      {cur && (
        <div className="banner info">
          <span>
            {state.status === 'running' ? 'Converting' : 'Still converting'} <strong>{cur.folder}</strong> ·{' '}
            {cur.done}/{cur.total} episodes
            {cur.failed > 0 && <span className="warn-text"> · {cur.failed} failed</span>}
            {cur.converting.length > 0 && <span className="muted"> · now: {cur.converting.join(', ')}</span>}
          </span>
          <button type="button" className="link" onClick={() => onOpenJob(cur.jobId)}>
            Open
          </button>
        </div>
      )}

      {state.status === 'paused' &&
        state.errors.map((err, i) => (
          <div key={i} className="banner error" role="alert">
            <div>
              <strong>Paused{err.folder ? ` on "${err.folder}"` : ''}:</strong> {err.message}
              {err.files.length > 0 && (
                <ul className="small">
                  {err.files.map((f) => (
                    <li key={f.source}>
                      <code>{f.source}</code> — {f.error}
                    </li>
                  ))}
                </ul>
              )}
              <div className="actions" style={{ marginTop: 8 }}>
                {err.jobId && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenJob(err.jobId)}>
                    Open conversion
                  </button>
                )}
                {err.folder && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => act(() => auto.skip(err.folder))}
                  >
                    Skip this folder
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}

      {state.message && state.status === 'off' && <p className="banner success">{state.message}</p>}

      {state.completed.length > 0 && (
        <p className="muted small">
          Converted this run: {state.completed.map((c) => `${c.folder} (${c.episodes})`).join(' · ')}
        </p>
      )}
      {state.skipped.length > 0 && <p className="muted small">Skipped: {state.skipped.join(' · ')}</p>}
    </section>
  )
}
