import { useCallback, useEffect, useState } from 'react'
import { move } from '../api.js'
import { folderSlug, formatBytes, formatGaps, gapCount, naturalCompare, storedCategory } from '../utils.js'

const formatDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function MovePanel({ active = true, onOpenFolder }) {
  const [data, setData] = useState(null) // { root, files, folders }
  const [folder, setFolder] = useState('')
  // Starts with the last category written, so moving several dramas of one genre needs no retyping
  const [category, setCategory] = useState(() => storedCategory.get())
  const [imageUrl, setImageUrl] = useState('')
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

  const name = folderSlug(folder) // the folder that will actually be created / used
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
        name,
        files.map((f) => f.name),
        { dramaName: folder.trim(), category: category.trim(), imageUrl: imageUrl.trim() },
      )
      setResult(done)
      // Keep the category that went into drama.json in the field, and remember it across refreshes
      const written = done.drama.category || ''
      setCategory(written)
      storedCategory.set(written)
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
              {result.created ? ' (new folder)' : ''}. drama.json: {result.drama.dramaName}
              {result.drama.category && ` · ${result.drama.category}`}
              {result.drama.imageUrl ? ' · image URL set' : ' · no image URL'}.
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
          <input
            type="text"
            list="move-folders"
            placeholder="e.g. My Drama"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            disabled={moving}
          />
          <datalist id="move-folders">
            {data?.folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          {folder.trim() && (
            <span className={`small ${invalid || !name ? 'error-text' : 'muted'}`}>
              {!name
                ? 'Enter a folder name with at least one letter or number.'
                : invalid
                  ? 'The folder name cannot contain "/" or "\\".'
                  : exists
                    ? `"${name}" already exists. The files will be added to it; files with the same name are skipped.`
                    : `A new folder "${rootName}/${name}" will be created.`}
            </span>
          )}
        </label>

        <div className="grid-2">
          <label className="field">
            <span>Category (optional)</span>
            <input
              type="text"
              placeholder="e.g. Romance"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={moving}
              maxLength={100}
            />
          </label>
          <label className="field">
            <span>Image URL (optional)</span>
            <input
              type="text"
              inputMode="url"
              placeholder="https://example.com/poster.jpg"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              disabled={moving}
              spellCheck={false}
            />
          </label>
        </div>
        <p className="muted small">
          Saved as <strong>drama.json</strong> in the folder (drama name = what you typed above) and copied into the
          converted folder when you convert it.{exists && ' Empty fields keep the values already in its drama.json.'}
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
