# mp4-m3u8 — Drama Converter

Pick a folder of episodes, choose which ones to convert, and get back **`<FolderName>.zip`** containing an
adaptive HLS stream (Netflix / DramaBox style) for every episode.

## Requirements

- Node.js 20.12+ (22 LTS recommended)
- ffmpeg + ffprobe: `brew install ffmpeg`

## Run

```bash
npm install
npm run dev          # server on http://localhost:4000, client on http://localhost:5173
```

Open http://localhost:5173 → **Choose folder** → untick anything you don't want → **Convert** → **Download**.

Chrome asks "Upload N files to this site?" when you pick a folder. Nothing leaves your machine; the files go
to the local server only.

## What you get

```
My Drama.zip
└── My Drama/
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

- Renditions are picked by the video's short side, so vertical (1080×1920) and landscape (1920×1080) both work.
  Nothing is upscaled: a 720p source gets 720p / 480p / 360p.
- H.264 High + AAC 128k stereo, 4 s segments, keyframes aligned across renditions for clean quality switching.
- Phone videos with a rotation flag are rotated correctly. Files without audio are fine.
- Episodes are sorted naturally (Episode 2 before Episode 10).
- A file that fails (corrupt, not a video) is reported and skipped; the rest are still zipped and listed under
  `failed` in `manifest.json`.

## Settings (`server/.env`)

| Variable | Default | |
|---|---|---|
| `FFMPEG_PRESET` | `veryfast` | x264 speed vs. quality (`faster`, `medium` = smaller/better but slower) |
| `HLS_SEGMENT_SECONDS` | `4` | Segment length |
| `CONCURRENCY` | `1` | Episodes converted in parallel |
| `FFMPEG_PATH` / `FFPROBE_PATH` | on `PATH` | Custom ffmpeg location |

## How it works

1. Client sends the selected file list → server creates a job (`POST /api/jobs`).
2. Episodes are uploaded one by one (`POST /api/jobs/:id/files/:fileId`); each starts converting as soon as it
   arrives, and the uploaded copy is deleted once it's converted.
3. When all are done the server writes `manifest.json` and zips `storage/hls/<job>/<Folder>/` into
   `storage/zips/<job>/<Folder>.zip` (`GET /api/jobs/:id/download`).
4. **Convert another folder** / **Cancel** delete that job's files from `server/storage`.

Jobs live in server memory: if the server restarts, start the conversion again.
