async function request(method, url, body) {
  let res
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
  createJob: (folderName, files) => request('POST', '/api/jobs', { folderName, files }),
  getJob: (id) => request('GET', `/api/jobs/${id}`),
  finalize: (id) => request('POST', `/api/jobs/${id}/finalize`),
  removeJob: (id) => request('DELETE', `/api/jobs/${id}`),
  downloadUrl: (id) => `/api/jobs/${id}/download`,

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
