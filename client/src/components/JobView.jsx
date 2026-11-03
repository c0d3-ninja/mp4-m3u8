import { formatBytes, formatDuration, hlsUrl, percent } from '../utils.js'
import CloudflarePush from './CloudflarePush.jsx'

/** Combine server state with local upload progress into one row state. */
function rowState(file, upload, uploadsComplete) {
  switch (file.status) {
    case 'pending':
    case 'uploading':
      if (upload?.error) return { label: 'Upload failed', tone: 'error', progress: 0, detail: upload.error }
      if (upload && !upload.done)
        return { label: `Uploading ${percent(upload.progress)}`, tone: 'active', progress: upload.progress * 0.1 }
      if (uploadsComplete) return { label: 'Not uploaded', tone: 'error', progress: 0 }
      return { label: 'Waiting to upload', tone: 'idle', progress: 0 }
    case 'queued':
      return { label: 'Queued', tone: 'idle', progress: 0.1 }
    case 'converting':
      return { label: `Converting ${percent(file.progress)}`, tone: 'active', progress: 0.1 + 0.9 * file.progress }
    case 'done':
      return { label: 'Done', tone: 'done', progress: 1 }
    case 'error':
      return { label: 'Failed', tone: 'error', progress: 1, detail: file.error }
    default:
      return { label: file.status, tone: 'idle', progress: 0 }
  }
}

export default function JobView({
  job,
  uploads,
  uploading,
  onCancel,
  onDiscard,
  onFinishInterrupted,
  onNew,
  onPreview,
  onOpenFolders,
  r2Settings,
  onR2Changed,
  onOpenCloudflare,
}) {
  const states = job.files.map((f) => rowState(f, uploads[f.id], job.uploadsComplete))
  const doneCount = job.files.filter((f) => f.status === 'done').length
  const failedCount = states.filter((s) => s.tone === 'error').length
  const total = job.files.length

  const running = ['uploading', 'processing'].includes(job.status)
  const interrupted = job.status === 'uploading' && !uploading

  let overall = states.reduce((sum, s) => sum + s.progress, 0) / total
  if (job.status === 'done') overall = 1

  const headline = {
    uploading: interrupted ? 'Upload interrupted' : 'Uploading & converting…',
    processing: 'Converting…',
    done: 'Conversion finished',
    failed: 'Conversion failed',
    cancelled: 'Cancelled',
  }[job.status]

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <p className="eyebrow">{job.folderName}</p>
          <h2>{headline}</h2>
          <p className="muted">
            {doneCount} of {total} converted
            {failedCount > 0 && <span className="error-text"> · {failedCount} failed</span>}
          </p>
        </div>
        <div className="actions">
          {running && !interrupted && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          {!running && (
            <button type="button" className="btn btn-ghost" onClick={onNew}>
              Convert another folder
            </button>
          )}
          {job.status === 'done' && (
            <button type="button" className="btn btn-primary" onClick={() => onOpenFolders(job.id)}>
              🗂️ Open in Folders
            </button>
          )}
        </div>
      </div>

      {job.status !== 'done' && (
        <div className="bar big">
          <div className={`fill ${job.status === 'failed' ? 'error' : ''}`} style={{ width: percent(overall) }} />
        </div>
      )}

      {job.status === 'done' && job.output && (
        <p className="banner success">
          <span>
            Saved to <code>{job.output.path}</code> ({formatBytes(job.output.size)})
          </span>
        </p>
      )}

      {job.status === 'failed' && job.error && <p className="banner error">{job.error}</p>}

      {job.status === 'done' && (
        <CloudflarePush job={job} settings={r2Settings} onChanged={onR2Changed} onOpenSettings={onOpenCloudflare} />
      )}

      {interrupted && (
        <div className="banner warn">
          <span>
            The page was reloaded while uploading, so some episodes were never sent. You can convert the episodes that
            did arrive, or discard this job and start again.
          </span>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={onDiscard}>
              Discard
            </button>
            <button type="button" className="btn btn-primary" onClick={onFinishInterrupted}>
              Convert uploaded episodes
            </button>
          </div>
        </div>
      )}

      <ul className="rows">
        {job.files.map((file, index) => {
          const s = states[index]
          const r = file.result
          return (
            <li key={file.id} className={`row job-row ${s.tone}`}>
              <span className="num">{index + 1}</span>
              {r?.poster ? (
                <img className="thumb" src={hlsUrl(job, file.outputPath, r.poster)} alt="" loading="lazy" />
              ) : (
                <span className="thumb" />
              )}
              <div className="row-main">
                <div className="row-top">
                  <span className="name" title={file.relativePath}>
                    {file.relativePath}
                  </span>
                  <span className={`chip ${s.tone}`}>{s.label}</span>
                </div>
                {s.tone === 'active' && (
                  <div className="bar">
                    <div className="fill" style={{ width: percent(s.progress) }} />
                  </div>
                )}
                {r && (
                  <span className="muted small">
                    {formatDuration(r.duration)} · {r.renditions.map((x) => x.name).join(' / ')}
                    {!r.hasAudio && ' · no audio'}
                  </span>
                )}
                {s.detail && <span className="error-text small">{s.detail}</span>}
              </div>
              {file.status === 'done' && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    onPreview({ title: file.relativePath, src: hlsUrl(job, file.outputPath, 'master.m3u8') })
                  }
                >
                  ▶ Preview
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
