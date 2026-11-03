import { spawn } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { spawnSync } from 'node:child_process'
import { encoderThreads, helperThreads, limitedCommand } from './cpu.js'

// Video encoder, chosen per conversion in the Convert tab:
//   'hardware' = h264_videotoolbox (Apple's media engine, macOS only; one engine, so one episode at a time)
//   'nvenc'    = h264_nvenc (NVIDIA GPU, Linux/Windows): decode, resize and encode on the GPU, several episodes at once
//   'software' = libx264 (CPU; works everywhere)
export const ENCODERS = ['hardware', 'nvenc', 'software']
export const DEFAULT_ENCODER = 'hardware'

/** Runs ffmpeg with `args` once and tells whether it succeeded (used to test what this machine can really do). */
function ffmpegWorks(args) {
  const out = spawnSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'utf8',
    timeout: 20000,
  })
  return !out.error && out.status === 0
}

let available
/**
 * { hardware, nvenc, nvencGpu } on this server (checked once). NVENC is test-encoded for real, because ffmpeg can list
 * h264_nvenc without an NVIDIA GPU or driver. nvencGpu = decoding and resizing on the GPU work too (CUDA + scale_cuda).
 */
export function availableEncoders() {
  if (!available) {
    const out = spawnSync(config.ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
    const list = out.error ? '' : out.stdout || ''
    const hardware = /\bh264_videotoolbox\b/.test(list)
    const nvenc =
      /\bh264_nvenc\b/.test(list) &&
      ffmpegWorks(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-frames:v', '5', '-c:v', 'h264_nvenc', '-f', 'null', '-'])
    // Upload + resize on the GPU (the real pipeline also decodes there; that falls back by itself when it fails)
    const nvencGpu =
      nvenc &&
      ffmpegWorks([
        '-init_hw_device', 'cuda=gpu', '-filter_hw_device', 'gpu',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-frames:v', '5',
        '-vf', 'format=yuv420p,hwupload_cuda,scale_cuda=320:180:format=yuv420p',
        '-c:v', 'h264_nvenc', '-f', 'null', '-',
      ])
    available = { hardware, nvenc, nvencGpu }
    console.log(
      `Encoders: Apple hardware ${hardware ? 'yes' : 'no'} · NVIDIA NVENC ${nvenc ? (nvencGpu ? 'yes (full GPU)' : 'yes (CPU decoding)') : 'no'} · software yes`,
    )
  }
  return available
}

export const hasHardwareEncoder = () => availableEncoders().hardware

/** 'hardware' | 'nvenc' | 'software' from a request value; one this server doesn't have falls back to software. */
export function resolveEncoder(value) {
  const wanted = ENCODERS.includes(value) ? value : DEFAULT_ENCODER
  if (wanted === 'software') return wanted
  return availableEncoders()[wanted] ? wanted : 'software'
}

// NVENC sessions in use. Each quality of each episode is one session; GeForce cards refuse more than 8 at once
// (NVENC_SESSIONS), so an episode waits here until its renditions fit.
let nvencUsed = 0
const nvencWaiting = []
function acquireNvenc(count, signal) {
  const need = Math.min(count, config.nvencSessions)
  return new Promise((resolve, reject) => {
    const entry = {
      need,
      grant: () => {
        signal?.removeEventListener('abort', onAbort)
        nvencUsed += need
        let released = false
        resolve(() => {
          if (released) return
          released = true
          nvencUsed -= need
          drainNvenc()
        })
      },
    }
    const onAbort = () => {
      const i = nvencWaiting.indexOf(entry)
      if (i >= 0) nvencWaiting.splice(i, 1)
      reject(abortError())
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    nvencWaiting.push(entry)
    drainNvenc()
  })
}
function drainNvenc() {
  while (nvencWaiting.length > 0 && nvencUsed + nvencWaiting[0].need <= config.nvencSessions) {
    nvencWaiting.shift().grant()
  }
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
    rotation,
    codec: video.codec_name,
    pixFmt: video.pix_fmt,
    // Square pixels ("1:1", or not stated)
    squarePixels: !video.sample_aspect_ratio || ['1:1', '0:1', 'N/A'].includes(video.sample_aspect_ratio),
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
  // Hardware (Apple): decoding and resizing on the CPU, encoding on the media engine, with no limits at all.
  // NVIDIA: decoding, resizing and encoding on the GPU when the source allows it (see gpuDecodable), no CPU limits.
  const used = resolveEncoder(encoder)
  const renditions = pickRenditions(info.width, info.height, info.fps)

  if (used !== 'nvenc') {
    await encodeHls(input, outDir, info, renditions, used === 'hardware' ? 'videotoolbox' : 'x264', { onProgress, signal, parallel })
  } else {
    const release = await acquireNvenc(renditions.length, signal)
    try {
      const gpu = availableEncoders().nvencGpu && gpuDecodable(info)
      try {
        await encodeHls(input, outDir, info, renditions, gpu ? 'nvenc-gpu' : 'nvenc-cpu', { onProgress, signal, parallel })
      } catch (err) {
        if (!gpu || signal?.aborted) throw err
        // e.g. a codec the GPU can't decode: same NVENC encode, decoding and resizing on the CPU
        console.warn(`GPU decoding failed for ${path.basename(input)}, decoding on the CPU instead: ${err.message}`)
        await encodeHls(input, outDir, info, renditions, 'nvenc-cpu', { onProgress, signal, parallel })
      }
    } finally {
      release()
    }
  }

  await fs.access(path.join(outDir, 'master.m3u8')).catch(() => {
    throw new Error('ffmpeg finished but master.m3u8 was not created')
  })

  return {
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: Math.round(info.fps * 1000) / 1000,
    hasAudio: info.hasAudio,
    encoder: used,
    renditions: renditions.map((r) => ({
      name: r.name,
      width: r.width,
      height: r.height,
      bandwidth: (r.videoKbps + (info.hasAudio ? AUDIO_KBPS : 0)) * 1000,
    })),
  }
}

/**
 * Sources the GPU can decode and resize as they are: common codecs, 8-bit 4:2:0, not rotated (rotating needs a CPU
 * filter, which would bounce every frame back from the GPU), square pixels (setsar is not applied on the GPU).
 */
const gpuDecodable = (info) =>
  ['h264', 'hevc', 'vp9', 'av1', 'mpeg2video', 'mpeg4', 'vp8'].includes(info.codec) &&
  ['yuv420p', 'yuvj420p', 'nv12'].includes(info.pixFmt) &&
  Math.round(info.rotation) % 360 === 0 &&
  info.squarePixels

/**
 * One ffmpeg run: decode once, resize to every rendition, encode, write HLS into outDir.
 * mode: 'x264' | 'videotoolbox' | 'nvenc-gpu' (all on the GPU) | 'nvenc-cpu' (CPU decode/resize, GPU encode)
 */
async function encodeHls(input, outDir, info, renditions, mode, { onProgress, signal, parallel }) {
  const segment = config.hlsSegmentSeconds
  const x264 = mode === 'x264'
  const nvenc = mode.startsWith('nvenc')
  const onGpu = mode === 'nvenc-gpu'

  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })
  for (const r of renditions) await fs.mkdir(path.join(outDir, r.name), { recursive: true })

  // One decode, split into every rendition (on the GPU: frames stay in GPU memory, resized there by scale_cuda)
  const scaled = renditions.map((r, i) =>
    onGpu
      ? `[s${i}]scale_cuda=${r.width}:${r.height}:format=yuv420p[v${i}]`
      : `[s${i}]scale=${r.width}:${r.height}:flags=bicubic,setsar=1,format=yuv420p[v${i}]`,
  )
  const filter =
    renditions.length === 1
      ? scaled[0].replace('[s0]', '[0:v]')
      : `[0:v]split=${renditions.length}${renditions.map((_, i) => `[s${i}]`).join('')};${scaled.join(';')}`

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-loglevel', 'error',
    '-progress', 'pipe:1', '-nostats',
    // x264: CPU limit (FFMPEG_CPU_PERCENT), decoder and scale filters get a small share, the encoders split the rest.
    // Apple / NVIDIA: 0 = as many threads as ffmpeg wants
    '-threads', x264 ? String(helperThreads(parallel)) : '0',
    ...(onGpu ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : []),
    '-i', input,
    '-filter_complex_threads', x264 ? String(helperThreads(parallel)) : '0',
    '-filter_complex', filter,
  ]

  const threads = encoderThreads(renditions, parallel)
  renditions.forEach((r, i) => {
    args.push('-map', `[v${i}]`)
    if (x264) args.push(`-c:v:${i}`, 'libx264', `-threads:v:${i}`, String(threads[i]))
    else if (nvenc) args.push(`-c:v:${i}`, 'h264_nvenc')
    else args.push(`-c:v:${i}`, 'h264_videotoolbox')
    args.push(
      `-b:v:${i}`, `${r.videoKbps}k`,
      `-maxrate:v:${i}`, `${Math.round(r.videoKbps * 1.07)}k`,
      `-bufsize:v:${i}`, `${Math.round(r.videoKbps * 1.5)}k`,
    )
    if (info.hasAudio) args.push('-map', '0:a:0')
  })

  if (x264) {
    // Speed preset, and no extra keyframes on scene cuts
    args.push('-preset', config.ffmpegPreset, '-sc_threshold', '0')
  } else if (nvenc) {
    // Quality-tuned VBR; keyframes only where forced (an IDR at every segment start), none on scene cuts, so segments
    // line up across renditions
    args.push(
      '-preset', config.nvencPreset, '-tune', 'hq', '-rc', 'vbr',
      '-spatial-aq', '1', '-no-scenecut', '1', '-forced-idr', '1',
      '-g', String(Math.max(1, Math.round((info.fps || 30) * segment * 10))),
    )
  } else {
    args.push('-realtime', '0')
  }
  args.push(
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
    unrestricted: !x264,
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
}
