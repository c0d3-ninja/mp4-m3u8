import { useEffect, useRef } from 'react'
import { formatBytes } from '../utils.js'

export default function FileList({ items, selected, onToggle, onToggleAll }) {
  const allRef = useRef(null)
  const count = items.filter((i) => selected.has(i.key)).length
  const all = count === items.length
  const none = count === 0

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = !all && !none
  }, [all, none])

  return (
    <div className="list">
      <label className="list-head">
        <input ref={allRef} type="checkbox" checked={all} onChange={() => onToggleAll(!all)} />
        <span>{all ? 'Deselect all' : 'Select all'}</span>
        <span className="muted">{items.length} videos</span>
      </label>

      <ul className="rows">
        {items.map((item, index) => {
          const isSelected = selected.has(item.key)
          return (
            <li key={item.key}>
              <label className={`row selectable ${isSelected ? '' : 'off'}`}>
                <input type="checkbox" checked={isSelected} onChange={() => onToggle(item.key)} />
                <span className="num">{index + 1}</span>
                <span className="name" title={item.relativePath}>
                  {item.relativePath}
                </span>
                <span className="muted size">{formatBytes(item.size)}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
