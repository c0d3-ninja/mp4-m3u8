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

  if (payload?.action === 'download') {
    // Content scripts can't download cross-origin images (the CDN ignores <a download>), so the worker does it.
    const url = String(payload.url || '')
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'No poster URL' }
    const ext = url.match(/\.(jpe?g|png|webp|avif|gif|heic)(?:[?#]|$)/i)?.[1]?.toLowerCase() || 'jpg'
    const base = String(payload.name || 'poster').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'poster'
    const id = await chrome.downloads.download({ url, filename: `${base}.${ext}`, conflictAction: 'uniquify' })
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
