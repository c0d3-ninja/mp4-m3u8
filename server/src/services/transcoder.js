import { spawn } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { spawnSync } from 'node:child_process'
import { encoderThreads, helperThreads, limitedCommand } from './cpu.js'

// Video encoder, chosen per conversion in the Convert tab:
//   'hardware' = h264_videotoolbox (Apple's media engine: ~2.5x faster, CPU mostly free, macOS only)
//   'software' = libx264 (CPU; a little better quality for the size, works everywhere)
export const ENCODERS = ['hardware', 'software']
export const DEFAULT_ENCODER = 'hardware'

let hardwareAvailable
/** Whether this ffmpeg has the VideoToolbox H.264 encoder (checked once). */
export function hasHardwareEncoder() {
  if (hardwareAvailable === undefined) {
    const out = spawnSync(config.ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
    hardwareAvailable = !out.error && /\bh264_videotoolbox\b/.test(out.stdout || '')
  }
  return hardwareAvailable
}

/** 'hardware' | 'software' from a request value; hardware falls back to software where it doesn't exist. */
export function resolveEncoder(value) {
  const wanted = ENCODERS.includes(value) ? value : DEFAULT_ENCODER
  return wanted === 'hardware' && !hasHardwareEncoder() ? 'software' : wanted
}

// Adaptive bitrate ladder. `short` is the length of the frame's short side, so
// the same ladder works for landscape (1920x1080) and vertical (1080x1920) video.
// Bitrates are for ~30 fps; higher frame rates get more (see fpsFactor).
const LADDER = [
  { name: '2160p', short: 2160, videoKbps: 16000 },
  { name: '1440p', short: 1440, videoKbps: 9000 },
  { name: '1080p', short: 1080, videoKbps: 5000 },
  { name: '720p', short: 720, videoKbps: 2800 },
  { name: '480p', short: 480, videoKbps: 1400 },
  { name: '360p', short: 360, videoKbps: 800 },
]
const AUDIO_KBPS = 128

const even = (n) => Math.max(2, Math.round(n / 2) * 2)

// A rung within this many pixels of the source counts as "the source size" (1078p -> 1080p)
const SNAP = 8

/** "30000/1001" -> 29.97 */
function parseRate(value) {
  const [num, den = '1'] = String(value || '').split('/')
  const fps = Number(num) / Number(den)
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? fps : 0
}

/** 50/60 fps needs roughly 1.5x the bits of 25/30 fps for the same quality. */
const fpsFactor = (fps) => (fps > 31 ? 1.5 : 1)

/** Bitrate for a size that isn't on the ladder (e.g. 900p), scaled from 1080p. */
const kbpsForShort = (short) => Math.max(400, Math.round(5000 * (short / 1080) ** 1.5))

/**
 * Spawn a process (within the CPU limit, at low priority) and collect its output. Rejects with the tail of stderr on
 * failure. Exported as runTool for the other ffmpeg steps.
 */
export function runTool(cmd, args, options) {
  return run(cmd, args, options)
}

function run(cmd, args, { cwd, signal, onStdout, unrestricted = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())

    // Unrestricted (hardware conversions): no CPU pinning and normal priority
    const [bin, binArgs] = unrestricted ? [cmd, args] : limitedCommand(cmd, args)
    const child = spawn(bin, binArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    // Lower priority, so the Mac (or server) stays responsive while converting
    if (child.pid && !unrestricted) {
      try {
        os.setPriority(child.pid, 10)
      } catch {
        /* not permitted: run at normal priority */
      }
    }
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
  // avg_frame_rate is the real rate for variable-frame-rate phone video; r_frame_rate is the fallback
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate)

  return {
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    duration,
    fps,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  }
}

/**
 * The source's own resolution is always the top rendition (never upscaled, never capped), followed by
 * every smaller ladder rung. A 1080p source -> 1080p/720p/480p/360p, 720p -> 720p/480p/360p,
 * 900p -> 900p/720p/480p/360p, 4K -> 2160p/1440p/1080p/720p/480p/360p.
 */
export function pickRenditions(width, height, fps = 30) {
  const short = Math.min(width, height)
  const factor = fpsFactor(fps)

  // Top: the source size, named after the matching ladder rung when it is one (1078p -> "1080p")
  const match = LADDER.find((r) => Math.abs(r.short - short) <= SNAP)
  const top = match
    ? { ...match, width: even(width), height: even(height) }
    : { name: `${even(short)}p`, short: even(short), videoKbps: kbpsForShort(short), width: even(width), height: even(height) }

  const lower = LADDER.filter((r) => r.short < top.short - SNAP).map((r) => {
    const scale = r.short / short
    return { ...r, width: even(width * scale), height: even(height * scale) }
  })

  return [top, ...lower].map((r) => ({ ...r, videoKbps: Math.round(r.videoKbps * factor) }))
}

/**
 * Convert one video into an HLS package:
 *   outDir/master.m3u8
 *   outDir/<rendition>/index.m3u8 + seg_000.ts …
 */
export async function transcodeToHls(input, outDir, { onProgress, signal, encoder = DEFAULT_ENCODER, parallel = 1 } = {}) {
  const info = await probe(input, { signal })
  // Software: x264 within the CPU limit (FFMPEG_CPU_PERCENT), at low priority; with `parallel` episodes converting at
  // once, each gets an equal share of that limit.
  // Hardware: decoding and resizing on the CPU, encoding on the media engine, with no limits at all: every thread
  // ffmpeg wants, normal priority, no CPU pinning.
  const hardware = resolveEncoder(encoder) === 'hardware'
  const renditions = pickRenditions(info.width, info.height, info.fps)
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
    // CPU limit (FFMPEG_CPU_PERCENT): decoder and scale filters get a small share, the encoders split the rest
    // Thread counts: 0 = as many as ffmpeg wants (hardware); otherwise a share of the CPU limit
    '-threads', hardware ? '0' : String(helperThreads(parallel)),
    '-i', input,
    '-filter_complex_threads', hardware ? '0' : String(helperThreads(parallel)),
    '-filter_complex', filter,
  ]

  const threads = encoderThreads(renditions, parallel)
  renditions.forEach((r, i) => {
    args.push(
      '-map', `[v${i}]`,
      // Hardware encoding runs on the media engine, so the CPU thread split only applies to x264
      ...(hardware
        ? [`-c:v:${i}`, 'h264_videotoolbox']
        : [`-c:v:${i}`, 'libx264', `-threads:v:${i}`, String(threads[i])]),
      `-b:v:${i}`, `${r.videoKbps}k`,
      `-maxrate:v:${i}`, `${Math.round(r.videoKbps * 1.07)}k`,
      `-bufsize:v:${i}`, `${Math.round(r.videoKbps * 1.5)}k`,
    )
    if (info.hasAudio) args.push('-map', '0:a:0')
  })

  args.push(
    // x264 only: speed preset, and no extra keyframes on scene cuts (VideoToolbox adds none of its own)
    ...(hardware ? ['-realtime', '0'] : ['-preset', config.ffmpegPreset, '-sc_threshold', '0']),
    '-profile:v', 'high',
    // Keyframes at exact segment boundaries, identical across renditions,
    // so players can switch quality cleanly between segments.
    '-force_key_frames', `expr:gte(t,n_forced*${segment})`,
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
    unrestricted: hardware,
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

  return {
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: Math.round(info.fps * 1000) / 1000,
    hasAudio: info.hasAudio,
    encoder: hardware ? 'hardware' : 'software',
    renditions: renditions.map((r) => ({
      name: r.name,
      width: r.width,
      height: r.height,
      bandwidth: (r.videoKbps + (info.hasAudio ? AUDIO_KBPS : 0)) * 1000,
    })),
  }
}
