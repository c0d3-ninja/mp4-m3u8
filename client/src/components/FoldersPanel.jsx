import { useCallback, useEffect, useRef, useState } from 'react'
import { folders } from '../api.js'
import { formatBytes, naturalCompare } from '../utils.js'

const ICONS = { dir: '📁', file: '📄', link: '🔗' }

const formatDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1
    return naturalCompare(a.name, b.name)
  })
}

export default function FoldersPanel({ active = true, initialPath = '' }) {
  const [path, setPath] = useState('')
  const pathRef = useRef('') // folder currently shown, to refresh it when the tab is shown again
  pathRef.current = path
  const [data, setData] = useState(null) // { root, path, entries, disk }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [deleting, setDeleting] = useState(() => new Set())

  const latest = useRef(0)

  const load = useCallback(async (target) => {
    // Clicking around quickly starts several requests; only the newest one may update the page
    const seq = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const next = await folders.list(target)
      if (seq !== latest.current) return
      setData({ ...next, entries: sortEntries(next.entries) })
      setPath(next.path)
    } catch (e) {
      if (seq === latest.current) setError(e.message)
    } finally {
      if (seq === latest.current) setLoading(false)
    }
  }, [])

  // The tab stays mounted (hidden with CSS), so re-read the disk whenever it is shown: at the folder another tab asked
  // for ("Open in Folders"), otherwise where you were.
  useEffect(() => {
    if (active) load(initialPath || pathRef.current)
  }, [active, load, initialPath])

  function open(target) {
    setNotice(null)
    load(target)
  }

  const childPath = (name) => (path ? `${path}/${name}` : name)

  async function remove(entry) {
    const target = childPath(entry.name)
    const what =
      entry.type === 'dir'
        ? `the folder "${entry.name}" and everything inside it (${entry.files} files, ${formatBytes(entry.size)})`
        : `"${entry.name}"`
    if (!window.confirm(`Permanently delete ${what}? This cannot be undone.`)) return

    setError(null)
    setNotice(null)
    setDeleting((d) => new Set(d).add(target))
    try {
      await folders.remove(target)
      setNotice(`Deleted ${entry.name}`)
      await load(path)
    } catch (e) {
      setError(e.message)
    } finally {
      setDeleting((d) => {
        const next = new Set(d)
        next.delete(target)
        return next
      })
    }
  }

  const parts = path ? path.split('/') : []
  const rootName = data?.root?.split(/[\\/]/).filter(Boolean).pop() || 'Downloads'
  const totalSize = data?.entries.reduce((s, e) => s + e.size, 0) || 0

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <p className="eyebrow">Server folder</p>
          <h2>🗂️ {rootName}</h2>
          <p className="muted small" title={data?.root}>
            {data?.root || 'Loading…'}
            {data?.disk && ` · ${formatBytes(data.disk.free)} free of ${formatBytes(data.disk.total)}`}
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => open(path)}>
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
      {notice && <p className="banner success">{notice}</p>}

      <nav className="crumbs" aria-label="Path">
        <button type="button" disabled={parts.length === 0} onClick={() => open('')}>
          {rootName}
        </button>
        {parts.map((part, i) => (
          <span key={i} className="crumbs">
            <span className="sep">/</span>
            <button
              type="button"
              disabled={i === parts.length - 1}
              onClick={() => open(parts.slice(0, i + 1).join('/'))}
            >
              {part}
            </button>
          </span>
        ))}
      </nav>

      {data && (
        <div className="list">
          <div className="list-head">
            <span>{path ? parts[parts.length - 1] : rootName}</span>
            <span className="muted">
              {data.entries.length} {data.entries.length === 1 ? 'item' : 'items'} · {formatBytes(totalSize)}
            </span>
          </div>

          {data.entries.length === 0 ? (
            <p className="muted" style={{ padding: '14px' }}>
              This folder is empty.
            </p>
          ) : (
            <ul className="rows">
              {path && (
                <li>
                  <div className="row entry">
                    <span className="icon">↩︎</span>
                    <button type="button" className="name" onClick={() => open(parts.slice(0, -1).join('/'))}>
                      ..
                    </button>
                  </div>
                </li>
              )}
              {data.entries.map((entry) => {
                const target = childPath(entry.name)
                const busy = deleting.has(target)
                return (
                  <li key={entry.name}>
                    <div className={`row entry ${busy ? 'busy' : ''}`}>
                      <span className="icon">{ICONS[entry.type]}</span>
                      {entry.type === 'dir' ? (
                        <button type="button" className="name" title={entry.name} onClick={() => open(target)}>
                          {entry.name}
                        </button>
                      ) : (
                        <span className="name" title={entry.name}>
                          {entry.name}
                        </span>
                      )}
                      {entry.type === 'dir' && (
                        <span className="muted meta">
                          {entry.items} {entry.items === 1 ? 'item' : 'items'}
                        </span>
                      )}
                      <span className="muted meta date">{formatDate(entry.modified)}</span>
                      <span className="muted meta size">{formatBytes(entry.size)}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => remove(entry)}
                        aria-label={`Delete ${entry.name}`}
                      >
                        {busy ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
