import { useEffect, useRef, useState } from 'react'
import { cut } from '../api.js'

const FRAMES = [2, 3] // 0-based: the 3rd and 4th frame

/** One frame, loaded asynchronously (lazily, when scrolled into view) with a placeholder until it arrives. */
function Frame({ folder, ep, n }) {
  const [state, setState] = useState('loading') // loading | ok | error
  const img = useRef(null)
  const src = cut.frameUrl(folder, ep.file, n, ep.version)
  // A frame from the browser cache can finish before React sees its load event
  useEffect(() => {
    if (img.current?.complete && img.current.naturalWidth > 0) setState('ok')
  }, [])
  return (
    <figure className={`ep-frame ${state}`}>
      <img
        ref={img}
        src={src}
        alt={`Episode ${ep.episode ?? ep.file}, frame ${n + 1}`}
        loading="lazy"
        decoding="async"
        onLoad={() => setState('ok')}
        onError={() => setState('error')}
      />
      {state !== 'ok' && <span className="ep-frame-note">{state === 'error' ? 'No frame' : 'Loading…'}</span>}
      <figcaption>Frame {n + 1}</figcaption>
    </figure>
  )
}

/** Cut frames tab, an opened folder: every episode with its 3rd and 4th frame. `version` changes as files get cut. */
export default function EpisodeFrames({ folder, version }) {
  const [episodes, setEpisodes] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let stale = false
    cut
      .episodes(folder)
      .then((r) => !stale && (setEpisodes(r.episodes), setError(null)))
      .catch((e) => !stale && setError(e.message))
    return () => {
      stale = true
    }
  }, [folder, version])

  if (error) return <p className="banner error">{error}</p>
  if (!episodes) return <p className="muted small ep-loading">Loading episodes…</p>
  if (episodes.length === 0) return <p className="muted small">No videos in this folder.</p>

  return (
    <ul className="ep-grid">
      {episodes.map((ep) => (
        <li key={ep.file} className="ep-card">
          <div className="ep-head">
            <strong>{ep.episode != null ? `EP ${ep.episode}` : ep.file}</strong>
            <span className={`chip ${ep.cut ? 'done' : 'idle'}`}>{ep.cut ? 'Cut' : 'Not cut'}</span>
          </div>
          <div className="ep-frames">
            {FRAMES.map((n) => (
              // key includes the version: a newly cut file gets a fresh Frame (and loading state)
              <Frame key={`${n}|${ep.version}`} folder={folder} ep={ep} n={n} />
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}
