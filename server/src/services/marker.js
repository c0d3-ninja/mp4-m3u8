import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * "converted/<id>/.job.json" remembers where a conversion came from and where it was uploaded:
 *   { id, source, createdAt, status: converting | done | failed, completedAt, episodes, uploads: [{ bucket, prefix, at }] }
 * It is hidden (leading dot), so neither Cloudflare upload sends it to the bucket.
 */
export const MARKER_FILE = '.job.json'

const locks = new Map() // dir -> promise chain, so concurrent updates never overwrite each other

export async function readMarker(dir) {
  try {
    const data = JSON.parse(await fsp.readFile(path.join(dir, MARKER_FILE), 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

/** Read-modify-write the marker, serialised per folder. Never throws: the marker is bookkeeping only. */
export function updateMarker(dir, change) {
  const run = async () => {
    const next = change((await readMarker(dir)) || {})
    await fsp.writeFile(path.join(dir, MARKER_FILE), `${JSON.stringify(next, null, 2)}\n`)
  }
  const prev = locks.get(dir) || Promise.resolve()
  const done = prev.then(run, run).catch((err) => console.error(`Could not update ${MARKER_FILE} in ${dir}:`, err.message))
  locks.set(dir, done)
  done.finally(() => {
    if (locks.get(dir) === done) locks.delete(dir)
  })
  return done
}

/**
 * Remember a finished, verified Cloudflare upload (one entry per bucket + prefix, newest wins).
 * `files` is how many files were confirmed in the bucket.
 */
export function recordUpload(dir, { bucket, prefix, files }) {
  return updateMarker(dir, (m) => ({
    ...m,
    uploads: [
      ...(Array.isArray(m.uploads) ? m.uploads : []).filter((u) => !(u.bucket === bucket && u.prefix === prefix)),
      { bucket, prefix, at: new Date().toISOString(), verified: true, files: files ?? null },
    ],
  }))
}

/** Forget an upload record, e.g. when Verify finds files missing from the bucket. */
export function forgetUpload(dir, { bucket, prefix }) {
  return updateMarker(dir, (m) => ({
    ...m,
    uploads: (Array.isArray(m.uploads) ? m.uploads : []).filter((u) => !(u.bucket === bucket && u.prefix === prefix)),
  }))
}
