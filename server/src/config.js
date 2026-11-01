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
  // How many episodes are transcoded at the same time
  concurrency: Math.floor(positiveNumber(process.env.CONCURRENCY, 1)),

  uploadsDir: path.join(root, 'storage', 'uploads'),
  hlsDir: path.join(root, 'storage', 'hls'),
  zipsDir: path.join(root, 'storage', 'zips'),
}
