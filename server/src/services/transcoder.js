import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'

// Adaptive bitrate ladder. `short` is the length of the frame's short side, so
// the same ladder works for landscape (1920x1080) and vertical (1080x1920) video.
const LADDER = [
  { name: '1080p', short: 1080, videoKbps: 5000 },
  { name: '720p', short: 720, videoKbps: 2800 },
  { name: '480p', short: 480, videoKbps: 1400 },
  { name: '360p', short: 360, videoKbps: 800 },
]
const AUDIO_KBPS = 128

const even = (n) => Math.max(2, Math.round(n / 2) * 2)

/**
 * Spawn a process and collect its output. Rejects with the tail of stderr on failure.
 */
function run(cmd, args, { cwd, signal, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())

    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (onStdout) onStdout(chunk)
      else stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000)
    })

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      if (err.code === 'ENOENT') {
        reject(new Error(`"${cmd}" was not found. Install ffmpeg (brew install ffmpeg) or set FFMPEG_PATH / FFPROBE_PATH in server/.env`))
      } else {
        reject(err)
      }
    })

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(abortError())
      if (code === 0) return resolve({ stdout, stderr })
      const lastLines = stderr.trim().split('\n').slice(-4).join('\n')
      reject(new Error(lastLines || `${path.basename(cmd)} exited with code ${code}`))
    })
  })
}

function abortError() {
  const err = new Error('Cancelled')
  err.name = 'AbortError'
  return err
}

/**
 * Read dimensions (after rotation), duration and audio presence of a video file.
 */
export async function probe(input, { signal } = {}) {
  const { stdout } = await run(
    config.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', input],
    { signal },
  )

  let data
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new Error('Could not read video information (ffprobe returned invalid output)')
  }

  const streams = data.streams || []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!video || !video.width || !video.height) throw new Error('No video stream found in this file')

  // Phone recordings are often stored sideways with a rotation flag.
  // ffmpeg auto-rotates while decoding, so swap dimensions to match what we'll get.
  let rotation = 0
  const rotationData = video.side_data_list?.find((d) => d.rotation !== undefined)
  if (rotationData) rotation = Number(rotationData.rotation) || 0
  else if (video.tags?.rotate) rotation = Number(video.tags.rotate) || 0
  const sideways = Math.abs(rotation) % 180 === 90

  const duration = Number(data.format?.duration) || Number(video.duration) || 0

  return {
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    duration,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  }
}

/**
 * Pick the ladder rungs that are not larger than the source, keeping aspect ratio.
 */
export function pickRenditions(width, height) {
  const short = Math.min(width, height)
  let rungs = LADDER.filter((r) => r.short <= short + 8)
  if (rungs.length === 0) {
    // Tiny source: one rendition at its own size
    rungs = [{ name: `${even(short)}p`, short: even(short), videoKbps: 600 }]
  }
  return rungs.map((r) => {
    const scale = r.short / short
    return { ...r, width: even(width * scale), height: even(height * scale) }
  })
}

/**
 * Convert one video into an HLS package:
 *   outDir/master.m3u8
 *   outDir/<rendition>/index.m3u8 + seg_000.ts …
 *   outDir/poster.jpg
 */
export async function transcodeToHls(input, outDir, { onProgress, signal } = {}) {
  const info = await probe(input, { signal })
  const renditions = pickRenditions(info.width, info.height)
  const segment = config.hlsSegmentSeconds

  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })
  for (const r of renditions) await fs.mkdir(path.join(outDir, r.name), { recursive: true })

  // One decode, split into every rendition
  const scaled = renditions.map(
    (r, i) => `[s${i}]scale=${r.width}:${r.height}:flags=bicubic,setsar=1,format=yuv420p[v${i}]`,
  )
  const filter =
    renditions.length === 1
      ? scaled[0].replace('[s0]', '[0:v]')
      : `[0:v]split=${renditions.length}${renditions.map((_, i) => `[s${i}]`).join('')};${scaled.join(';')}`

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-loglevel', 'error',
    '-progress', 'pipe:1', '-nostats',
    '-i', input,
    '-filter_complex', filter,
  ]

  renditions.forEach((r, i) => {
    args.push(
      '-map', `[v${i}]`,
      `-c:v:${i}`, 'libx264',
      `-b:v:${i}`, `${r.videoKbps}k`,
      `-maxrate:v:${i}`, `${Math.round(r.videoKbps * 1.07)}k`,
      `-bufsize:v:${i}`, `${Math.round(r.videoKbps * 1.5)}k`,
    )
    if (info.hasAudio) args.push('-map', '0:a:0')
  })

  args.push(
    '-preset', config.ffmpegPreset,
    '-profile:v', 'high',
    // Keyframes at exact segment boundaries, identical across renditions,
    // so players can switch quality cleanly between segments.
    '-force_key_frames', `expr:gte(t,n_forced*${segment})`,
    '-sc_threshold', '0',
  )

  if (info.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ac', '2', '-ar', '48000')
  }

  const streamMap = renditions
    .map((r, i) => (info.hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`))
    .join(' ')

  // Output paths are relative to cwd=outDir so folder names containing "%"
  // can't be mistaken for ffmpeg filename patterns.
  args.push(
    '-f', 'hls',
    '-hls_time', String(segment),
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', '%v/seg_%03d.ts',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', streamMap,
    '%v/index.m3u8',
  )

  let buffer = ''
  await run(config.ffmpegPath, args, {
    cwd: outDir,
    signal,
    onStdout(chunk) {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line)
        if (match && info.duration > 0 && onProgress) {
          onProgress(Math.min(0.99, Number(match[1]) / 1e6 / info.duration))
        }
      }
    },
  })

  await fs.access(path.join(outDir, 'master.m3u8')).catch(() => {
    throw new Error('ffmpeg finished but master.m3u8 was not created')
  })

  const poster = await createPoster(input, outDir, info, renditions, signal)

  return {
    duration: info.duration,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    poster,
    renditions: renditions.map((r) => ({
      name: r.name,
      width: r.width,
      height: r.height,
      bandwidth: (r.videoKbps + (info.hasAudio ? AUDIO_KBPS : 0)) * 1000,
    })),
  }
}

/**
 * Grab a thumbnail frame (non-fatal if it fails). Returns the file name or null.
 */
async function createPoster(input, outDir, info, renditions, signal) {
  const target = renditions.find((r) => r.short <= 720) || renditions[renditions.length - 1]
  const at = info.duration > 0 ? Math.min(5, info.duration * 0.1) : 0
  try {
    await run(
      config.ffmpegPath,
      [
        '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
        '-ss', at.toFixed(2), '-i', input,
        '-frames:v', '1',
        '-vf', `scale=${target.width}:${target.height},setsar=1`,
        '-q:v', '3',
        'poster.jpg',
      ],
      { cwd: outDir, signal },
    )
    return 'poster.jpg'
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return null
  }
}
