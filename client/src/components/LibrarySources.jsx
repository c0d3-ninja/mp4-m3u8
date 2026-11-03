import { useCallback, useEffect, useState } from 'react'
import { library } from '../api.js'
import { formatBytes, formatGaps, gapCount, naturalCompare } from '../utils.js'

const formatDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : ''

/** Conversion label for a source folder, from the conversions made from it. */
function conversionLabel(conversions) {
  if (conversions.some((c) => c.status === 'converting')) return { tone: 'active', text: 'Converting…', busy: true }
  const done = conversions.filter((c) => c.status === 'done')
  if (done.length > 0) {
    const last = done.reduce((a, b) => ((a.completedAt || '') > (b.completedAt || '') ? a : b))
    return {
      tone: 'done',
      text: done.length > 1 ? `Converted ×${done.length}` : 'Converted',
      detail: `${last.episodes ?? '?'} ${last.episodes === 1 ? 'episode' : 'episodes'} · ${formatDate(last.completedAt)}`,
      converted: true,
    }
  }
  if (conversions.length > 0) return { tone: 'error', text: 'Interrupted' }
  return { tone: 'idle', text: 'Not converted' }
}

/** Convert tab: folders of videos in the server's downloads folder, converted in place on click. */
export default function LibrarySources({ active, onStarted, onOpenJob, encoder, parallel, refreshKey = 0 }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [starting, setStarting] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await library.list()
      next.sources.sort((a, b) => naturalCompare(a.name, b.name))
      setData(next)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Re-read whenever the Convert tab is shown, so labels are fresh after converting or moving files
  useEffect(() => {
    if (active) load()
  }, [active, load, refreshKey])

  async function convert(src, label) {
    if (
      src.gaps.length > 0 &&
      !window.confirm(
        `"${src.name}" is missing ${gapCount(src.gaps) === 1 ? 'episode' : 'episodes'} ${formatGaps(src.gaps)}. Convert the ${src.videos} it has anyway?`,
      )
    ) {
      return
    }
    if (
      src.framesCut < src.videos &&
      !window.confirm(
        `The first frames of ${src.videos - src.framesCut} of the ${src.videos} videos in "${src.name}" are not cut yet (Cut frames tab). Convert anyway?`,
      )
    ) {
      return
    }
    if (
      label.converted &&
      !window.confirm(`"${src.name}" was already converted. Convert it again into a new folder?`)
    ) {
      return
    }
    setStarting(src.name)
    setError(null)
    try {
      onStarted(await library.convert(src.name, undefined, encoder, parallel))
    } catch (e) {
      setError(e.message)
      load()
    } finally {
      setStarting(null)
    }
  }

  const rootName = data?.root?.split(/[\\/]/).filter(Boolean).pop() || 'Downloads'

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <p className="eyebrow">On the server</p>
          <h2>📂 {rootName} folders</h2>
          <p className="muted small">
            Converted straight from <strong>{data?.root || rootName}</strong>, nothing is uploaded from this browser.
            The original videos are kept.
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {error && <p className="banner error">{error}</p>}

      {data && data.sources.length === 0 && (
        <p className="muted">No folders with videos and a drama.json. Use the Move tab to put MP4s and the drama JSON into a folder.</p>
      )}

      {data && data.sources.length > 0 && (
        <ul className="rows bordered">
          {data.sources.map((src) => {
            const label = conversionLabel(src.conversions)
            return (
              <li key={src.name} className="row job-row">
                <div className="row-main">
                  <div className="row-top">
                    <span className="name" title={src.name}>
                      📁 {src.name}
                    </span>
                    <span className={`chip ${label.tone}`}>{label.text}</span>
                  </div>
                  <span className="muted small">
                    {src.totalEpisodes ? (
                      <span className={src.complete ? '' : 'warn-text'}>
                        {src.videos}/{src.totalEpisodes} episodes{src.complete ? '' : ' (incomplete)'}
                      </span>
                    ) : (
                      <span className="warn-text">
                        {src.videos} {src.videos === 1 ? 'video' : 'videos'} (no totalEpisodes in drama.json)
                      </span>
                    )}{' '}
                    · {formatBytes(src.size)} ·{' '}
                    <span className={src.framesCut < src.videos ? 'warn-text' : ''}>
                      {src.cutting ? '✂️ cutting…' : `✂️ ${src.framesCut}/${src.videos} cut`}
                    </span>
                    {src.drama?.category && ` · ${src.drama.category}`}
                    {src.gaps.length > 0 && (
                      <span className="warn-text"> · missing episodes {formatGaps(src.gaps)}</span>
                    )}
                    {label.detail && ` · last converted: ${label.detail}`}
                  </span>
                </div>
                {label.busy && onOpenJob && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => onOpenJob(src.conversions.find((c) => c.status === 'converting').id)}
                  >
                    Open
                  </button>
                )}
                <button
                  type="button"
                  className={`btn btn-sm ${label.converted ? 'btn-ghost' : 'btn-primary'}`}
                  disabled={Boolean(starting) || label.busy || src.cutting}
                  onClick={() => convert(src, label)}
                >
                  {starting === src.name ? 'Starting…' : label.converted ? 'Convert again' : 'Convert'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
