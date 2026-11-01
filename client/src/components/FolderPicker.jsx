import { useEffect, useRef } from 'react'

export default function FolderPicker({ onSelect, children, className = 'btn btn-primary btn-lg' }) {
  const inputRef = useRef(null)

  useEffect(() => {
    // Set via the DOM so React doesn't drop the non-standard attributes
    inputRef.current.setAttribute('webkitdirectory', '')
    inputRef.current.setAttribute('directory', '')
  }, [])

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onSelect(e.target.files)
          e.target.value = '' // allow picking the same folder again
        }}
      />
      <button type="button" className={className} onClick={() => inputRef.current.click()}>
        {children}
      </button>
    </>
  )
}
