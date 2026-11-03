import { useState } from 'react'
import { api } from '../api.js'
import { cleanPrefix, formatBytes, isR2Configured, percent, publicObjectUrl } from '../utils.js'

/** "Upload to Cloudflare" for a finished conversion: the server uploads its converted files directly. */
export default function CloudflarePush({ job, settings, onChanged, onOpenSettings }) {
  // Same default as the Upload tab's list: one bucket folder per conversion, named after its drama id
  const [prefix, setPrefix] = useState(job.id)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const r2 = job.r2
  const uploading = r2?.status === 'uploading'

  if (!isR2Configured(settings)) {
    return (
      <div className="push-box">
        <span>☁️ Want this series on Cloudflare R2?</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenSettings}>
          Set up Cloudflare
        </button>
      </div>
    )
  }

  async function start() {
    const dest = cleanPrefix(prefix)
    if (!dest) {
      setError('Enter the destination folder in the bucket.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      onChanged(await api.startR2Upload(job.id, settings, dest, true))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    try {
      onChanged(await api.cancelR2Upload(job.id))
    } catch (e) {
      setError(e.message)
    }
  }

  const fraction = r2?.totalBytes ? r2.uploadedBytes / r2.totalBytes : 0
  const manifestUrl = r2?.status === 'done' ? publicObjectUrl(settings, r2.prefix, 'manifest.json') : ''

  return (
    <div className="push-box column">
      <div className="row-top">
        <strong>☁️ Upload to Cloudflare</strong>
        {!uploading && r2?.status !== 'done' && (
          <div className="input-prefix grow">
            <span className="muted">{settings.bucket}/</span>
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} spellCheck={false} />
          </div>
        )}
        {uploading ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>
            Cancel
          </button>
        ) : r2?.status === 'done' ? (
          <span className="chip done">Uploaded</span>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={start} disabled={busy}>
            {r2 ? 'Retry' : 'Upload'}
          </button>
        )}
      </div>

      {r2 && r2.status !== 'done' && (
        <>
          <div className="bar">
            <div className={`fill ${r2.status === 'failed' ? 'error' : ''}`} style={{ width: percent(fraction) }} />
          </div>
          <span className="muted small">
            {r2.status === 'uploading' && r2.total === 0
              ? 'Checking bucket…'
              : `${r2.uploaded + r2.skipped} of ${r2.total} files · ${formatBytes(r2.uploadedBytes)} of ${formatBytes(r2.totalBytes)}`}
            {r2.failed > 0 && <span className="error-text"> · {r2.failed} failed</span>}
            {r2.status === 'cancelled' && ' · cancelled'}
          </span>
        </>
      )}

      {r2?.fatal && <span className="error-text small">{r2.fatal}</span>}
      {!r2?.fatal && r2?.status === 'failed' && r2.errors[0] && (
        <span className="error-text small">
          {r2.errors[0].file}: {r2.errors[0].error}
        </span>
      )}
      {error && <span className="error-text small">{error}</span>}

      {r2?.status === 'done' && (
        <span className="muted small">
          {r2.uploaded} uploaded{r2.skipped > 0 && `, ${r2.skipped} already there`} →{' '}
          <code>
            {settings.bucket}/{r2.prefix}/
          </code>
          {manifestUrl && (
            <>
              {' '}
              ·{' '}
              <a href={manifestUrl} target="_blank" rel="noreferrer">
                manifest.json
              </a>
            </>
          )}
        </span>
      )}
    </div>
  )
}
