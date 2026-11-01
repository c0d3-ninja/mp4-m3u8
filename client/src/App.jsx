import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { formatBytes, readFolderSelection, storedJobId } from './utils.js'
import FolderPicker from './components/FolderPicker.jsx'
import FileList from './components/FileList.jsx'
import JobView from './components/JobView.jsx'

// hls.js is large, so the player is only loaded when a preview is opened
const PreviewModal = lazy(() => import('./components/PreviewModal.jsx'))

const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const RANK = { uploading: 0, processing: 1, zipping: 2, done: 3, failed: 3, cancelled: 3 }

export default function App() {
  const [selection, setSelection] = useState(null) // { folderName, items, totalFiles }
  const [selected, setSelected] = useState(() => new Set())
  const [job, setJob] = useState(null)
  const [uploads, setUploads] = useState({}) // fileId -> { progress, done, error }
  const [uploading, setUploading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const uploadAbort = useRef(null)

  /** Accept server snapshots, ignoring stale ones that would move the status backwards. */
  const applyJob = useCallback((next) => {
    setJob((prev) => (prev && prev.id === next.id && RANK[next.status] < RANK[prev.status] ? prev : next))
  }, [])

  const resetToStart = useCallback(() => {
    storedJobId.clear()
    setJob(null)
    setUploads({})
    setDownloaded(false)
    setPreview(null)
  }, [])

  // Re-attach to a job after a page reload
  useEffect(() => {
    const id = storedJobId.get()
    if (!id) return
    api.getJob(id).then(applyJob, () => storedJobId.clear())
  }, [applyJob])

  // Poll the server while the job is running
  useEffect(() => {
    if (!job || TERMINAL.has(job.status)) return
    const id = job.id
    let stopped = false
    const timer = setInterval(async () => {
      try {
        const next = await api.getJob(id)
        if (!stopped) applyJob(next)
      } catch (e) {
        if (!stopped && e.status === 404) {
          stopped = true
          uploadAbort.current?.abort()
          resetToStart()
          setError('The conversion job no longer exists on the server (was the server restarted?). Please start again.')
        }
      }
    }, 1000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [job?.id, job?.status, applyJob, resetToStart])

  // Warn before closing the tab mid-upload
  useEffect(() => {
    if (!uploading) return
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [uploading])

  function handleFolder(fileList) {
    setError(null)
    setNotice(null)
    const result = readFolderSelection(fileList)
    if (!result) {
      setError('That folder is empty.')
      return
    }
    if (result.items.length === 0) {
      setError(`No videos found in "${result.folderName}". Supported: mp4, m4v, mov, mkv, webm, avi.`)
      return
    }
    setSelection(result)
    setSelected(new Set(result.items.map((i) => i.key))) // everything selected by default
  }

  function toggle(key) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll(on) {
    setSelected(on ? new Set(selection.items.map((i) => i.key)) : new Set())
  }

  async function startConversion() {
    const chosen = selection.items.filter((i) => selected.has(i.key))
    if (chosen.length === 0) return
    setError(null)
    setNotice(null)
    setStarting(true)

    let created
    try {
      created = await api.createJob(
        selection.folderName,
        chosen.map((i) => ({ relativePath: i.relativePath, size: i.size })),
      )
    } catch (e) {
      setError(e.message)
      setStarting(false)
      return
    }

    storedJobId.set(created.id)
    setUploads({})
    setDownloaded(false)
    setJob(created)
    setStarting(false)
    setUploading(true)

    const controller = new AbortController()
    uploadAbort.current = controller
    const fileByPath = new Map(chosen.map((i) => [i.relativePath, i.file]))
    const setUpload = (id, value) => setUploads((u) => ({ ...u, [id]: value }))

    // Upload one episode at a time; the server starts converting each as soon as it arrives.
    for (const f of created.files) {
      if (controller.signal.aborted) break
      const file = fileByPath.get(f.relativePath)
      if (!file) {
        setUpload(f.id, { progress: 0, error: 'File not found in selection' })
        continue
      }

      let last = 0
      setUpload(f.id, { progress: 0 })
      try {
        await api.uploadFile(created.id, f.id, file, {
          signal: controller.signal,
          onProgress: (p) => {
            if (p - last >= 0.01 || p === 1) {
              last = p
              setUpload(f.id, { progress: p })
            }
          },
        })
        setUpload(f.id, { progress: 1, done: true })
      } catch (e) {
        if (e.name === 'AbortError' || controller.signal.aborted) break
        if (e.status === 404) break // job deleted; polling handles the reset
        setUpload(f.id, { progress: 0, error: e.message })
        if (e.status === 0) {
          // Server unreachable: no point trying the rest
          setError(e.message)
          break
        }
      }
    }

    if (!controller.signal.aborted) {
      try {
        applyJob(await api.finalize(created.id))
      } catch (e) {
        if (e.status !== 404) setError(e.message)
      }
    }
    uploadAbort.current = null
    setUploading(false)
  }

  async function cancelJob() {
    if (!window.confirm('Cancel this conversion? Episodes converted so far will be discarded.')) return
    uploadAbort.current?.abort()
    try {
      await api.removeJob(job.id)
    } catch (e) {
      if (e.status !== 404) {
        setError(e.message)
        return
      }
    }
    resetToStart()
    setNotice('Conversion cancelled. Your selection is still here if you want to try again.')
  }

  async function discardJob() {
    await api.removeJob(job.id).catch(() => {})
    resetToStart()
  }

  async function finishInterrupted() {
    try {
      applyJob(await api.finalize(job.id))
    } catch (e) {
      setError(e.message)
    }
  }

  async function startOver() {
    if (job.status === 'done' && !downloaded) {
      if (!window.confirm(`You haven't downloaded ${job.zip.fileName} yet. Discard it?`)) return
    }
    // Free the disk space used by the converted files on the server
    await api.removeJob(job.id).catch(() => {})
    resetToStart()
    setSelection(null)
    setSelected(new Set())
    setError(null)
    setNotice(null)
  }

  const chosenItems = selection ? selection.items.filter((i) => selected.has(i.key)) : []
  const chosenBytes = chosenItems.reduce((sum, i) => sum + i.size, 0)

  return (
    <div className="app">
      <header className="top">
        <h1>
          <span className="logo">▶</span> Drama Converter
        </h1>
        <p className="muted">Turn a folder of MP4 episodes into adaptive HLS streams, zipped and ready for your app.</p>
      </header>

      {error && (
        <p className="banner error" role="alert">
          {error}
          <button type="button" className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      {notice && <p className="banner info">{notice}</p>}

      {job ? (
        <JobView
          job={job}
          uploads={uploads}
          uploading={uploading}
          onCancel={cancelJob}
          onDiscard={discardJob}
          onFinishInterrupted={finishInterrupted}
          onNew={startOver}
          onPreview={setPreview}
          onDownload={() => setDownloaded(true)}
        />
      ) : selection ? (
        <section className="card">
          <div className="card-head">
            <div>
              <p className="eyebrow">Selected folder</p>
              <h2>📁 {selection.folderName}</h2>
              <p className="muted">
                Output: <strong>{selection.folderName}.zip</strong>
              </p>
            </div>
            <div className="actions">
              <FolderPicker onSelect={handleFolder} className="btn btn-ghost">
                Change folder
              </FolderPicker>
            </div>
          </div>

          <FileList items={selection.items} selected={selected} onToggle={toggle} onToggleAll={toggleAll} />

          <div className="card-foot">
            <span className="muted">
              {chosenItems.length} of {selection.items.length} selected · {formatBytes(chosenBytes)}
            </span>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={chosenItems.length === 0 || starting}
              onClick={startConversion}
            >
              {starting
                ? 'Starting…'
                : `Convert ${chosenItems.length} ${chosenItems.length === 1 ? 'episode' : 'episodes'}`}
            </button>
          </div>
        </section>
      ) : (
        <section className="card empty">
          <div className="empty-icon">📁</div>
          <h2>Select a series folder</h2>
          <p className="muted">
            Every video inside is listed and selected. Each episode becomes a multi-quality HLS stream (1080p → 360p),
            and everything is zipped as <strong>&lt;folder name&gt;.zip</strong>.
          </p>
          <FolderPicker onSelect={handleFolder}>Choose folder</FolderPicker>
        </section>
      )}

      {preview && (
        <Suspense fallback={null}>
          <PreviewModal src={preview.src} title={preview.title} onClose={() => setPreview(null)} />
        </Suspense>
      )}
    </div>
  )
}
