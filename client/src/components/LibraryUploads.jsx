import { useCallback, useEffect, useState } from 'react'
import { library, r2 as r2Api } from '../api.js'
import { formatBytes, isR2Configured, percent } from '../utils.js'

const formatDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : ''

/**
 * Upload label for a converted folder in the current bucket. Recorded uploads (.job.json) are checked against the
 * bucket's top-level folders when that list is available, so a folder deleted from the bucket shows as not uploaded.
 */
function uploadLabel(item, bucket, series) {
  if (item.r2?.status === 'uploading') return { tone: 'active', text: 'Uploading…', busy: true }
  const inBucket = (prefix) => !series || series.includes(prefix.split('/')[0])
  const rec = [...item.uploads].reverse().find((u) => u.bucket === bucket && inBucket(u.prefix))
  if (rec)
    return {
      tone: 'done',
      text: 'Uploaded',
      detail: `${bucket}/${rec.prefix}/ · ${formatDate(rec.at)}`,
      uploaded: true,
    }
  // Uploaded from the local-folder form below, which can't record it: the bucket has a folder named after it
  if (series?.includes(item.id))
    return {
      tone: 'done',
      text: 'Uploaded',
      detail: `${bucket}/${item.id}/`,
      uploaded: true,
    }
  if (item.r2?.status === 'failed') return { tone: 'error', text: 'Upload failed' }
  if (item.r2?.status === 'cancelled') return { tone: 'error', text: 'Upload cancelled' }
  return { tone: 'idle', text: 'Not uploaded' }
}

const STATUS = {
  converting: { tone: 'active', text: 'Converting…' },
  interrupted: { tone: 'error', text: 'Conversion interrupted' },
  failed: { tone: 'error', text: 'Conversion failed' },
}

/** Upload tab: converted folders on the server, uploaded to the bucket on click. */
export default function LibraryUploads({ active, settings, refreshKey = 0 }) {
  const configured = isR2Configured(settings)
  const [data, setData] = useState(null)
  const [series, setSeries] = useState(null) // top-level folders in the bucket; null = unknown
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = useCallback(
    async ({ withBucket = true } = {}) => {
      setLoading(true)
      try {
        const [next, bucket] = await Promise.all([
          library.list(),
          withBucket && configured ? r2Api.series(settings).catch(() => null) : undefined,
        ])
        // Newest conversions first
        next.converted.sort((a, b) =>
          (b.completedAt || b.createdAt || '').localeCompare(a.completedAt || a.createdAt || ''),
        )
        setData(next)
        if (bucket !== undefined) setSeries(bucket ? bucket.series : null)
        setError(null)
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    },
    [configured, settings],
  )

  // Reload when shown, and when an upload was started from the "Choose folder" form below (refreshKey)
  useEffect(() => {
    if (active) load()
  }, [active, load, refreshKey])

  // Poll while something is converting or uploading (without re-listing the bucket every time)
  const running = data?.converted.some((c) => c.status === 'converting' || c.r2?.status === 'uploading')
  const [wasRunning, setWasRunning] = useState(false)
  useEffect(() => {
    if (!active || !running) return
    const timer = setInterval(() => load({ withBucket: false }), 1500)
    return () => clearInterval(timer)
  }, [active, running, load])
  // When everything finishes, refresh the bucket list once so the labels are confirmed
  useEffect(() => {
    if (wasRunning && !running) load()
    setWasRunning(Boolean(running))
  }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(item, label) {
    if (
      label.uploaded &&
      !window.confirm(`Upload "${item.drama?.dramaName || item.id}" again? Unchanged files are skipped.`)
    ) {
      return
    }
    setBusy(item.id)
    setError(null)
    try {
      await library.upload(item.id, settings)
      await load({ withBucket: false })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function cancel(item) {
    try {
      await library.cancelUpload(item.id)
      await load({ withBucket: false })
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <p className="eyebrow">On the server</p>
          <h2>📦 Converted folders</h2>
          <p className="muted small">
            Uploaded from the server to <strong>{settings.bucket || 'the bucket'}/&lt;uuid&gt;/</strong> (episodes,
            manifest.json and drama.json).
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load()} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {error && <p className="banner error">{error}</p>}
      {!configured && <p className="banner warn">Add your Cloudflare keys above to upload.</p>}
      {data && data.converted.length === 0 && <p className="muted">Nothing converted yet.</p>}

      {data && data.converted.length > 0 && (
        <ul className="rows bordered">
          {data.converted.map((item) => {
            // null when converted: the row then shows its upload label instead
            const status = item.status === 'done' ? null : STATUS[item.status] || { tone: 'error', text: item.status }
            const label = uploadLabel(item, settings.bucket, series)
            const r = item.r2
            const uploading = r?.status === 'uploading'
            const fraction = r?.totalBytes ? r.uploadedBytes / r.totalBytes : 0
            return (
              <li key={item.id} className="row job-row">
                <div className="row-main">
                  <div className="row-top">
                    <span className="name" title={item.id}>
                      {item.drama?.dramaName || item.source || item.id}
                    </span>
                    {status ? (
                      <span className={`chip ${status.tone}`}>{status.text}</span>
                    ) : (
                      <span className={`chip ${label.tone}`}>{label.text}</span>
                    )}
                  </div>
                  <span className="muted small">
                    <code>{item.id}</code>
                    {item.episodes != null &&
                      ` · ${item.episodes} ${item.episodes === 1 ? 'episode' : 'episodes'}`} · {formatBytes(item.size)}
                    {item.drama?.category && ` · ${item.drama.category}`}
                    {!status && label.detail && ` · ${label.detail}`}
                  </span>
                  {uploading && (
                    <>
                      <div className="bar">
                        <div className="fill" style={{ width: percent(fraction) }} />
                      </div>
                      <span className="muted small">
                        {r.total === 0
                          ? 'Checking bucket…'
                          : `${r.uploaded + r.skipped} of ${r.total} files · ${formatBytes(r.uploadedBytes)} of ${formatBytes(r.totalBytes)}`}
                      </span>
                    </>
                  )}
                  {!uploading && (r?.fatal || (r?.status === 'failed' && r.errors?.[0])) && (
                    <span className="error-text small">{r.fatal || `${r.errors[0].file}: ${r.errors[0].error}`}</span>
                  )}
                </div>
                {uploading ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => cancel(item)}>
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`btn btn-sm ${label.uploaded ? 'btn-ghost' : 'btn-primary'}`}
                    disabled={!configured || item.status !== 'done' || Boolean(busy)}
                    onClick={() => upload(item, label)}
                  >
                    {busy === item.id
                      ? 'Starting…'
                      : label.uploaded
                        ? 'Upload again'
                        : r?.status === 'failed' || r?.status === 'cancelled'
                          ? 'Retry'
                          : 'Upload'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
