import path from 'node:path'

/**
 * Missing episode numbers in a series, from its file names: "EP01.mp4", "Episode 7.mp4", "S1/E12.mp4" → 1, 7, 12.
 * The episode number is the last number in the file name. Returns ranges like [[6, 15]], or [] when nothing is
 * missing or the names aren't numbered consistently (fewer than 2 numbered files, or duplicates).
 * Same logic as episodeGaps() in client/src/utils.js.
 */
export function episodeGaps(names) {
  const numbers = []
  for (const name of names) {
    const base = path.posix.basename(String(name)).replace(/\.[^.]+$/, '')
    const match = base.match(/(\d+)(?!.*\d)/)
    if (match) numbers.push(Number(match[1]))
  }
  if (numbers.length < 2 || new Set(numbers).size !== numbers.length) return []
  const have = new Set(numbers)
  const max = Math.max(...numbers)
  // More numbers missing than present: the numbers aren't episode numbers (a year, an id…), so don't guess
  if (max - numbers.length > numbers.length) return []
  const gaps = []
  for (let n = 1; n <= max; n++) {
    if (have.has(n)) continue
    const last = gaps[gaps.length - 1]
    if (last && last[1] === n - 1) last[1] = n
    else gaps.push([n, n])
  }
  return gaps
}
