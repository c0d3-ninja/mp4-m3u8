# mp4-m3u8 — Drama Converter

Pick a folder of episodes, choose which ones to convert, and the server writes an adaptive HLS stream
(Netflix / DramaBox style) for every episode into **`<downloads>/<random uuid>/drama/`**. Nothing is zipped.

## Requirements

- Node.js 20.12+ (22 LTS recommended)
- ffmpeg + ffprobe: `brew install ffmpeg`

## Run

```bash
npm install
npm run dev          # server on http://localhost:4000, client on http://localhost:5173
```

Open http://localhost:5173 → **Choose folder** → untick anything you don't want → **Convert**. When it finishes,
**Open in Folders** shows the output.

### On a Linux server

```bash
npm install
npm run build        # builds client/dist
npm start            # one process on :4000 serves the app, the API and the previews
```

Open `http://<server>:4000`. When `client/dist` exists the server serves it; hashed files under `/assets` are
cached for a year. Set `PORT` and `DOWNLOADS_DIR` in `server/.env`.

Chrome asks "Upload N files to this site?" when you pick a folder. Nothing leaves your machine; the files go
to the local server only.

## What you get

```
~/Downloads/                          DOWNLOADS_DIR
└── 3f2b9c1e-…-uuid/                  a new random UUID per conversion
    ├── drama.json                    { "dramaName", "imageUrl", "category" }, written when it starts
    └── drama/                        always "drama"; the real name is in drama.json
        ├── manifest.json                 episode list for your app (order, durations, paths, posters)
        ├── Episode 1/
        │   ├── master.m3u8               ← play this URL
        │   ├── poster.jpg                thumbnail
        │   ├── 1080p/index.m3u8 + seg_000.ts …
        │   ├── 720p/ …
        │   ├── 480p/ …
        │   └── 360p/ …
        └── Episode 2/ …
```

- The source's own resolution is always the highest quality, followed by every smaller standard size. Sizes go by the
  short side, so vertical (1080×1920) and landscape (1920×1080) both work. Nothing is upscaled or capped:
  1080p → 1080p / 720p / 480p / 360p, 720p → 720p / 480p / 360p, 900p → 900p / 720p / …, 4K → 2160p / 1440p / 1080p / ….
- `drama.json` is copied from the selected folder's own `drama.json`, which the **Move** tab writes. Without one,
  `dramaName` is the folder name and `category` / `imageUrl` are `null`. It sits next to the series folder,
  and both Cloudflare uploads put it next to `manifest.json`.
- The frame rate is kept as in the source (24, 29.97, 30, 60 fps…) for every quality. Video above 30 fps gets 1.5× the
  bitrate so it looks as good. Each episode's `fps` is in `manifest.json`.
- H.264 High + AAC 128k stereo, 4 s segments, keyframes aligned across renditions for clean quality switching.
- Phone videos with a rotation flag are rotated correctly. Files without audio are fine.
- Episodes are sorted naturally (Episode 2 before Episode 10).
- A file that fails (corrupt, not a video) is reported and skipped; the rest are still saved and listed under
  `failed` in `manifest.json`.

## Upload to Cloudflare R2

The **☁️ Upload to Cloudflare** tab uploads a converted series to your R2 bucket (default `dramas`).

