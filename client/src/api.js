/** Cloudflare credentials (from localStorage) sent to our local server as headers. */
export function r2Headers(settings) {
  return {
    'X-R2-Account': settings.account || '',
    'X-R2-Access-Key-Id': settings.accessKeyId || '',
    'X-R2-Secret-Access-Key': settings.secretAccessKey || '',
    'X-R2-Bucket': settings.bucket || '',
  }
}

async function request(method, url, body, extraHeaders) {
  let res
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw Object.assign(new Error('Cannot reach the server. Is it running?'), { status: 0 })
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status })
  }
  return data
}

export const api = {
  createJob: (folderName, files, drama, encoder, parallel) =>
    request('POST', '/api/jobs', { folderName, files, drama, encoder, parallel }),
  getJob: (id) => request('GET', `/api/jobs/${id}`),
  finalize: (id) => request('POST', `/api/jobs/${id}/finalize`),
  removeJob: (id) => request('DELETE', `/api/jobs/${id}`),
  startR2Upload: (id, settings, prefix, skipExisting) =>
    request('POST', `/api/jobs/${id}/r2`, { prefix, skipExisting }, r2Headers(settings)),
  cancelR2Upload: (id) => request('DELETE', `/api/jobs/${id}/r2`),

  /** Upload one file with progress (fetch can't report upload progress, XHR can). */
  uploadFile(jobId, fileId, file, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/jobs/${jobId}/files/${fileId}`)

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
      }
      xhr.onload = () => {
        let data = {}
        try {
          data = JSON.parse(xhr.responseText)
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data)
        else reject(Object.assign(new Error(data.error || `Upload failed (${xhr.status})`), { status: xhr.status }))
      }
      xhr.onerror = () => reject(Object.assign(new Error('Network error while uploading'), { status: 0 }))
      xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }))

      if (signal) {
        if (signal.aborted) return reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }))
        signal.addEventListener('abort', () => xhr.abort(), { once: true })
      }

      const form = new FormData()
      form.append('file', file, file.name)
      xhr.send(form)
    })
  },
}

const pathQuery = (p) => `?path=${encodeURIComponent(p || '')}`

/** Browse and delete inside the server's downloads folder. */
export const folders = {
  list: (path) => request('GET', `/api/folders${pathQuery(path)}`),
  remove: (path) => request('DELETE', `/api/folders${pathQuery(path)}`),
}

/** Move the top-level MP4s of the downloads folder into a named folder. */
export const move = {
  preview: () => request('GET', '/api/move'),
  run: (drama, files) => request('POST', '/api/move', { drama, files }),
}

/** Folders in the server's downloads folder: MP4 folders to convert, converted folders to upload. */
export const library = {
  list: () => request('GET', '/api/library'),
  convert: (folder, files, encoder, parallel) =>
    request('POST', '/api/library/convert', { folder, files, encoder, parallel }),
  upload: (id, settings, { prefix, skipExisting } = {}) =>
    request('POST', `/api/library/${encodeURIComponent(id)}/upload`, { prefix, skipExisting }, r2Headers(settings)),
  cancelUpload: (id) => request('DELETE', `/api/library/${encodeURIComponent(id)}/upload`),
  verify: (id, settings) => request('GET', `/api/library/${encodeURIComponent(id)}/verify`, undefined, r2Headers(settings)),
}

/** Cut frames tab: cut the first frames of every video in a folder, in place, before converting. */
export const cut = {
  get: () => request('GET', '/api/cut'),
  folder: (folder) => request('POST', '/api/cut', { folder }),
  all: () => request('POST', '/api/cut/all'),
  resume: () => request('POST', '/api/cut/resume'),
  cancelAll: () => request('POST', '/api/cut/cancel-all'),
  cancel: (folder) => request('DELETE', `/api/cut?folder=${encodeURIComponent(folder)}`),
  episodes: (folder) => request('GET', `/api/cut/episodes?folder=${encodeURIComponent(folder)}`),
  /** JPEG of frame n (0-based); `version` (the file's modified time) makes a cut file load fresh. */
  frameUrl: (folder, file, n, version) =>
    `/api/cut/frame?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}&n=${n}&v=${version}`,
}

/** Auto convert: every folder with a drama.json, one after another, paused on the first error. */
export const auto = {
  get: () => request('GET', '/api/auto'),
  start: (encoder, parallel) => request('POST', '/api/auto/start', { encoder, parallel }),
  stop: () => request('POST', '/api/auto/stop'),
  skip: (folder) => request('POST', '/api/auto/skip', { folder }),
}

export const r2 = {
  test: (settings) => request('POST', '/api/r2/test', undefined, r2Headers(settings)),
  series: (settings) => request('GET', '/api/r2/series', undefined, r2Headers(settings)),
  existing: (settings, prefix) =>
    request('GET', `/api/r2/existing?prefix=${encodeURIComponent(prefix)}`, undefined, r2Headers(settings)),

  /** Upload one file to bucket/key through the local server, with progress. */
  putObject(settings, key, file, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `/api/r2/object?key=${encodeURIComponent(key)}`)
      for (const [name, value] of Object.entries(r2Headers(settings))) xhr.setRequestHeader(name, value)
      // Raw bytes; the server picks the real Content-Type from the file extension
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')

      xhr.upload.onprogress = (e) => onProgress?.(e.loaded)
      xhr.onload = () => {
        let data = {}
        try {
          data = JSON.parse(xhr.responseText)
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data)
        else reject(Object.assign(new Error(data.error || `Upload failed (${xhr.status})`), { status: xhr.status }))
      }
      xhr.onerror = () =>
        reject(Object.assign(new Error('Cannot reach the local server. Is it running?'), { status: 0 }))
      xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }))

      if (signal) {
        if (signal.aborted) return reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }))
        signal.addEventListener('abort', () => xhr.abort(), { once: true })
      }
      xhr.send(file)
    })
  },
}
