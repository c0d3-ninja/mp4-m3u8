import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { HttpError } from './jobs.js'
import { Queue, fsLimit } from './limit.js'

const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.vtt': 'text/vtt',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

// Segments and images never change once written; playlists/manifest might be re-uploaded.
const LONG_CACHE = 'public, max-age=31536000, immutable'
const SHORT_CACHE = 'public, max-age=300'

export function contentTypeFor(key) {
  return CONTENT_TYPES[path.posix.extname(key).toLowerCase()] || 'application/octet-stream'
}

export function cacheControlFor(key) {
  const ext = path.posix.extname(key).toLowerCase()
  return ext === '.m3u8' || ext === '.json' ? SHORT_CACHE : LONG_CACHE
}

/**
 * Accepts the Account ID ("b6fd9a…") or the bucket's "S3 API" URL from the
 * Cloudflare dashboard ("https://<id>.r2.cloudflarestorage.com/dramas").
 */
export function parseEndpoint(input) {
  const value = String(input || '').trim()
  if (!value) throw new HttpError(400, 'Account ID is missing')

  if (/^[a-f0-9]{32}$/i.test(value)) {
    return { endpoint: `https://${value.toLowerCase()}.r2.cloudflarestorage.com`, bucketFromUrl: null }
  }

  let url
  try {
    url = new URL(value)
  } catch {
    throw new HttpError(400, 'Account ID should be 32 characters (0-9, a-f), or paste the bucket\'s "S3 API" URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'S3 API URL must start with https://')
  const bucketFromUrl = url.pathname.split('/').filter(Boolean)[0] || null
  return { endpoint: url.origin, bucketFromUrl }
}

/** Normalise a key prefix: "My Drama/" -> "My Drama". Rejects empty and ".." parts. */
export function cleanPrefix(prefix) {
  const parts = String(prefix || '')
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new HttpError(400, 'Destination folder in the bucket is required')
  if (parts.some((p) => p === '.' || p === '..')) throw new HttpError(400, 'Destination folder cannot contain "." or ".."')
  return parts.join('/')
}

export function cleanKey(key) {
  const parts = String(key || '').split('/')
  if (!key || key.length > 1024 || parts.some((p) => !p || p === '.' || p === '..')) {
    throw new HttpError(400, `Invalid object key: ${key}`)
  }
  return key
}

const clients = new Map()

/** Read credentials sent by the client in X-R2-* headers. */
export function connectionFromRequest(req) {
  const accessKeyId = String(req.get('x-r2-access-key-id') || '').trim()
  const secretAccessKey = String(req.get('x-r2-secret-access-key') || '').trim()
  const { endpoint, bucketFromUrl } = parseEndpoint(req.get('x-r2-account'))
  const bucket = String(req.get('x-r2-bucket') || bucketFromUrl || '').trim()

  if (!accessKeyId) throw new HttpError(400, 'Access Key ID is missing')
  if (!secretAccessKey) throw new HttpError(400, 'Secret Access Key is missing')
  if (!bucket) throw new HttpError(400, 'Bucket name is missing')
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new HttpError(400, 'Bucket name can only contain lowercase letters, numbers and hyphens')
  }

  const id = crypto.createHash('sha256').update([endpoint, accessKeyId, secretAccessKey].join('\n')).digest('hex')
  let client = clients.get(id)
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      // Plain signed uploads; avoids the newer aws-chunked checksum trailers
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // Bodies are streams that can't be replayed, so retries happen in our own code with a fresh stream
      maxAttempts: 1,
    })
    clients.set(id, client)
  }
  return { client, bucket, endpoint }
}

/** Turn S3/network errors into something a person can act on. */
export function explainError(err, bucket) {
  const name = err?.name || err?.Code || ''
  const status = err?.$metadata?.httpStatusCode
  const code = err?.code || err?.cause?.code

  if (err instanceof HttpError) return err
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new HttpError(400, 'Could not reach Cloudflare. Check the Account ID (or your internet connection).')
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
    return new HttpError(502, `Network error talking to Cloudflare (${code}). Try again.`)
  }
  if (name === 'InvalidAccessKeyId' || (name === 'InvalidArgument' && /access key/i.test(err.message || ''))) {
    return new HttpError(401, 'Access Key ID is wrong (or the token was deleted).')
  }
  if (name === 'SignatureDoesNotMatch') {
    return new HttpError(401, 'Secret Access Key is wrong for this Access Key ID.')
  }
  if (name === 'NoSuchBucket') {
    return new HttpError(404, `Bucket "${bucket}" does not exist in this account.`)
  }
  if (name === 'AccessDenied' || status === 403) {
    return new HttpError(
      403,
      `Access denied to bucket "${bucket}". The API token needs "Object Read & Write" permission for this bucket.`,
    )
  }
  if (name === 'AbortError') return new HttpError(499, 'Upload cancelled')
  return new HttpError(status && status >= 400 && status < 600 ? status : 502, err?.message || 'Cloudflare R2 error')
}

