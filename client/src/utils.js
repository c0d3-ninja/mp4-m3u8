export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi']

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export const naturalCompare = (a, b) => collator.compare(a, b)

/** Same normalisation the server applies, so paths can be matched back to File objects. */
export function normalizePath(p) {
  return String(p)
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
}

const extensionOf = (name) => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i).toLowerCase() : ''
}

/**
 * Turn the FileList from <input webkitdirectory> into { folderName, items }.
 * Keeps video files only and skips hidden/system files such as ".DS_Store" or "._Episode 1.mp4".
 */
export function readFolderSelection(fileList) {
  const all = Array.from(fileList || [])
  if (all.length === 0) return null

  const firstPath = all[0].webkitRelativePath || all[0].name
  const folderName = firstPath.includes('/') ? firstPath.split('/')[0] : 'Videos'

  const items = []
  let dramaFile = null // "<folder>/drama.json" written by the Move tab
  for (const file of all) {
    const full = file.webkitRelativePath || file.name
    const parts = full.split('/')
    if (full.includes('/')) parts.shift() // drop the selected folder itself
    if (parts.length === 0 || parts.some((p) => p.startsWith('.'))) continue
    if (parts.length === 1 && parts[0] === 'drama.json') {
      dramaFile = file
      continue
    }
    if (!VIDEO_EXTENSIONS.includes(extensionOf(parts[parts.length - 1]))) continue

    const relativePath = normalizePath(parts.join('/'))
    items.push({ key: relativePath, relativePath, file, size: file.size })
  }
  items.sort((a, b) => naturalCompare(a.relativePath, b.relativePath))

  return { folderName, items, totalFiles: all.length, dramaFile }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

export function formatDuration(seconds) {
  const s = Math.round(seconds || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export const percent = (p) => `${Math.floor((p || 0) * 100)}%`

/** URL of a file inside a job's HLS output, with every path segment encoded. */
export function hlsUrl(job, outputPath, fileName) {
  const encoded = outputPath.split('/').map(encodeURIComponent).join('/')
  return `${job.hlsBaseUrl}/${encoded}/${encodeURIComponent(fileName)}`
}

const JOB_KEY = 'mp4-m3u8:jobId'
export const storedJobId = {
  get() {
    try {
      return localStorage.getItem(JOB_KEY)
    } catch {
      return null
    }
  },
  set(id) {
    try {
      localStorage.setItem(JOB_KEY, id)
    } catch {
      /* ignore */
    }
  },
  clear() {
    try {
      localStorage.removeItem(JOB_KEY)
    } catch {
      /* ignore */
    }
  },
}

// ---------- Cloudflare R2 ----------

const R2_KEY = 'mp4-m3u8:r2'
export const DEFAULT_R2 = { account: '', accessKeyId: '', secretAccessKey: '', bucket: 'dramas', publicUrl: '' }

/** Credentials are saved in this browser only (localStorage on this Mac). */
export const r2Store = {
  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(R2_KEY) || 'null')
      return saved && typeof saved === 'object' ? { ...DEFAULT_R2, ...saved } : { ...DEFAULT_R2 }
    } catch {
      return { ...DEFAULT_R2 }
    }
  },
  save(settings) {
    try {
      localStorage.setItem(R2_KEY, JSON.stringify(settings))
      return true
    } catch {
      return false
    }
  },
  clear() {
    try {
      localStorage.removeItem(R2_KEY)
    } catch {
      /* ignore */
    }
  },
}

export const isR2Configured = (s) => Boolean(s?.account && s?.accessKeyId && s?.secretAccessKey && s?.bucket)

