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

  return callHost(payload)
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'dramas-json') return false
  handle(msg.payload)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }))
  return true // async response
})
