// On https://www.tiktok.com/shortdrama/episode/<dramaId>/<ep>, shows a card with the drama's details
// (read from [data-testid="short-drama-detail"]) and an "Add to json" button that appends it to
// ~/Desktop/dramas-next.json via the background worker + native host.
;(() => {
  const URL_RE = /^\/shortdrama\/episode\/(\d+)\/(\d+)/
  const CARD_ID = 'dramas-json-card'

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

  const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '')

  // The <img> often holds a lazy-load placeholder (data:image/gif...). Collect every real http(s) URL from
  // the first <picture>/<img> (src, srcset, <source srcset>) and prefer the full-size "origin" image.
  function pickPoster(root) {
    const pic = root.querySelector('picture') || root.querySelector('img')?.parentElement
    if (!pic) return ''
    const urls = []
    const add = (u) => {
      u = (u || '').trim()
      if (/^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u)
    }
    const fromSrcset = (s) => (s || '').split(/,\s+(?=https?:)/).forEach((part) => add(part.trim().split(/\s+/)[0]))
    for (const n of pic.querySelectorAll('img, source')) {
      add(n.currentSrc)
      add(n.getAttribute('src'))
      fromSrcset(n.getAttribute('srcset'))
    }
    // Best first: the original upload ("~tplv-tiktokx-origin.image", e.g. 1049x1398 JPEG), then the largest
    // resized variant by the size in its template ("~tplv-...:240:240.avif" -> 240*240). URLs are signed,
    // so they can't be rewritten to request a bigger size.
    const score = (u) => {
      if (/~tplv-[^?]*origin/.test(u)) return 1e12
      const m = u.match(/~tplv-[^?]*?:(\d+):(\d+)/)
      return m ? Number(m[1]) * Number(m[2]) : 0
    }
    return urls.sort((a, b) => score(b) - score(a))[0] || ''
  }

  function extract() {
    const root = document.querySelector('[data-testid="short-drama-detail"]')
    if (!root) return null

    const dramaName = text(root.querySelector('h2'))

    // Category tags ("High society", "Family bonds") are the <span>s in the <div> right after the title
    // (the one without the description <p>).
    const category = []
    for (const div of root.querySelectorAll('h2 ~ div')) {
      if (div.querySelector('p, button')) continue
      for (const sp of div.querySelectorAll('span')) {
        const t = text(sp)
        if (t && !sp.querySelector('span') && !category.includes(t)) category.push(t)
      }
      if (category.length) break
    }

    // The full description is in the <p>; it is only clamped by CSS ("more" button).
    const description = text(root.querySelector('h2 ~ div p') || root.querySelector('p'))

    const posterImageUrl = pickPoster(root)

    // Episode ranges like "1-24", "25-42" -> 42. Fallback: the numbered episode buttons.
    let totalEpisodes = 0
    for (const n of root.querySelectorAll('[data-testid="tux-segment-item"], [data-testid="tux-web-text"]')) {
      const m = text(n).match(/^(\d+)\s*[-–]\s*(\d+)$/)
      if (m) totalEpisodes = Math.max(totalEpisodes, Number(m[2]))
    }
    if (!totalEpisodes) {
      for (const b of root.querySelectorAll('button')) {
        const t = text(b)
        if (/^\d+$/.test(t)) totalEpisodes = Math.max(totalEpisodes, Number(t))
      }
    }

    return { dramaName, category, description, posterImageUrl, totalEpisodes, dramaUrl: location.href }
  }

  function removeCard() {
    document.getElementById(CARD_ID)?.remove()
  }

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v
      else n.setAttribute(k, v)
    }
    for (const c of children) n.append(c)
    return n
  }

  // Drag the card by its header; the position is remembered across pages/reloads.
  const POS_KEY = 'dramas-json-card-pos'
  function placeCard(card, left, top) {
    const maxLeft = Math.max(0, window.innerWidth - card.offsetWidth)
    const maxTop = Math.max(0, window.innerHeight - 40)
    card.style.left = Math.min(Math.max(0, left), maxLeft) + 'px'
    card.style.top = Math.min(Math.max(0, top), maxTop) + 'px'
    card.style.right = 'auto'
    card.style.bottom = 'auto'
  }
  function makeDraggable(card, handle) {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (saved) requestAnimationFrame(() => placeCard(card, saved.left, saved.top))
    } catch {}
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return
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

  function renderCard(data, dramaId) {
    removeCard()
    const status = el('div', { class: 'dj-status' })
    const preview = el('img', { class: 'dj-poster', src: data.posterImageUrl, alt: '' })
    const fields = {}
    const field = (key, label, multiline = false) => {
      const input = el(multiline ? 'textarea' : 'input', { class: 'dj-input', 'data-key': key })
      input.value = Array.isArray(data[key]) ? data[key].join(', ') : String(data[key] ?? '')
      if (key === 'totalEpisodes') input.type = 'number'
      if (key === 'posterImageUrl') input.addEventListener('input', () => (preview.src = input.value))
      fields[key] = input
      return el('label', { class: 'dj-field' }, [el('span', { text: label }), input])
    }

    const addBtn = el('button', { class: 'dj-add', type: 'button', text: 'Add to json' })
    const toggle = el('button', { class: 'dj-toggle', type: 'button', title: 'Collapse', text: '–' })
    const body = el('div', { class: 'dj-body' }, [
      preview,
      field('dramaName', 'Drama name'),
      field('category', 'Category (comma separated)'),
      field('description', 'Description', true),
      field('posterImageUrl', 'posterImageUrl'),
      field('totalEpisodes', 'Total episodes'),
      field('dramaUrl', 'dramaUrl'),
      status,
    ])
    const head = el('div', { class: 'dj-head', title: 'Drag to move' }, [el('strong', { text: 'dramas-next.json' }), toggle])
    const card = el('div', { id: CARD_ID }, [head, body, addBtn])
    makeDraggable(card, head)

    toggle.addEventListener('click', () => {
      card.classList.toggle('dj-collapsed')
      toggle.textContent = card.classList.contains('dj-collapsed') ? '+' : '–'
    })

    const setStatus = (msg, kind = '') => {
      status.textContent = msg
      status.className = 'dj-status ' + kind
    }

    addBtn.addEventListener('click', async () => {
      const entry = {
        id: dramaId,
        dramaName: fields.dramaName.value.trim(),
        category: fields.category.value.split(',').map((c) => c.trim()).filter(Boolean),
        description: fields.description.value.trim(),
        posterImageUrl: fields.posterImageUrl.value.trim(),
        totalEpisodes: Number(fields.totalEpisodes.value) || 0,
        dramaUrl: fields.dramaUrl.value.trim(),
      }
      if (!entry.dramaName) return setStatus('Drama name is empty', 'dj-err')
      addBtn.disabled = true
      setStatus('Saving…')
      const r = await send({ action: 'add', entry })
      addBtn.disabled = false
      if (r?.ok) {
        setStatus(
          r.updated
            ? `Already existed — replaced id ${entry.id} with the new content (${r.count} dramas in ${r.file})`
            : `Saved — ${r.count} dramas in ${r.file}`,
          'dj-ok',
        )
        addBtn.textContent = 'Replace in json'
        card.classList.add('dj-saved')
      } else {
        setStatus('Error: ' + (r?.error || 'unknown'), 'dj-err')
      }
    })

    document.body.append(card)

    send({ action: 'find', dramaId }).then((r) => {
      if (!r?.ok) return setStatus('Error: ' + (r?.error || 'unknown'), 'dj-err')
      const local = r.savedLocally
      if (r.inFile || local) {
        card.classList.add('dj-saved')
        addBtn.textContent = 'Replace in json'
        const when = local?.savedAt ? ` on ${new Date(local.savedAt).toLocaleString()}` : ''
        const where = r.inFile ? 'in dramas-next.json' : 'by this extension (not found in the file — saving adds it again)'
        setStatus(`✔ Already saved${when} ${where}. Click to replace it with the content above.`, 'dj-ok')
      } else if (r.hostError) {
        setStatus('Not saved yet. File check failed: ' + r.hostError, 'dj-err')
      } else {
        setStatus('Not saved yet.')
      }
    })
  }

  // TikTok is a single-page app: watch the URL and the detail element.
  let shownFor = null // "<href>|<dramaName>|<totalEpisodes>"
  function tick() {
    const m = location.pathname.match(URL_RE)
    if (!m) {
      shownFor = null
      return removeCard()
    }
    const data = extract()
    if (!data || !data.dramaName) return
    const key = `${location.href}|${data.dramaName}|${data.category.join(',')}|${data.totalEpisodes}|${data.posterImageUrl}`
    if (key === shownFor && document.getElementById(CARD_ID)) return
    // Don't wipe what the user is typing just because TikTok re-rendered.
    if (shownFor && shownFor.split('|')[0] === location.href && document.getElementById(CARD_ID)?.contains(document.activeElement)) return
    shownFor = key
    renderCard(data, m[1])
  }

  setInterval(tick, 800)
  tick()
})()