/** "https://pub-x.r2.dev/" -> "https://pub-x.r2.dev" ("" when not set or invalid). */
export function normalizePublicUrl(value) {
  const v = String(value || '')
    .trim()
    .replace(/\/+$/, '')
  if (!v) return ''
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`
  try {
    const url = new URL(withScheme)
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

/** Public URL of an object, every path segment encoded ("My Drama" -> "My%20Drama"). */
export function publicObjectUrl(settings, ...parts) {
  const base = normalizePublicUrl(settings.publicUrl)
  if (!base) return ''
  const path = parts.join('/').split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return `${base}/${path}`
}

/** Same as the server: a bucket "folder" without empty or ".." parts. */
export function cleanPrefix(prefix) {
  return String(prefix || '')
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/')
}

/** Segments first, then master playlists, then manifest.json + drama.json (see server/src/services/r2.js). */
export function uploadRank(relativePath) {
  if (relativePath === 'manifest.json' || relativePath === 'drama.json') return 2
  if (relativePath.split('/').pop() === 'master.m3u8') return 1
  return 0
}

/**
 * Read a converted series folder chosen with <input webkitdirectory>.
 * Handles "Downloads/My Drama/My Drama/..." style double folders from unzipping.
 */
export function readUploadFolder(fileList) {
  const all = Array.from(fileList || [])
  if (all.length === 0) return null

  let folderName = (all[0].webkitRelativePath || all[0].name).split('/')[0]
  let entries = []
  for (const file of all) {
    const parts = (file.webkitRelativePath || file.name).split('/')
    if (parts.length > 1) parts.shift()
    if (parts.length === 0 || parts.some((p) => !p || p.startsWith('.'))) continue // .DS_Store, ._files
    entries.push({ parts, file })
  }
  if (entries.length === 0) return { folderName, files: [], episodes: 0, hasManifest: false, totalBytes: 0 }

  // A converter output folder "<uuid>/" holds drama.json next to "drama/" (the series with manifest.json).
  // Upload the series from inside drama/, with drama.json beside manifest.json.
  const dramaJson = entries.find((e) => e.parts.length === 1 && e.parts[0] === 'drama.json')
  const seriesInDrama = entries.some((e) => e.parts.length === 2 && e.parts[0] === 'drama' && e.parts[1] === 'manifest.json')
  if (dramaJson && seriesInDrama) {
    entries = entries
      .filter((e) => e.parts.length > 1 && e.parts[0] === 'drama')
      .map((e) => ({ ...e, parts: e.parts.slice(1) }))
    entries.push(dramaJson)
  }

  // If the series sits one level down (e.g. "Downloads/My Drama/My Drama/manifest.json"), step into it.
  // Only when that sub-folder holds the manifest, so a single-episode folder is never mistaken for it.
  for (let i = 0; i < 3; i++) {
    const first = entries[0].parts[0]
    const allInside = entries.every((e) => e.parts.length > 1 && e.parts[0] === first)
    const manifestInside = entries.some((e) => e.parts.length === 2 && e.parts[1] === 'manifest.json')
    if (!allInside || !manifestInside) break
    folderName = first
    entries = entries.map((e) => ({ ...e, parts: e.parts.slice(1) }))
  }

  const files = entries
    .map(({ parts, file }) => ({ relativePath: parts.join('/'), file, size: file.size }))
    .sort((a, b) => naturalCompare(a.relativePath, b.relativePath))

  return {
    folderName,
    files,
    episodes: files.filter((f) => f.relativePath.split('/').pop() === 'master.m3u8').length,
    hasManifest: files.some((f) => f.relativePath === 'manifest.json'),
    hasDramaJson: files.some((f) => f.relativePath === 'drama.json'),
    totalBytes: files.reduce((s, f) => s + f.size, 0),
  }
}

/**
 * Move tab folder name: "  Love's  Story Vol.2 " -> "Loves-Story-Vol2" (apostrophes and dots removed,
 * each run of spaces -> one "-"). Same as folderSlug() in server/src/routes/move.js.
 */
export function folderSlug(value) {
  return String(value ?? '')
    .replace(/['\u2018\u2019.]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** Last category written by the Move tab, kept in this browser so it survives a refresh. */
const CATEGORY_KEY = 'mp4-m3u8:lastCategory'
export const storedCategory = {
  get() {
    try {
      return localStorage.getItem(CATEGORY_KEY) || ''
    } catch {
      return ''
    }
  },
  set(value) {
    try {
      if (value) localStorage.setItem(CATEGORY_KEY, value)
      else localStorage.removeItem(CATEGORY_KEY)
    } catch {
      /* storage blocked: it just won't be remembered */
    }
  },
}

/**
 * Missing episode numbers from file or folder names ("EP01.mp4", "Episode 7", "S1/E12.mp4"): the episode number is the
 * last number in the name. Returns ranges like [[6, 15]]; [] when nothing is missing or the names don't look like a
 * numbered series. Same logic as server/src/services/episodes.js.
 */
export function episodeGaps(names) {
  const numbers = []
  for (const name of names) {
    const base = String(name).split('/').pop().replace(/\.[^.]+$/, '')
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

/** [[6, 15], [20, 20]] -> "6–15, 20" (missing episode numbers from the server). */
export function formatGaps(gaps) {
  return (gaps || []).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')
}

/** How many episodes the gaps cover: [[6, 15]] -> 10 */
export const gapCount = (gaps) => (gaps || []).reduce((n, [a, b]) => n + b - a + 1, 0)

const TAB_KEY = 'mp4-m3u8:tab'
export const storedTab = {
  get() {
    try {
      return localStorage.getItem(TAB_KEY) || 'move'
    } catch {
      return 'move'
    }
  },
  set(tab) {
    try {
      localStorage.setItem(TAB_KEY, tab)
    } catch {
      /* ignore */
    }
  },
}