/** Quick credentials/bucket check (1 list request). */
export async function testConnection({ client, bucket }) {
  try {
    await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }))
  } catch (err) {
    throw explainError(err, bucket)
  }
}

/** Top-level "folders" in the bucket, e.g. ["My Drama/", "Love Story/"]. */
export async function listSeries({ client, bucket }) {
  const prefixes = []
  let ContinuationToken
  try {
    do {
      const out = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Delimiter: '/', MaxKeys: 1000, ContinuationToken }),
      )
      for (const p of out.CommonPrefixes || []) prefixes.push(p.Prefix.replace(/\/$/, ''))
      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (ContinuationToken && prefixes.length < 5000)
  } catch (err) {
    throw explainError(err, bucket)
  }
  return prefixes
}

/** Every object under `prefix/` as { "relative/key": size } (used to skip already-uploaded files). */
export async function listExisting({ client, bucket }, prefix) {
  const result = {}
  const base = `${prefix}/`
  let ContinuationToken
  let count = 0
  try {
    do {
      const out = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: base, MaxKeys: 1000, ContinuationToken }),
      )
      for (const o of out.Contents || []) {
        result[o.Key.slice(base.length)] = o.Size
        count++
      }
      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (ContinuationToken && count < 200000)
  } catch (err) {
    throw explainError(err, bucket)
  }
  return result
}

export async function putObject({ client, bucket }, key, body, size, { signal } = {}) {
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: cleanKey(key),
        Body: body,
        ContentLength: size,
        ContentType: contentTypeFor(key),
        CacheControl: cacheControlFor(key),
      }),
      { abortSignal: signal },
    )
  } catch (err) {
    throw explainError(err, bucket)
  }
}

/** All files under `dir` as [{ relativePath, fullPath, size }], skipping hidden files. */
// Folders and stats run in parallel (bounded by fsLimit) instead of one stat at a time.
export async function walkFiles(dir) {
  const out = []
  async function walk(current, rel) {
    const entries = await fsLimit(() => fsp.readdir(current, { withFileTypes: true }))
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith('.')) return
        const full = path.join(current, entry.name)
        const relPath = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(full, relPath)
        else if (entry.isFile()) {
          const { size } = await fsLimit(() => fsp.stat(full))
          out.push({ relativePath: relPath, fullPath: full, size })
        }
      }),
    )
  }
  await walk(dir, '')
  // Plain code-unit order: localeCompare is ~100x slower and the order only needs to be stable
  return out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Upload order: segments and variant playlists first, then each episode's master.m3u8,
 * then manifest.json last, so an interrupted upload never publishes links to missing files.
 */
export function uploadRank(relativePath) {
  const name = relativePath.split('/').pop()
  if (relativePath === 'manifest.json') return 2
  if (name === 'master.m3u8') return 1
  return 0
}

/**
 * Upload a local folder to `prefix/` with a few parallel requests and retries.
 * `state` is mutated with progress so it can be polled.
 */
export async function uploadDirectory(connection, dir, prefix, state, { signal, skipExisting = true, concurrency = 8 } = {}) {
  const files = await walkFiles(dir)
  state.total = files.length
  state.totalBytes = files.reduce((s, f) => s + f.size, 0)

  const existing = skipExisting ? await listExisting(connection, prefix) : {}

  async function uploadOne(file) {
    if (existing[file.relativePath] === file.size) {
      state.skipped++
      state.uploadedBytes += file.size
      return
    }

    let lastError
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal?.aborted) return
      try {
        await putObject(connection, `${prefix}/${file.relativePath}`, fs.createReadStream(file.fullPath), file.size, {
          signal,
        })
        lastError = null
        break
      } catch (err) {
        lastError = err
        // Wrong credentials/bucket won't fix themselves; stop retrying
        if ([400, 401, 403, 404, 499].includes(err.status)) break
        await sleep(500 * attempt)
      }
    }

    if (signal?.aborted) return
    if (lastError) {
      state.failed++
      if (state.errors.length < 20) state.errors.push({ file: file.relativePath, error: lastError.message })
      if ([401, 403, 404].includes(lastError.status)) state.fatal = lastError.message
    } else {
      state.uploaded++
      state.uploadedBytes += file.size
    }
  }

  // Phase by phase (segments → master playlists → manifest). A later phase only
  // starts when everything before it succeeded, so the series never goes live half-uploaded.
  for (const rank of [0, 1, 2]) {
    const queue = new Queue(files.filter((f) => uploadRank(f.relativePath) === rank))
    const worker = async () => {
      while (queue.length > 0 && !signal?.aborted && !state.fatal) await uploadOne(queue.shift())
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    if (signal?.aborted || state.fatal || state.failed > 0) break
  }
}
