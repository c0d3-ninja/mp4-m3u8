import { formatGaps, gapCount } from '../utils.js'

/** "Missing episodes 6–15 …" warning, shown wherever a series is listed. Renders nothing when there are no gaps. */
export default function MissingEpisodes({ gaps, inline = false, children }) {
  if (!gaps?.length) return null
  const text = `Missing ${gapCount(gaps) === 1 ? 'episode' : 'episodes'} ${formatGaps(gaps)}`
  if (inline) return <span className="warn-text"> · {text.toLowerCase()}</span>
  return (
    <p className="banner warn">
      <span>
        <strong>{text}</strong>
        {children ? <> · {children}</> : null}
      </span>
    </p>
  )
}
