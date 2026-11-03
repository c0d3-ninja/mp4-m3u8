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
