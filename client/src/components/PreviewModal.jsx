import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'

export default function PreviewModal({ src, title, remote = false, onClose }) {
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const [levels, setLevels] = useState([])
  const [level, setLevel] = useState(-1)
  const [playing, setPlaying] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    const video = videoRef.current
    setError(null)

    if (Hls.isSupported()) {
      const hls = new Hls()
      hlsRef.current = hls
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        setLevels(
          data.levels
            .map((l, index) => ({
              index,
              label: `${Math.min(l.width, l.height)}p`,
              height: Math.min(l.width, l.height),
            }))
            .sort((a, b) => b.height - a.height),
        )
        video.play().catch(() => {})
      })
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const l = hls.levels[data.level]
        if (l) setPlaying(`${l.width}×${l.height}`)
      })
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return
        const network = data.type === Hls.ErrorTypes.NETWORK_ERROR
        setError(
          remote && network
            ? `Could not load from Cloudflare (${data.details}). Check the bucket's CORS policy allows ${window.location.origin} and that the Public URL is correct.`
            : `Playback error: ${data.details}`,
        )
      })
      hls.loadSource(src)
      hls.attachMedia(video)
      return () => {
        hls.destroy()
        hlsRef.current = null
      }
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari plays HLS natively
      video.src = src
      video.play().catch(() => {})
      return () => {
        video.removeAttribute('src')
        video.load()
      }
    }

    setError('This browser cannot play HLS')
  }, [src, remote])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const changeLevel = (value) => {
    setLevel(value)
    if (hlsRef.current) hlsRef.current.currentLevel = value
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong className="name">{title}</strong>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <video ref={videoRef} controls playsInline className="player" />
        <div className="modal-foot">
          {levels.length > 0 && (
            <label>
              Quality{' '}
              <select value={level} onChange={(e) => changeLevel(Number(e.target.value))}>
                <option value={-1}>Auto</option>
                {levels.map((l) => (
                  <option key={l.index} value={l.index}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {playing && <span className="muted">Playing {playing}</span>}
          {error && <span className="error-text">{error}</span>}
        </div>
      </div>
    </div>
  )
}
