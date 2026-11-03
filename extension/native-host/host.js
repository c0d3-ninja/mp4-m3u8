#!/usr/bin/env node
// Chrome native-messaging host: owns ~/Desktop/dramas-next.json (a JSON array of dramas).
// Messages (JSON, 4-byte little-endian length prefix on stdin/stdout):
//   { action: 'ensure' }                 -> creates the file with [] if it is missing
//   { action: 'find', dramaId }          -> { ok, exists, entry? }
//   { action: 'add', entry }             -> appends, or replaces the entry with the same dramaId
//   { action: 'list' }                   -> { ok, entries } (the whole array, for the Gemini card)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FILE = path.join(os.homedir(), 'Desktop', 'dramas-next.json')

function ensureFile() {
  if (fs.existsSync(FILE)) return false
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, '[]\n')
  return true
}

function readList() {
  ensureFile()
  const text = fs.readFileSync(FILE, 'utf8').trim()
  if (!text) return []
  const data = JSON.parse(text)
  if (!Array.isArray(data)) throw new Error(`${FILE} does not contain a JSON array`)
  return data
}

function writeList(list) {
  const tmp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n')
  fs.renameSync(tmp, FILE)
}

const dramaIdOf = (entry) => {
  if (entry?.id) return String(entry.id)
  const m = String(entry?.dramaUrl || '').match(/\/shortdrama\/episode\/(\d+)/)
  return m ? m[1] : null
}

function handle(msg) {
  switch (msg?.action) {
    case 'ensure':
      return { ok: true, file: FILE, created: ensureFile() }
    case 'list':
      return { ok: true, file: FILE, entries: readList() }
    case 'find': {
      const entry = readList().find((e) => dramaIdOf(e) === String(msg.dramaId))
      return { ok: true, file: FILE, exists: !!entry, entry }
    }
    case 'add': {
      const entry = msg.entry
      if (!entry || typeof entry !== 'object') throw new Error('entry is required')
      const list = readList()
      const id = dramaIdOf(entry)
      const i = id ? list.findIndex((e) => dramaIdOf(e) === id) : -1
      if (i >= 0) {
        // Keep hand-written extras (app_dramaName, app_description, …) that the page doesn't provide.
        const kept = Object.fromEntries(Object.entries(list[i]).filter(([k]) => k.startsWith('app_') && !(k in entry)))
        list[i] = { ...entry, ...kept }
      }
      else list.push(entry)
      writeList(list)
      return { ok: true, file: FILE, updated: i >= 0, count: list.length }
    }
    default:
      throw new Error(`Unknown action: ${msg?.action}`)
  }
}

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([header, body]))
}

let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    if (buf.length < 4 + len) break
    const raw = buf.subarray(4, 4 + len).toString('utf8')
    buf = buf.subarray(4 + len)
    try {
      send(handle(JSON.parse(raw)))
    } catch (e) {
      send({ ok: false, error: e.message, file: FILE })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
