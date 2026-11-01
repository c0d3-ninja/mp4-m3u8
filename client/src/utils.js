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
  for (const file of all) {
    const full = file.webkitRelativePath || file.name
    const parts = full.split('/')
    if (full.includes('/')) parts.shift() // drop the selected folder itself
    if (parts.length === 0 || parts.some((p) => p.startsWith('.'))) continue
    if (!VIDEO_EXTENSIONS.includes(extensionOf(parts[parts.length - 1]))) continue

    const relativePath = normalizePath(parts.join('/'))
    items.push({ key: relativePath, relativePath, file, size: file.size })
  }
  items.sort((a, b) => naturalCompare(a.relativePath, b.relativePath))

  return { folderName, items, totalFiles: all.length }
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
