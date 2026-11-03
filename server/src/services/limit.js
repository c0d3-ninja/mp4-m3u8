/**
 * FIFO queue with O(1) push/shift. Array#shift is O(n), which turns a queue of
 * 100k segment files into billions of element moves.
 */
export class Queue {
  #items = []
  #head = 0

  constructor(items = []) {
    this.#items = [...items]
  }

  get length() {
    return this.#items.length - this.#head
  }

  push(item) {
    this.#items.push(item)
  }

  shift() {
    if (this.#head >= this.#items.length) return undefined
    const item = this.#items[this.#head]
    this.#items[this.#head++] = undefined
    // Compact once the consumed part dominates, so memory doesn't grow forever
    if (this.#head > 1024 && this.#head * 2 > this.#items.length) {
      this.#items = this.#items.slice(this.#head)
      this.#head = 0
    }
    return item
  }
}

/**
 * limit(fn) runs at most `max` of the given async functions at once.
 * Used for bulk fs calls so a big folder walk can't flood libuv's small thread pool
 * (which uploads and other requests share) with hundreds of thousands of queued stats.
 */
export function createLimiter(max) {
  let active = 0
  const waiting = new Queue()

  const next = () => {
    if (active >= max || waiting.length === 0) return
    active++
    const { fn, resolve, reject } = waiting.shift()
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--
        next()
      })
  }

  return (fn) =>
    new Promise((resolve, reject) => {
      waiting.push({ fn, resolve, reject })
      next()
    })
}

/** Bounded limiter shared by folder walks (Folders tab sizes, R2 upload file lists). */
export const fsLimit = createLimiter(16)
