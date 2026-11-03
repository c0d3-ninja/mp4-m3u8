import { useEffect, useState } from 'react'

/** A drama id with a Copy button that briefly shows "Copied". */
export default function CopyId({ id }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return undefined
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
    } catch {
      window.prompt('Copy this id:', id)
    }
  }

  return (
    <span className="copy-id">
      <code>{id}</code>
      <button type="button" className="btn btn-ghost btn-xs" onClick={copy} title="Copy id">
        {copied ? '✓ Copied' : '📋 Copy'}
      </button>
    </span>
  )
}
