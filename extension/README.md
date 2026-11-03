# TikTok Drama → JSON (Chrome extension)

On `https://www.tiktok.com/shortdrama/episode/<id>/<ep>` it shows a card (bottom-right) with the drama's
details read from `[data-testid="short-drama-detail"]`, and an **Add to json** button that appends
an entry to `~/Desktop/dramas-next.json` (created as `[]` if missing):

```json
{ "id": "", "dramaName": "", "category": [], "description": "", "posterImageUrl": "", "totalEpisodes": 42, "dramaUrl": "<current url>" }
```

The same drama (same `<id>` in the URL) is updated instead of duplicated.

Browsers don't let extensions write to the Desktop, so a small Node native-messaging host
(`native-host/host.js`) does the file work.

## Setup (once)

1. `./extension/native-host/install.sh` — registers the host for Chrome/Brave/Edge/etc.
   (re-run if you move this repo or switch Node versions).
2. `chrome://extensions` → Developer mode → **Load unpacked** → select the `extension/` folder.
   The ID must be `mnbdkechdcbddnilcgdignpbkldljpjh` (fixed by `key` in `manifest.json`).
3. Restart the browser. The JSON file is created on Desktop at startup / install.

## Gemini / ChatGPT poster prompt

On `https://gemini.google.com/app` (also `/u/<n>/app`) and `https://chatgpt.com/` a card lists the dramas in `~/Desktop/dramas-next.json`.
Click a row to highlight it and edit its prompt:

> Create a brand-new movie poster based on the characters in this image … (passes the description and category for
> the mood only and forbids writing them; keeps the characters' faces and looks,
> changes poses, framing, layout, background and lighting, and allows only the title "{app_dramaName}" as text, in a random font style and position each time; see
> `promptFor` in `prompt-card.js` for the full text)

Each row shows the poster (click to open it), the title, a **⬇ Poster** button (saves the poster image to your Downloads folder) and a **Put in Gemini** / **Put in ChatGPT** button, which replaces the text box contents with the prompt. It is never sent. ↻ re-reads the file.
After updating the extension, reload it in `chrome://extensions` (the native host needs no reinstall).

## DramaSave

On `https://dramasave.app/` the same card lists the dramas (poster + title) with a **Paste link** button that puts
the drama's `dramaUrl` in the link box. **Paste link** also creates `Downloads/<folder>/drama.json` (the drama's whole entry; the folder is
`app_dramaName` with every special character removed and spaces turned into `-`), and from then on every download from
dramasave.app is saved into `Downloads/<folder>/` (downloads from other sites are not touched; Chrome only allows
folders inside Downloads). Clicking the site's **Download Full Series** after **Resolve Episodes** marks
that drama as downloaded; every card (DramaSave, Gemini, ChatGPT) then shows a **✔ Downloaded** label on it.

## mp4-m3u8 Move tab

On `http://localhost:5173/` (this app's dev server) the card has a **Fill JSON** button per drama: it opens the Move
tab and fills its JSON field with the drama's whole entry from `dramas-next.json`. The folder is named after
`app_dramaName`, and the JSON is saved as the folder's `drama.json` (copied, with `cfId` = the UUID, when converting).
