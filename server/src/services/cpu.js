import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { config } from '../config.js'

// How much CPU ffmpeg may use: FFMPEG_CPU_PERCENT (default 80) of the CPUs this container really has.
//
// Inside a container (e.g. a RunPod pod with 16 vCPUs) os.cpus() usually reports the *host's* cores (often 64-200),
// so the real allowance is read from the cgroup quota and the CPU affinity list. ffmpeg is then
//   1. pinned with `taskset` to that many cores (Linux), a hard cap, even with several conversions at once, and
//   2. told to use that many threads per encoder (everywhere, incl. macOS), so x264 doesn't start hundreds of threads.

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

/** CPUs allowed by the cgroup quota (v2 "cpu.max", or v1 cfs quota/period), or Infinity when unlimited/unknown. */
function quotaCpus() {
  const v2 = readText('/sys/fs/cgroup/cpu.max') // "1600000 100000" or "max 100000"
  if (v2) {
    const [quota, period] = v2.split(/\s+/)
    if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0) return Number(quota) / Number(period)
  }
  const quota = Number(readText('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'))
  const period = Number(readText('/sys/fs/cgroup/cpu/cpu.cfs_period_us'))
  if (quota > 0 && period > 0) return quota / period
  return Infinity
}

/** "0-3,8,10-11" -> [0,1,2,3,8,10,11] */
function parseCpuList(list) {
  const cpus = []
  for (const part of String(list || '').split(',')) {
    const [a, b] = part.split('-').map(Number)
    if (!Number.isInteger(a)) continue
    for (let n = a; n <= (Number.isInteger(b) ? b : a); n++) cpus.push(n)
  }
  return cpus
}

/** CPU numbers this process may run on (affinity / cpuset), or null when unknown (macOS). */
function allowedCpus() {
  const status = readText('/proc/self/status')
  const match = status?.match(/^Cpus_allowed_list:\s*(.+)$/m)
  const cpus = match ? parseCpuList(match[1]) : []
  return cpus.length > 0 ? cpus : null
}

function hasTaskset() {
  if (process.platform !== 'linux') return false
  const result = spawnSync('taskset', ['--version'], { stdio: 'ignore' })
  return !result.error && result.status === 0
}

function detect() {
  const percent = Math.min(100, Math.max(1, config.ffmpegCpuPercent))
  const allowed = allowedCpus()
  const available = Math.max(1, Math.floor(Math.min(allowed?.length ?? os.availableParallelism(), quotaCpus())))
  const limit = Math.max(1, Math.floor((available * percent) / 100))
  const pin = allowed && limit < allowed.length && hasTaskset() ? allowed.slice(0, limit).join(',') : null
  return { percent, available, limit, pin }
}

export const cpuLimit = detect()

/**
 * Threads per encoder so that all renditions together use about `limit` threads, shared by pixel count:
 * a 1080p/720p/480p/360p ladder on 6 threads -> 3/1/1/1 instead of 6 each (x264's default is ~1.5 x cores each).
 */
export function encoderThreads(renditions) {
  const pixels = renditions.map((r) => r.width * r.height)
  const total = pixels.reduce((a, b) => a + b, 0) || 1
  return pixels.map((p) => Math.max(1, Math.round((cpuLimit.limit * p) / total)))
}

/** Threads for decoding the source and for the scale filters (each a small share of the limit). */
export const helperThreads = () => Math.max(1, Math.round(cpuLimit.limit / 3))

/** [cmd, args] for spawning ffmpeg/ffprobe within the CPU limit (taskset-pinned when possible). */
export function limitedCommand(cmd, args) {
  return cpuLimit.pin ? ['taskset', ['-c', cpuLimit.pin, cmd, ...args]] : [cmd, args]
}

export function describeCpuLimit() {
  const { percent, available, limit, pin } = cpuLimit
  return `ffmpeg limited to ${limit} of ${available} CPUs (${percent}%)${pin ? `, pinned to CPUs ${pin}` : ', via thread count'}`
}
