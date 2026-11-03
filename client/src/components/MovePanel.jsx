import { useCallback, useEffect, useState } from 'react'
import { move } from '../api.js'
import { formatBytes, naturalCompare } from '../utils.js'

const formatDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function MovePanel({ onOpenFolder }) {
  const [data, setData] = useState(null) // { root, files, folders }
  const [folder, setFolder] = useState('')
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

  useEffect(() => {
    load()
  }, [load])

  const name = folder.trim()
  const invalid = /[\\/]/.test(name) || name === '.' || name === '..'
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
      setResult(
        await move.run(
          name,
          files.map((f) => f.name),
        ),
      )
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
              {result.created ? ' (new folder)' : ''}.
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
          <span>Folder name</span>
          <div className="input-with-btn">
            <input
              type="text"
              list="move-folders"
              placeholder="e.g. My Drama"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              disabled={moving}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!name || invalid || files.length === 0 || moving || loading}
            >
              {moving ? 'Moving…' : `Move ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
            </button>
          </div>
          <datalist id="move-folders">
            {data?.folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          {name && (
            <span className={`small ${invalid ? 'error-text' : 'muted'}`}>
              {invalid
                ? 'The folder name cannot contain "/" or "\\" and cannot be "." or "..".'
                : exists
                  ? `"${name}" already exists. The files will be added to it; files with the same name are skipped.`
                  : `A new folder "${rootName}/${name}" will be created.`}
            </span>
          )}
        </label>
      </form>

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