1. Fill in Account ID (or the bucket's "S3 API" URL), Access Key ID, Secret Access Key, bucket and, optionally,
   the public URL → **Save & test connection**. The keys are saved in this browser's localStorage and are only
   sent to the local server, which signs the requests to Cloudflare.
2. **Choose folder** → pick a converted `<uuid>` folder (or any folder with `manifest.json`) → **Upload to dramas**.
   For a `<uuid>` folder, the series inside `drama/` is uploaded with `drama.json` next to `manifest.json`:
   `<dest>/manifest.json`, `<dest>/drama.json`, `<dest>/Episode 1/…`.
3. Episodes play from `https://<public-url>/My%20Drama/Episode%201/master.m3u8`, the list is in
   `https://<public-url>/My%20Drama/manifest.json`.

After converting in the **Convert** tab you can also click **Upload** in the "Upload to Cloudflare" box, which
uploads straight from the server's output folder.

- Upload order is segments → each episode's `master.m3u8` → `manifest.json` + `drama.json`, and a phase only starts when
  everything before it succeeded, so an interrupted upload never publishes a series with missing files.
- "Skip files already uploaded" (on by default) compares name + size, so **Retry**/**Resume** only sends what's missing.
- `.ts`/`.jpg` get `Cache-Control: immutable` (1 year); `.m3u8`/`manifest.json` get 5 minutes.

## Move tab

**📦 Move** (the first tab) lists every `.mp4` directly inside the downloads folder. Files in sub-folders are
left alone, and so are macOS `._` files. Type a folder name and click **Move N files**. The folder is created in the
downloads folder if it doesn't exist, and the listed files are moved into it.

- **Category** and **Image URL** (optional) are saved with the drama name you typed (`Love's Story`, before the
  folder name is cleaned) as `<folder>/drama.json`: `{ "dramaName", "imageUrl", "category" }`. Converting that folder
  later copies it into the output. Moving more episodes into a folder that already has one keeps its drama name, and
  empty fields keep their old values. The image URL must be http/https.
- Existing folder names are suggested as you type, and the form says whether the folder will be created or the files
  added to an existing one.
- A file is never overwritten. If the folder already has a file with that name, the file is skipped and reported.
- The folder name is cleaned before the folder is created: apostrophes (`'`) and dots (`.`) are removed and each run
  of spaces becomes one `-`, so `Love's  Story Vol.2` → `Loves-Story-Vol2`. The form shows the final name as you
  type. `/` and `\` are rejected.

## Folders tab

**🗂️ Folders** lists everything in the server's downloads folder (`DOWNLOADS_DIR`, default `~/Downloads` of
the user running the server). It shows the size, item count and modified date of each entry, plus the free disk
space. Click a folder to open it, and use the breadcrumbs to go back up. **Delete** permanently removes a folder,
including everything inside it, or a single file.

- A job's `<uuid>` folder can't be deleted while it is still converting or uploading to Cloudflare.
- Folder sizes are cached for 10 seconds (and refreshed after a delete or move), so browsing big series stays fast.
- Paths can't leave the downloads folder. `..` is rejected, and symlinks that point outside it can't be opened.
  Deleting a symlink removes only the link, never the folder it points to.
- The app has no login. If you host it on a Linux machine that other people can reach, put it behind a VPN,
  basic auth or a firewall, because anyone who can open the page can delete files in that folder.

## Settings (`server/.env`)

| Variable | Default | |
|---|---|---|
| `FFMPEG_PRESET` | `veryfast` | x264 speed vs. quality (`faster`, `medium` = smaller/better but slower) |
| `HLS_SEGMENT_SECONDS` | `4` | Segment length |
| `CONCURRENCY` | `1` | Episodes converted in parallel |
| `FFMPEG_PATH` / `FFPROBE_PATH` | on `PATH` | Custom ffmpeg location |
| `DOWNLOADS_DIR` | `~/Downloads` | Folder shown in the Folders tab |

## How it works

1. Client sends the selected file list → server creates a job (`POST /api/jobs`).
2. Episodes are uploaded one by one (`POST /api/jobs/:id/files/:fileId`); each starts converting as soon as it
   arrives, and the uploaded copy is deleted once it's converted.
3. Each episode is converted straight into `<DOWNLOADS_DIR>/<job uuid>/drama/`. When all are done the server
   writes `manifest.json` there. "Convert another folder" keeps the output; **Cancel** deletes the partial output.

Jobs live in server memory: if the server restarts, start the conversion again. A finished job that nobody has
opened for 6 hours is forgotten (its output stays in the downloads folder); one abandoned mid-upload is converted
with the episodes that arrived.
