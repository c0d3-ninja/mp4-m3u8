import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { MAX_PARALLEL, clampParallel } from '../utils.js'

const OPTIONS = [
  {
    value: 'hardware',
    label: 'Apple hardware',
    hint: 'Mac media engine (VideoToolbox) · CPU stays free · one episode at a time',
    missing: 'Not on this server (Mac only)',
  },
  {
    value: 'nvenc',
    label: 'NVIDIA GPU',
    hint: 'NVENC on the graphics card (Linux) · decodes, resizes and encodes on the GPU · fastest',
    missing: 'No NVIDIA GPU / NVENC on this server',
    parallelHint: 'GeForce cards run 8 encodes at once: one per quality, so about 2 episodes',
  },
  {
    value: 'software',
    label: 'Software',
    hint: 'x264 on the CPU · works everywhere · slightly better quality for the size',
    parallelHint: 'the CPU is shared between them',
  },
]

/**
 * Convert tab: Apple hardware, NVIDIA GPU or software video encoding. The choice is saved in this browser and sent with
 * each Convert / Start click; changing it later never affects a conversion that is already running. Encoders the server
 * doesn't have are greyed out (the server would use software instead).
 */
export default function EncoderChoice({ value, onChange, parallel, onParallelChange }) {
  const [available, setAvailable] = useState(null)

  useEffect(() => {
    api.encoders().then(setAvailable, () => setAvailable(null))
  }, [])

  const has = (v) => !available || Boolean(available[v])
  // Saved choice not available here (e.g. "Apple hardware" on a Linux server): show what will really be used
  useEffect(() => {
    if (available && !available[value]) onChange(available.nvenc ? 'nvenc' : available.hardware ? 'hardware' : 'software')
  }, [available, value, onChange])

  return (
    <section className="card encoder-choice">
      <div>
        <p className="eyebrow">Encoding</p>
        <p className="muted small">Used for the next conversion you start. Running conversions keep their own.</p>
      </div>
      <div className="encoder-options" role="radiogroup" aria-label="Video encoding">
        {OPTIONS.map((o) => {
          const usable = has(o.value)
          return (
            <label
              key={o.value}
              className={`encoder-option ${value === o.value ? 'selected' : ''} ${usable ? '' : 'unavailable'}`}
            >
              <input
                type="radio"
                name="encoder"
                value={o.value}
                checked={value === o.value}
                disabled={!usable}
                onChange={() => onChange(o.value)}
              />
              <span>
                <strong>{o.label}</strong>
                <span className="muted small">{usable ? o.hint : o.missing}</span>
                {o.value === 'nvenc' && usable && available && !available.nvencGpu && (
                  <span className="warn-text small">GPU resizing (scale_cuda) not available: decoding on the CPU</span>
                )}
                {o.parallelHint && usable && (
                  <span className="parallel-input small">
                    Episodes at once
                    <input
                      type="number"
                      min={1}
                      max={MAX_PARALLEL}
                      value={parallel}
                      disabled={value !== o.value}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onParallelChange(clampParallel(e.target.value))}
                    />
                    <span className="muted">
                      1–{MAX_PARALLEL} · {o.parallelHint}
                    </span>
                  </span>
                )}
              </span>
            </label>
          )
        })}
      </div>
    </section>
  )
}
