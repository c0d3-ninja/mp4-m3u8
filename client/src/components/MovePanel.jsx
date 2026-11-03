import { useCallback, useEffect, useState } from 'react'
import { move } from '../api.js'
import { folderSlug, formatBytes, formatGaps, gapCount, naturalCompare } from '../utils.js'

const formatDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const nameOf = (drama) =>
  [drama?.app_dramaName, drama?.dramaName].find((v) => typeof v === 'string' && v.trim())?.trim() || ''

/** The JSON field: { drama, error }. Empty -> both null. */
function parseDrama(text) {
  if (!text.trim()) return { drama: null, error: null }
  try {
    const drama = JSON.parse(text)
    if (!drama || typeof drama !== 'object' || Array.isArray(drama))
      return { drama: null, error: 'Must be a JSON object { … }' }
    if (!nameOf(drama)) return { drama, error: 'Needs "app_dramaName" or "dramaName" (the folder is named after it)' }
    return { drama, error: null }
  } catch (e) {
    return { drama: null, error: `Not valid JSON: ${e.message}` }
  }
}

export default function MovePanel({ active = true, onOpenFolder }) {
  const [data, setData] = useState(null) // { root, files, folders }
  // drama.json content, pasted or filled by the browser extension's "Fill JSON" button (textarea#move-json)
  const [json, setJson] = useState('')
  const [loading, setLoading] = useState(false)
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null) // { folder, created, moved, skipped }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await move.preview()
      next.files.sort((a, b) => naturalCompare(a.name, b.name))
      next.folders.sort(naturalCompare)
      setData(next)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // The tab stays mounted (hidden with CSS), so re-list the MP4s whenever it is shown
  useEffect(() => {
    if (active) load()
  }, [active, load])

  const { drama, error: jsonError } = parseDrama(json)
  const name = drama && !jsonError ? folderSlug(nameOf(drama)) : '' // the folder that will actually be created / used
  const invalid = /[\\/]/.test(name)
  const exists = Boolean(name) && data?.folders.includes(name)
  const files = data?.files || []
  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const rootName = data?.root?.split(/[\\/]/).filter(Boolean).pop() || 'Downloads'

  async function run(e) {
    e.preventDefault()
    if (!name || invalid || files.length === 0) return
    setMoving(true)
    setError(null)
    setResult(null)
    try {
      const done = await move.run(
        drama,
        files.map((f) => f.name),
      )
      setResult(done)
      setJson('')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setMoving(false)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <p className="eyebrow">Move MP4 files</p>
          <h2>📦 Move into a folder</h2>
          <p className="muted small" title={data?.root}>
            Moves every <strong>.mp4</strong> directly inside <strong>{data?.root || rootName}</strong> (not in
            sub-folders) into the folder you name. The folder is created if it doesn't exist.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-ghost" disabled={loading || moving} onClick={load}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <p className="banner error" role="alert">
          {error}
          <button type="button" className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}

      {result && (
        <div className={`banner ${result.skipped.length ? 'warn' : 'success'}`}>
          <div className="result">
            <span>
              Moved {result.moved.length} {result.moved.length === 1 ? 'file' : 'files'} into{' '}
              <strong>{result.folder}</strong>
              {result.created ? ' (new folder)' : ''}. drama.json saved ({result.keys} fields):{' '}
              {result.drama?.dramaName}
              {result.drama?.category && ` · ${result.drama.category}`}.
            </span>
            {result.skipped.length > 0 && (
              <ul className="error-list">
                {result.skipped.map((s) => (
                  <li key={s.name}>
                    {s.name}: {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenFolder(result.folder)}>
            🗂️ Open in Folders
          </button>
        </div>
      )}

      <form className="form" onSubmit={run}>
        <label className="field">
          <span>Drama JSON (saved as drama.json)</span>
          <textarea
            id="move-json"
            className="json-input"
            rows={9}
            placeholder={
              '{\n  "dramaName": "…",\n  "app_dramaName": "…",\n  "category": ["…"],\n  "posterImageUrl": "https://…"\n}\n\nPaste it, or use the browser extension\'s "Fill JSON" button.'
            }
            value={json}
            onChange={(e) => setJson(e.target.value)}
            disabled={moving}
            spellCheck={false}
          />
          {json.trim() && (
            <span className={`small ${jsonError || invalid ? 'error-text' : 'muted'}`}>
              {jsonError
                ? jsonError
                : invalid
                  ? 'The folder name cannot contain "/" or "\\".'
                  : exists
                    ? `Folder "${name}" already exists. The files will be added to it (same names are skipped) and its drama.json updated.`
                    : `A new folder "${rootName}/${name}" will be created.`}
            </span>
          )}
        </label>
        <p className="muted small">
          The folder is named after <code>app_dramaName</code> (else <code>dramaName</code>). The whole JSON is saved as{' '}
          <strong>drama.json</strong> in the folder and copied into the converted folder, with <code>cfId</code> set
          to its UUID.
        </p>

        <div className="actions end">
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={!name || invalid || files.length === 0 || moving || loading}
          >
            {moving ? 'Moving…' : `Move ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
          </button>
        </div>
      </form>

      {data?.gaps?.length > 0 && (
        <p className="banner warn">
          Missing {gapCount(data.gaps) === 1 ? 'episode' : 'episodes'} {formatGaps(data.gaps)}: those files are not in
          the downloads folder. Check that they finished downloading before moving.
        </p>
      )}

      {data && (
        <div className="list">
          <div className="list-head">
            <span>{name && !invalid ? `Going to move into “${name}”` : 'MP4 files to move'}</span>
            <span className="muted">
              {files.length} {files.length === 1 ? 'file' : 'files'} · {formatBytes(totalBytes)}
            </span>
          </div>
          {files.length === 0 ? (
            <p className="muted" style={{ padding: '14px' }}>
              No .mp4 files directly inside {rootName}.
            </p>
          ) : (
            <ul className="rows">
              {files.map((f, i) => (
                <li key={f.name}>
                  <div className="row entry">
                    <span className="num">{i + 1}</span>
                    <span className="name" title={f.name}>
                      {f.name}
                    </span>
                    <span className="muted meta date">{formatDate(f.modified)}</span>
                    <span className="muted meta size">{formatBytes(f.size)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
