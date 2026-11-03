// Relays requests from the content script to the native host, which owns ~/Desktop/dramas-next.json.
const HOST = 'com.mp4m3u8.dramas_json'

function callHost(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error:
              chrome.runtime.lastError.message +
              ' (did you run extension/native-host/install.sh and restart the browser?)',
          })
        } else {
          resolve(response || { ok: false, error: 'Empty response from native host' })
        }
      })
    } catch (e) {
      resolve({ ok: false, error: String(e) })
    }
  })
}

// Make sure the file exists whenever the browser / extension starts.
const ensure = () => callHost({ action: 'ensure' }).then((r) => console.log('[dramas-json] ensure:', r))
chrome.runtime.onInstalled.addListener(ensure)
chrome.runtime.onStartup.addListener(ensure)

// The extension also keeps its own record of saved dramas (chrome.storage.local, key "saved": { [id]: entry+savedAt }),
// so it can tell "already saved" even if the native host is unavailable.
async function getSaved() {
  const { saved } = await chrome.storage.local.get('saved')
  return saved || {}
}

// Chrome ignores the `filename` given to chrome.downloads.download() when the extension also has an
// onDeterminingFilename listener (it saved "download.json" in Downloads instead). So our own downloads go through
// ownDownload(), and the listener below suggests the name remembered here (by URL).
const ownNames = new Map() // url -> { filename, conflictAction }

async function ownDownload({ url, filename, conflictAction = 'uniquify' }) {
  ownNames.set(url, { filename, conflictAction })
  try {
    return await chrome.downloads.download({ url, filename, conflictAction, saveAs: false })
  } finally {
    setTimeout(() => ownNames.delete(url), 60_000)
  }
}

const thumbs = new Map() // poster URL -> Promise<data URL>, while the worker is alive

async function makeThumb(url, width) {
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!res.ok) throw new Error(`Poster HTTP ${res.status}${res.status === 403 ? ' (link expired?)' : ''}`)
  const bitmap = await createImageBitmap(await res.blob())
  const height = Math.round((bitmap.height * width) / bitmap.width) || width
  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:image/jpeg;base64,${btoa(bin)}`
}

async function handle(payload) {
  if (payload?.action === 'find') {
    const id = String(payload.dramaId)
    const saved = await getSaved()
    const host = await callHost(payload)
    return {
      ok: true,
      savedLocally: saved[id] || null,
      inFile: !!(host.ok && host.exists),
      file: host.file,
      hostError: host.ok ? null : host.error,
    }
  }

  if (payload?.action === 'add') {
    const r = await callHost(payload)
    if (r.ok && payload.entry?.id) {
      const saved = await getSaved()
      const id = String(payload.entry.id)
      r.wasSavedLocally = !!saved[id]
      saved[id] = { ...payload.entry, savedAt: new Date().toISOString() }
      await chrome.storage.local.set({ saved })
    }
    return r
  }

  if (payload?.action === 'thumb') {
    // Gemini's Content-Security-Policy blocks images from TikTok's CDN, but allows data: URLs. So the worker
    // (which may fetch the CDN thanks to host_permissions) downloads the poster and returns a small JPEG data URL.
    const url = String(payload.url || '')
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'No poster URL' }
    if (!thumbs.has(url)) thumbs.set(url, makeThumb(url, Number(payload.width) || 120))
    try {
      return { ok: true, dataUrl: await thumbs.get(url) }
    } catch (e) {
      thumbs.delete(url)
      return { ok: false, error: e.message }
    }
  }

  if (payload?.action === 'prepareFolder') return prepareFolder(payload.entry)

  if (payload?.action === 'download') {
    // Content scripts can't download cross-origin images (the CDN ignores <a download>), so the worker does it.
    const url = String(payload.url || '')
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'No poster URL' }
    const ext = url.match(/\.(jpe?g|png|webp|avif|gif|heic)(?:[?#]|$)/i)?.[1]?.toLowerCase() || 'jpg'
    const base = String(payload.name || 'poster').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'poster'
    const id = await ownDownload({ url, filename: `${base}.${ext}` })
    return { ok: true, id, filename: `${base}.${ext}` }
  }

  return callHost(payload)
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'dramas-json') return false
  handle(msg.payload)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }))
  return true // async response
})

// ---- DramaSave: a download folder per drama ----
// "Paste link" on dramasave.app creates Downloads/<folder>/drama.json (the drama's whole entry from dramas-next.json)
// and remembers <folder>. Every download that then comes from dramasave.app is saved into Downloads/<folder>/.
// Downloads from any other site are left alone. Chrome only lets extensions choose a path inside Downloads.
const FOLDER_KEY = 'dramaSaveFolder' // chrome.storage.local: { folder, id, dramaName, at }

/**
 * "  I Raised Two Sons, But One Betrayed Me! " -> "I-Raised-Two-Sons-But-One-Betrayed-Me": letters and numbers only,
 * every other character removed, spaces -> "-". Same as folderSlug() in server/src/routes/move.js.
 */
function folderSlug(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function prepareFolder(entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'No drama' }
  const name = [entry.app_dramaName, entry.dramaName].find((v) => typeof v === 'string' && v.trim()) || ''
  const folder = folderSlug(name)
  if (!folder) return { ok: false, error: 'The drama has no app_dramaName / dramaName to name the folder after' }
  const json = JSON.stringify(entry, null, 2) + '\n'
  await ownDownload({
    url: 'data:application/json;charset=utf-8,' + encodeURIComponent(json),
    filename: `${folder}/drama.json`, // Chrome creates the folder
    conflictAction: 'overwrite',
  })
  await chrome.storage.local.set({
    [FOLDER_KEY]: { folder, id: String(entry.id ?? ''), dramaName: name, at: new Date().toISOString() },
  })
  return { ok: true, folder }
}

const isDramaSave = (u) => {
  try {
    const host = new URL(String(u || '').replace(/^blob:/, '')).hostname
    return host === 'dramasave.app' || host.endsWith('.dramasave.app')
  } catch {
    return false
  }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // Our own downloads (drama.json, posters): the name we asked for. Other sites keep Chrome's default.
  if (item.byExtensionId === chrome.runtime.id) {
    const own = ownNames.get(item.url)
    if (own) suggest(own)
    return
  }
  if (![item.url, item.finalUrl, item.referrer].some(isDramaSave)) return
  chrome.storage.local
    .get(FOLDER_KEY)
    .then(({ [FOLDER_KEY]: target }) => {
      if (!target?.folder) return suggest()
      const base = String(item.filename || 'download').split(/[\\/]/).pop()
      suggest({ filename: `${target.folder}/${base}`, conflictAction: 'uniquify' })
    })
    .catch(() => suggest())
  return true // suggest() is called asynchronously
})
