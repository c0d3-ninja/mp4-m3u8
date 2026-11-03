import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Load server/.env if present (Node 20.12+)
try {
  process.loadEnvFile(path.join(root, '.env'))
} catch {
  /* no .env file: use defaults */
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const config = {
  port: positiveNumber(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  // x264 speed/quality trade-off: ultrafast … veryfast … medium … slow
  ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast',
  // Target HLS segment length in seconds
  hlsSegmentSeconds: positiveNumber(process.env.HLS_SEGMENT_SECONDS, 4),
  // How many episodes are transcoded at the same time, across all jobs (default 1: ffmpeg already uses every core)
  concurrency: Math.floor(positiveNumber(process.env.CONCURRENCY, 1)),
  // Share of the machine's CPU ffmpeg may use (1-100). The rest stays free for the server, the browser and the Mac.
  ffmpegCpuPercent: positiveNumber(process.env.FFMPEG_CPU_PERCENT, 80),
  // NVIDIA (NVENC) encoding: speed/quality preset p1 (fastest) … p7 (best), and how many encode sessions may run at
  // once (each quality of each episode is one session; GeForce cards allow 8, pro cards more)
  nvencPreset: process.env.NVENC_PRESET || 'p5',
  nvencSessions: Math.floor(positiveNumber(process.env.NVENC_SESSIONS, 8)),

  uploadsDir: path.join(root, 'storage', 'uploads'),

  // Converted series are written to "<downloadsDir>/converted/<drama id>/" (convertedDir below), and this is the folder shown in the
  // "Folders" tab (browse + delete). Defaults to ~/Downloads of the user running the server.
  downloadsDir: path.resolve(expandHome(process.env.DOWNLOADS_DIR || '~/Downloads')),
}

// Every conversion's output folder lives in here: "<downloadsDir>/converted/<drama id>/" (the "id" in drama.json)
export const CONVERTED_FOLDER = 'converted'
config.convertedDir = path.join(config.downloadsDir, CONVERTED_FOLDER)

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
}
