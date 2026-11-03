// Card listing the dramas in ~/Desktop/dramas-next.json (poster + title):
//  - Gemini (https://gemini.google.com/app, also /u/<n>/app) and ChatGPT (https://chatgpt.com/): a button puts a
//    poster-redesign prompt in the site's text box (never sent).
//  - DramaSave (https://dramasave.app/): a button pastes the drama's link into the URL box, and clicking the site's
//    "Download Full Series" marks that drama as downloaded (chrome.storage.local "downloaded": { [id]: iso date }).
//    Every card shows a "Downloaded" label for those.
;(() => {
  const SITES = {
    'gemini.google.com': {
      name: 'Gemini',
      path: /^\/(u\/\d+\/)?app(\/|$)/,
      // Quill editor (contenteditable) inside <rich-textarea>
      editor: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]'],
    },
    'chatgpt.com': {
      name: 'ChatGPT',
      path: /^\//,
      // ProseMirror editor (contenteditable) with id prompt-textarea; older builds used a <textarea>
      editor: ['#prompt-textarea[contenteditable="true"]', 'div.ProseMirror[contenteditable="true"]', 'textarea#prompt-textarea'],
    },
    'dramasave.app': {
      name: 'DramaSave',
      path: /^\//,
      mode: 'link',
      input: '#targetInput',
      resolve: '#btnResolve', // "Resolve Episodes"
      downloadAll: '#btnDownloadBatch', // "Download Full Series (N EPs)", shown after Resolve Episodes
    },
    'localhost:5173': {
      name: 'Move tab',
      path: /^\//,
      mode: 'json',
      input: 'textarea#move-json', // the mp4-m3u8 app's Move tab: drama JSON field
    },
  }
  const SITE = SITES[location.host] || SITES[location.hostname]
  if (!SITE) return
  const LINK_MODE = SITE.mode === 'link'
  const JSON_MODE = SITE.mode === 'json'
  const PROMPT_MODE = !LINK_MODE && !JSON_MODE
  const DOWNLOADED_KEY = 'downloaded'
  const CARD_ID = 'dramas-json-card'
  const PICK_KEY = 'gemini-picked-drama' // chrome.storage.local: id of the last drama used
  const POS_KEY = 'dramas-json-gemini-card-pos'

  // Gemini drifts to the same font and title spot every time, so each prompt names a different, random style and
  // placement (picked again whenever you select a drama).
  const FONTS = [
    'elegant high-contrast serif with gold foil',
    'bold condensed sans-serif in all caps',
    'flowing handwritten brush script',
    'sharp metallic chrome lettering',
    'glowing neon tube lettering',
    'ornate vintage engraved lettering',
    'cracked, distressed grunge lettering',
    'thin, wide-spaced luxury fashion typography',
    'heavy 3D extruded block letters',
    'fiery lettering with glowing embers',
    'icy frosted lettering with crystals',
    'dripping blood-red thriller lettering',
    'romantic calligraphy with swashes',
    'gothic blackletter',
    'modern geometric minimalist sans-serif',
    'torn paper cut-out lettering',
    'royal gold lettering with jewels',
    'smoky lettering dissolving into mist',
  ]
  const PLACES = [
    'across the very top of the poster',
    'at the bottom of the poster',
    'vertically along the left edge',
    'vertically along the right edge',
    'diagonally across the lower third',
    'in the middle, between the characters',
    'stacked in the top-left corner',
    'stacked in the bottom-right corner',
    'large and partly behind the characters, filling the background',
    'centered just above the bottom edge in a wide banner',
    'split over two or three lines on the left side',
    'curving in an arc over the characters',
  ]
  const pick = (list) => list[Math.floor(Math.random() * list.length)]

  const clean = (t) => String(t || '').replace(/\s+/g, ' ').replace(/"/g, "'").trim()

  const promptFor = (d) => {
    const story = clean(d.app_description || d.description)
    const genre = clean(Array.isArray(d.category) ? d.category.join(', ') : d.category)
    return [
      `Create a brand-new movie poster based on the characters in this image. This must be a COMPLETE redesign, not an edit of the original.`,
      story &&
        `STORY (for mood only, NEVER write any of it on the poster): "${story}"` + (genre ? ` Genre: ${genre}.` : ''),
      `Match the poster's vibe to this story: its genre, emotion, setting, era, clothing, props and color mood must fit it. Keep it realistic and grounded like a live-action drama; do NOT add fantasy, magic, sci-fi or supernatural elements unless the story itself is about them.`,
      `KEEP the same characters exactly: same faces, facial features, skin tone, hairstyle, age and body type, so they are clearly the same people. Do not change, swap, add or remove any character.`,
      `CHANGE everything else: new poses and body positions, new camera angle and framing, new composition and layout, new background and setting, new lighting and color grading. Do NOT reuse or copy any pose, crop or arrangement from the original image.`,
      `Text: remove ALL text from the original. The only text on the new poster is the title "${d.app_dramaName || d.dramaName || ''}", spelled exactly like that.`,
      `Title font: ${pick(FONTS)}, adapted to fit the story's mood. Do NOT reuse the original poster's font or any font you used before.`,
      `Title position: ${pick(PLACES)}. Do NOT put the title where the original title was or where you placed it before.`,
      `STRICTLY no other text anywhere: do NOT write the story, description, genre or any words from them; no tagline, subtitle, quote, names, credits, dates, episode numbers, logos, watermarks or captions. Only the title.`,
      `Vertical 3:4 poster, cinematic, high quality.`,
    ]
      .filter(Boolean)
      .join(' ')
  }

  const send = (payload) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'dramas-json', payload }, (r) =>
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r),
        )
      } catch (e) {
        resolve({ ok: false, error: 'Extension was reloaded — refresh this page. ' + e.message })
      }
    })

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v
      else n.setAttribute(k, v)
    }
    for (const c of children) n.append(c)
    return n
  }

  function placeCard(card, left, top) {
    card.style.left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - card.offsetWidth)) + 'px'
    card.style.top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - 40)) + 'px'
    card.style.right = 'auto'
    card.style.bottom = 'auto'
  }
  function makeDraggable(card, handle) {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (saved) requestAnimationFrame(() => placeCard(card, saved.left, saved.top))
    } catch {}
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, select')) return
      e.preventDefault()
      const rect = card.getBoundingClientRect()
      const dx = e.clientX - rect.left
      const dy = e.clientY - rect.top
      handle.setPointerCapture(e.pointerId)
      card.classList.add('dj-dragging')
      const move = (ev) => placeCard(card, ev.clientX - dx, ev.clientY - dy)
      const up = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
        card.classList.remove('dj-dragging')
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ left: parseFloat(card.style.left), top: parseFloat(card.style.top) }))
        } catch {}
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    })
  }

  function findEditor() {
    for (const sel of [...SITE.editor, '[contenteditable="true"][role="textbox"]']) {
      const n = document.querySelector(sel)
      if (n) return n
    }
    return null
  }

  // Replace the box's text the way typing would, so the site's own state (and its Send button) updates.
  function putInEditor(editor, text) {
    editor.focus()
    if (editor instanceof HTMLTextAreaElement) {
      editor.select()
      if (!document.execCommand('insertText', false, text)) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, text)
        editor.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return editor.value.trim() === text.trim()
    }
    const range = document.createRange()
    range.selectNodeContents(editor)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    if (!document.execCommand('insertText', false, text)) {
      editor.textContent = text
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    }
    return editor.innerText.replace(/\s+/g, ' ').trim() === text.replace(/\s+/g, ' ').trim()
  }

  let entries = []

  // Gemini's CSP (and maybe ChatGPT's) blocks TikTok's image CDN, so posters come from the background worker as data: URLs,
  // a few at a time.
  const thumbQueue = []
  let thumbsRunning = 0
  function pumpThumbs() {
    while (thumbsRunning < 4 && thumbQueue.length) {
      const [img, url] = thumbQueue.shift()
      thumbsRunning++
      send({ action: 'thumb', url, width: 120 })
        .then((r) => {
          if (r?.ok) img.src = r.dataUrl
          else img.title = 'Poster could not load: ' + (r?.error || 'unknown')
        })
        .finally(() => {
          thumbsRunning--
          pumpThumbs()
        })
    }
  }
  function loadThumb(img, url) {
    thumbQueue.push([img, url])
    pumpThumbs()
    return img
  }

  function renderCard() {
    const status = el('div', { class: 'dj-status' })
    const list = el('ul', { class: 'dj-list' })
    const prompt = el('textarea', { class: 'dj-input', rows: '4' })
    const reload = el('button', { class: 'dj-toggle', type: 'button', title: 'Reload dramas-next.json', text: '↻' })
    const toggle = el('button', { class: 'dj-toggle', type: 'button', title: 'Collapse', text: '–' })

    const head = el('div', { class: 'dj-head', title: 'Drag to move' }, [
      el('strong', { text: PROMPT_MODE ? 'Poster prompt' : 'Dramas' }),
      el('span', {}, [reload, toggle]),
    ])
    const body = el('div', { class: 'dj-body' }, [
      list,
      ...(!PROMPT_MODE ? [] : [el('label', { class: 'dj-field' }, [el('span', { text: 'Prompt (for the highlighted drama, editable)' }), prompt])]),
      status,
    ])
    const card = el('div', { id: CARD_ID, class: 'dj-gemini' }, [head, body])
    makeDraggable(card, head)

    const setStatus = (msg, kind = '') => {
      status.textContent = msg
      status.className = 'dj-status ' + kind
    }

    let selected = null // id of the highlighted drama

    function select(id, scroll = false) {
      const d = entries.find((e) => String(e.id) === String(id))
      if (!d) return
      if (PROMPT_MODE && selected !== String(d.id)) prompt.value = promptFor(d) // keep your edits while it stays selected
      selected = String(d.id)
      chrome.storage.local.set({ [PICK_KEY]: selected })
      for (const li of list.children) {
        const on = li.dataset.id === selected
        li.classList.toggle('dj-selected', on)
        if (on && scroll) li.scrollIntoView({ block: 'nearest' })
      }
    }

    function put(id) {
      select(id)
      const text = prompt.value.trim()
      if (!text) return setStatus('The prompt is empty', 'dj-err')
      const editor = findEditor()
      if (!editor) return setStatus(`Couldn't find ${SITE.name}'s text box on this page`, 'dj-err')
      putInEditor(editor, text)
        ? setStatus('Put in the text box (not sent). Attach the poster and press Send.', 'dj-ok')
        : setStatus('Tried to fill the text box — check it before sending.', 'dj-err')
    }

    // mp4-m3u8 Move tab: put the drama's whole entry in the JSON field (a React-controlled <textarea>).
    function fillJson(id) {
      select(id)
      const d = entries.find((e) => String(e.id) === String(id))
      let box = document.querySelector(SITE.input)
      if (box && !box.offsetParent) {
        // The Move tab is hidden (another tab is open): switch to it
        ;[...document.querySelectorAll('[role="tab"]')].find((t) => /move/i.test(t.textContent))?.click()
        box = document.querySelector(SITE.input)
      }
      if (!box) return setStatus("Couldn't find the Move tab's JSON field on this page", 'dj-err')
      const text = JSON.stringify(d, null, 2)
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text)
      box.dispatchEvent(new Event('input', { bubbles: true }))
      box.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setStatus('JSON filled. Check the folder name below it and press Move.', 'dj-ok')
    }

    // ".../shortdrama/episode/<id>/1" -> ".../shortdrama/episode/<id>/<totalEpisodes>" (the episode number is replaced,
    // or added when the link has none). Unchanged when totalEpisodes is unknown.
    function linkToLastEpisode(d) {
      const total = Number(d.totalEpisodes)
      if (!Number.isInteger(total) || total < 1) return d.dramaUrl
      try {
        const url = new URL(d.dramaUrl)
        const m = url.pathname.match(/^(\/shortdrama\/episode\/\d+)(?:\/\d+)?\/?$/)
        if (!m) return d.dramaUrl
        url.pathname = `${m[1]}/${total}`
        return url.href
      } catch {
        return d.dramaUrl
      }
    }

    function pasteLink(id) {
      select(id)
      const d = entries.find((e) => String(e.id) === String(id))
      const input = document.querySelector(SITE.input)
      if (!input) return setStatus("Couldn't find the link box on this page", 'dj-err')
      if (!d?.dramaUrl) return setStatus('This drama has no dramaUrl', 'dj-err')
      const link = linkToLastEpisode(d)
      input.focus()
      input.select()
      // Native setter + input event, so the site's own script sees the new value.
      if (!document.execCommand('insertText', false, link) || input.value !== link) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, link)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      setStatus('Link pasted. Creating its download folder…')
      send({ action: 'prepareFolder', entry: d }).then((r) =>
        r?.ok
          ? setStatus(
              `Link pasted. Downloads/${r.folder}/ created with drama.json; episodes from this site will be saved there. Press Resolve Episodes.`,
              'dj-ok',
            )
          : setStatus('Link pasted, but the download folder failed: ' + (r?.error || 'unknown'), 'dj-err'),
      )
    }

    let downloaded = {}
    function showDownloaded() {
      for (const li of list.children) {
        const at = downloaded[li.dataset.id]
        const badge = li.querySelector('.dj-badge')
        badge.hidden = !at
        badge.title = at ? `Download Full Series clicked on ${new Date(at).toLocaleString()}` : ''
        li.classList.toggle('dj-done', !!at)
      }
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[DOWNLOADED_KEY]) return
      downloaded = changes[DOWNLOADED_KEY].newValue || {}
      showDownloaded()
    })

    function row(d) {
      const id = String(d.id)
      const title = d.app_dramaName || d.dramaName || '(untitled)'
      const thumb = d.posterImageUrl
        ? el('a', { href: d.posterImageUrl, target: '_blank', rel: 'noopener', title: 'Open poster' }, [
            loadThumb(el('img', { class: 'dj-thumb', alt: '' }), d.posterImageUrl),
          ])
        : el('span', { class: 'dj-thumb' })
      const btn = el('button', { class: 'dj-put', type: 'button', text: LINK_MODE ? 'Paste link' : JSON_MODE ? 'Fill JSON' : `Put in ${SITE.name}` })
      const dl = el('button', { class: 'dj-put dj-dl', type: 'button', title: 'Download the poster image', text: '⬇ Poster' })
      if (!d.posterImageUrl) dl.disabled = true
      dl.addEventListener('click', async () => {
        dl.disabled = true
        const r = await send({ action: 'download', url: d.posterImageUrl, name: `${title} - poster` })
        dl.disabled = false
        r?.ok
          ? setStatus(`Downloading ${r.filename} to your Downloads folder`, 'dj-ok')
          : setStatus('Download failed: ' + (r?.error || 'unknown'), 'dj-err')
      })
      const li = el('li', { class: 'dj-row', 'data-id': id }, [
        thumb,
        el('span', { class: 'dj-title', title: d.app_dramaName ? title : `No app_dramaName — using "${title}"` }, [
          title,
          ...(d.app_dramaName ? [] : [el('small', { text: ' (no app_dramaName)' })]),
          el('span', { class: 'dj-eps', text: d.totalEpisodes ? `${d.totalEpisodes} episodes` : 'Episodes unknown' }),
          el('span', { class: 'dj-badge', hidden: '', text: '✔ Downloaded' }),
        ]),
        el('span', { class: 'dj-btns' }, PROMPT_MODE ? [btn, dl] : [btn]),
      ])
      li.addEventListener('click', (e) => {
        if (!e.target.closest('a, button')) select(id)
      })
      btn.addEventListener('click', () => (LINK_MODE ? pasteLink(id) : JSON_MODE ? fillJson(id) : put(id)))
      return li
    }

    async function load() {
      setStatus('Loading dramas-next.json…')
      const r = await send({ action: 'list' })
      if (!r?.ok) return setStatus('Error: ' + (r?.error || 'unknown'), 'dj-err')
      entries = r.entries || []
      list.replaceChildren(...entries.map(row))
      downloaded = (await chrome.storage.local.get(DOWNLOADED_KEY))[DOWNLOADED_KEY] || {}
      showDownloaded()
      if (!entries.length) return setStatus(`No dramas in ${r.file}`, 'dj-err')
      const done = entries.filter((d) => downloaded[String(d.id)]).length
      setStatus(`${entries.length} dramas · ${done} downloaded`)
      // Highlight the last used one, else the newest entry that has app_dramaName.
      const { [PICK_KEY]: picked } = await chrome.storage.local.get(PICK_KEY)
      const fallback = [...entries].reverse().find((d) => d.app_dramaName) || entries[entries.length - 1]
      selected = null
      select(entries.some((d) => String(d.id) === picked) ? picked : fallback.id, true)
    }

    reload.addEventListener('click', load)
    toggle.addEventListener('click', () => {
      card.classList.toggle('dj-collapsed')
      toggle.textContent = card.classList.contains('dj-collapsed') ? '+' : '–'
    })

    document.body.append(card)
    load()
  }

  // DramaSave: remember which drama was resolved, and mark it downloaded when "Download Full Series" is clicked.
  // The id comes from the TikTok link ("/shortdrama/episode/<id>/..."), or an entry whose dramaUrl/id matches.
  function dramaIdFrom(value) {
    const v = String(value || '').trim()
    const m = v.match(/\/shortdrama\/episode\/(\d+)/)
    if (m) return m[1]
    const hit = entries.find((d) => d.dramaUrl === v || String(d.id) === v)
    return hit ? String(hit.id) : null
  }
  if (LINK_MODE) {
    let resolvedId = null
    const current = () => dramaIdFrom(document.querySelector(SITE.input)?.value)
    document.addEventListener(
      'submit',
      (e) => {
        if (e.target.contains?.(document.querySelector(SITE.input))) resolvedId = current()
      },
      true,
    )
    document.addEventListener(
      'click',
      async (e) => {
        if (e.target.closest?.(SITE.resolve)) {
          resolvedId = current() || resolvedId
          return
        }
        if (!e.target.closest?.(SITE.downloadAll)) return
        const id = resolvedId || current()
        if (!id) return
        const { [DOWNLOADED_KEY]: map = {} } = await chrome.storage.local.get(DOWNLOADED_KEY)
        map[id] = new Date().toISOString()
        await chrome.storage.local.set({ [DOWNLOADED_KEY]: map })
      },
      true,
    )
  }

  // The sites are single-page apps: keep the card while on a matching page.
  function tick() {
    const card = document.getElementById(CARD_ID)
    if (!SITE.path.test(location.pathname)) return card?.remove()
    if (!card && document.body) renderCard()
  }
  setInterval(tick, 1000)
  tick()
})()
