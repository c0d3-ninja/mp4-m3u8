// On https://gemini.google.com/app (also /u/<n>/app and open chats), shows a card that builds a poster-redesign
// prompt from a drama in ~/Desktop/dramas-next.json (its app_dramaName) and a button that puts it
// in Gemini's text box. It never sends the message.
;(() => {
  const PATH_RE = /^\/(u\/\d+\/)?app(\/|$)/
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

  const promptFor = (d) =>
    [
      `Create a brand-new movie poster based on the characters in this image. This must be a COMPLETE redesign, not an edit of the original.`,
      `KEEP the same characters exactly: same faces, facial features, skin tone, hairstyle, age and body type, so they are clearly the same people. Do not change, swap, add or remove any character.`,
      `CHANGE everything else: new poses and body positions, new camera angle and framing, new composition and layout, new background and setting, new lighting and color grading. Do NOT reuse or copy any pose, crop or arrangement from the original image.`,
      `Text: remove ALL text from the original. The only text on the new poster is the title "${d.app_dramaName || d.dramaName || ''}", spelled exactly like that.`,
      `Title font: ${pick(FONTS)}. Do NOT reuse the original poster's font or any font you used before.`,
      `Title position: ${pick(PLACES)}. Do NOT put the title where the original title was or where you placed it before.`,
      `No other text anywhere: no tagline, subtitle, description, names, credits, dates, episode numbers, logos, watermarks or captions.`,
      `Vertical 3:4 poster, cinematic, high quality.`,
    ].join(' ')

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

  // Gemini's prompt box is a Quill editor (contenteditable) inside <rich-textarea>.
  function findEditor() {
    return (
      document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
      document.querySelector('.ql-editor[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]')
    )
  }

  // Replace the box's text the way typing would, so Gemini's own state (and its Send button) updates.
  function putInEditor(editor, text) {
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    if (!document.execCommand('insertText', false, text)) {
      editor.textContent = text
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    }
    return editor.textContent.trim() === text.trim()
  }

  let entries = []

  // Gemini's CSP blocks TikTok's image CDN, so posters come from the background worker as data: URLs,
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
      el('strong', { text: 'Poster prompt' }),
      el('span', {}, [reload, toggle]),
    ])
    const body = el('div', { class: 'dj-body' }, [
      list,
      el('label', { class: 'dj-field' }, [el('span', { text: 'Prompt (for the highlighted drama, editable)' }), prompt]),
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
      if (selected !== String(d.id)) prompt.value = promptFor(d) // keep your edits while it stays selected
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
      if (!editor) return setStatus("Couldn't find Gemini's text box on this page", 'dj-err')
      putInEditor(editor, text)
        ? setStatus('Put in the text box (not sent). Attach the poster and press Send.', 'dj-ok')
        : setStatus('Tried to fill the text box — check it before sending.', 'dj-err')
    }

    function row(d) {
      const id = String(d.id)
      const title = d.app_dramaName || d.dramaName || '(untitled)'
      const thumb = d.posterImageUrl
        ? el('a', { href: d.posterImageUrl, target: '_blank', rel: 'noopener', title: 'Open poster' }, [
            loadThumb(el('img', { class: 'dj-thumb', alt: '' }), d.posterImageUrl),
          ])
        : el('span', { class: 'dj-thumb' })
      const btn = el('button', { class: 'dj-put', type: 'button', text: 'Put in Gemini' })
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
        ]),
        el('span', { class: 'dj-btns' }, [btn, dl]),
      ])
      li.addEventListener('click', (e) => {
        if (!e.target.closest('a, button')) select(id)
      })
      btn.addEventListener('click', () => put(id))
      return li
    }

    async function load() {
      setStatus('Loading dramas-next.json…')
      const r = await send({ action: 'list' })
      if (!r?.ok) return setStatus('Error: ' + (r?.error || 'unknown'), 'dj-err')
      entries = r.entries || []
      list.replaceChildren(...entries.map(row))
      if (!entries.length) return setStatus(`No dramas in ${r.file}`, 'dj-err')
      setStatus(`${entries.length} dramas`)
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

  // Gemini is a single-page app: keep the card while on /app pages.
  function tick() {
    const card = document.getElementById(CARD_ID)
    if (!PATH_RE.test(location.pathname)) return card?.remove()
    if (!card && document.body) renderCard()
  }
  setInterval(tick, 1000)
  tick()
})()
