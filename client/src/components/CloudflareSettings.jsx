import { useState } from 'react'
import { r2 } from '../api.js'
import { DEFAULT_R2, isR2Configured, normalizePublicUrl } from '../utils.js'

/**
 * Cloudflare R2 credentials form. Values are saved in this browser's localStorage
 * (via onSave) and sent only to the local server, which signs requests to Cloudflare.
 */
export default function CloudflareSettings({ settings, onSave, onClear }) {
  const configured = isR2Configured(settings)
  const [editing, setEditing] = useState(!configured)
  const [form, setForm] = useState(settings)
  const [showSecret, setShowSecret] = useState(false)
  const [status, setStatus] = useState(null) // { tone, text }
  const [busy, setBusy] = useState(false)

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }))

  function cleaned() {
    return {
      account: form.account.trim(),
      accessKeyId: form.accessKeyId.trim(),
      secretAccessKey: form.secretAccessKey.trim(),
      bucket: form.bucket.trim().toLowerCase() || DEFAULT_R2.bucket,
      publicUrl: normalizePublicUrl(form.publicUrl),
    }
  }

  async function saveAndTest(e) {
    e.preventDefault()
    const next = cleaned()
    if (!isR2Configured(next)) {
      setStatus({ tone: 'error', text: 'Fill in Account ID, Access Key ID, Secret Access Key and Bucket.' })
      return
    }
    if (form.publicUrl.trim() && !next.publicUrl) {
      setStatus({ tone: 'error', text: 'Public URL is not a valid URL (e.g. https://pub-xxxx.r2.dev).' })
      return
    }
    setForm(next)
    setBusy(true)
    setStatus({ tone: 'idle', text: 'Testing connection…' })
    try {
      await r2.test(next)
      onSave(next)
      setStatus({ tone: 'done', text: `Connected to bucket "${next.bucket}". Saved on this computer.` })
      setEditing(false)
    } catch (err) {
      setStatus({ tone: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  async function retest() {
    setBusy(true)
    setStatus({ tone: 'idle', text: 'Testing connection…' })
    try {
      await r2.test(settings)
      setStatus({ tone: 'done', text: `Connected to bucket "${settings.bucket}".` })
    } catch (err) {
      setStatus({ tone: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  function clear() {
    if (!window.confirm('Remove the saved Cloudflare keys from this browser?')) return
    onClear()
    setForm({ ...DEFAULT_R2 })
    setStatus(null)
    setEditing(true)
  }

  if (!editing) {
    return (
      <section className="card">
        <div className="card-head">
          <div>
            <p className="eyebrow">Cloudflare R2</p>
            <h2>☁️ {settings.bucket}</h2>
            <p className="muted small">
              Key {mask(settings.accessKeyId)} ·{' '}
              {settings.publicUrl ? settings.publicUrl : <span className="warn-text">no public URL set</span>}
            </p>
          </div>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={retest} disabled={busy}>
              Test
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setForm(settings)
                setEditing(true)
                setStatus(null)
              }}
            >
              Edit
            </button>
          </div>
        </div>
        {status && <p className={`banner ${bannerTone(status.tone)}`}>{status.text}</p>}
      </section>
    )
  }

  return (
    <section className="card">
      <div>
        <p className="eyebrow">Cloudflare R2</p>
        <h2>Connect your bucket</h2>
        <p className="muted">
          From Cloudflare → R2 → <strong>Manage API tokens</strong>. Saved in this browser only.
        </p>
      </div>

      <form className="form" onSubmit={saveAndTest} autoComplete="off">
        <label className="field">
          <span>Account ID or S3 API URL</span>
          <input
            value={form.account}
            onChange={update('account')}
            placeholder="b6fd9acb6792acaf3d7d1f2d73487ae2"
            spellCheck={false}
          />
          <small className="muted">
            Paste either the Account ID or the bucket's "S3 API" URL from its Settings page.
          </small>
        </label>

        <div className="grid-2">
          <label className="field">
            <span>Access Key ID</span>
            <input value={form.accessKeyId} onChange={update('accessKeyId')} spellCheck={false} />
          </label>
          <label className="field">
            <span>Secret Access Key</span>
            <div className="input-with-btn">
              <input
                type={showSecret ? 'text' : 'password'}
                value={form.secretAccessKey}
                onChange={update('secretAccessKey')}
                spellCheck={false}
                autoComplete="new-password"
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowSecret((s) => !s)}>
                {showSecret ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
        </div>

        <div className="grid-2">
          <label className="field">
            <span>Bucket</span>
            <input value={form.bucket} onChange={update('bucket')} placeholder="dramas" spellCheck={false} />
          </label>
          <label className="field">
            <span>
              Public URL <span className="muted">(optional)</span>
            </span>
            <input
              value={form.publicUrl}
              onChange={update('publicUrl')}
              placeholder="https://pub-xxxx.r2.dev or https://cdn.yourapp.com"
              spellCheck={false}
            />
            <small className="muted">Used to show playable links and preview after upload.</small>
          </label>
        </div>

        {status && <p className={`banner ${bannerTone(status.tone)}`}>{status.text}</p>}

        <div className="actions end">
          {configured && (
            <>
              <button type="button" className="btn btn-ghost" onClick={clear}>
                Remove saved keys
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </button>
            </>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Testing…' : 'Save & test connection'}
          </button>
        </div>
      </form>
    </section>
  )
}

function mask(value) {
  if (!value) return '—'
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}…${value.slice(-4)}`
}

function bannerTone(tone) {
  return tone === 'error' ? 'error' : tone === 'done' ? 'success' : 'info'
}
