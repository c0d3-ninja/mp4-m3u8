import { MAX_PARALLEL, clampParallel } from '../utils.js'

const OPTIONS = [
  { value: 'hardware', label: 'Hardware', hint: 'Mac media engine · ~2.5× faster, CPU stays free' },
  { value: 'software', label: 'Software', hint: 'x264 on the CPU · slightly better quality for the size' },
]

/**
 * Convert tab: hardware or software video encoding. The choice is saved in this browser and sent with each Convert /
 * Start click; changing it later never affects a conversion that is already running.
 */
export default function EncoderChoice({ value, onChange, parallel, onParallelChange }) {
  return (
    <section className="card encoder-choice">
      <div>
        <p className="eyebrow">Encoding</p>
        <p className="muted small">Used for the next conversion you start. Running conversions keep their own.</p>
      </div>
      <div className="encoder-options" role="radiogroup" aria-label="Video encoding">
        {OPTIONS.map((o) => (
          <label key={o.value} className={`encoder-option ${value === o.value ? 'selected' : ''}`}>
            <input
              type="radio"
              name="encoder"
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span>
              <strong>{o.label}</strong>
              <span className="muted small">{o.hint}</span>
              {o.value === 'software' && (
                <span className="parallel-input small">
                  Episodes at once
                  <input
                    type="number"
                    min={1}
                    max={MAX_PARALLEL}
                    value={parallel}
                    disabled={value !== 'software'}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onParallelChange(clampParallel(e.target.value))}
                  />
                  <span className="muted">1–{MAX_PARALLEL} · the CPU is shared between them</span>
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
    </section>
  )
}
