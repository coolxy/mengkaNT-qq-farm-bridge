// 本地存储：AES-256-GCM 加密的 JSON（服务器凭据、绑定表、配置）
// 兼容迁移：旧版（3.1.x）落盘的明文 servers.json / config.json 可直接读取，
// 首次写回时自动升级为加密格式。
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export function resolveDataDir() {
  const env = process.env.MENGKA_PLUGIN_DATA_DIR
  if (env && env.trim()) return env
  return join(PLUGIN_DIR, 'data')
}

function keyFile(dir) { return join(dir, 'credential.key') }

function loadKey(dir) {
  mkdirSync(dir, { recursive: true })
  const f = keyFile(dir)
  try {
    const buf = readFileSync(f)
    if (buf.length === 32) return buf
  } catch { /* 首次运行 */ }
  const key = randomBytes(32)
  writeFileSync(f, key, { mode: 0o600 })
  try { chmodSync(f, 0o600) } catch {}
  return key
}

function seal(key, obj) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function open(key, payload) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
  d.setAuthTag(Buffer.from(payload.tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(payload.data, 'base64')), d.final()]).toString('utf8'))
}

function isSealed(j) {
  return j && typeof j === 'object' && typeof j.iv === 'string' && typeof j.tag === 'string' && typeof j.data === 'string'
}

export function createStore(dir = resolveDataDir()) {
  mkdirSync(dir, { recursive: true })
  const key = loadKey(dir)

  function read(name, fallback) {
    const f = join(dir, name)
    try {
      if (!existsSync(f)) return fallback
      const j = JSON.parse(readFileSync(f, 'utf8'))
      if (isSealed(j)) return open(key, j)
      return j // 旧版明文 JSON，直接返回；下次 write 自动加密
    } catch (e) {
      try { renameSync(f, f + '.corrupt-' + Date.now()) } catch {}
      return fallback
    }
  }

  function write(name, value) {
    const f = join(dir, name)
    const tmp = f + '.tmp'
    writeFileSync(tmp, JSON.stringify(seal(key, value)), { mode: 0o600 })
    renameSync(tmp, f)
    return true
  }

  return { dir, read, write }
}

export const DEFAULT_OPTIONS = {
  intervalMinutes: 5,
  useEvents: true,
  skipWhenOnline: true,
  refreshBeforeExpireMin: 5,
  startAfterUpdate: true,
  duplicatePolicy: 'keep-oldest',
  pushAndroid: true,
  pushLinux: false,
  qqFilter: '',
}

export function normalizeOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d, min, max) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d
  }
  return {
    intervalMinutes: num(o.intervalMinutes, DEFAULT_OPTIONS.intervalMinutes, 1, 240),
    useEvents: o.useEvents !== false,
    skipWhenOnline: o.skipWhenOnline !== false,
    refreshBeforeExpireMin: num(o.refreshBeforeExpireMin, DEFAULT_OPTIONS.refreshBeforeExpireMin, 0, 120),
    startAfterUpdate: o.startAfterUpdate !== false,
    duplicatePolicy: o.duplicatePolicy === 'ignore' ? 'ignore' : 'keep-oldest',
    pushAndroid: o.pushAndroid !== false,
    pushLinux: o.pushLinux === true,
    qqFilter: String(o.qqFilter || ''),
  }
}

export function normalizeFarmUrl(u) {
  let s = String(u || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  return s.replace(/\/+$/, '')
}

export function normalizeServers(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const farms = (Array.isArray(r.farms) ? r.farms : [])
    .slice(0, 8)
    .map((f, i) => ({
      baseUrl: normalizeFarmUrl(f?.baseUrl),
      username: String(f?.username || ''),
      password: String(f?.password || ''),
      label: String(f?.label || (i === 0 ? 'FARM1' : 'FARM' + (i + 1))),
    }))
    .filter(f => f.baseUrl)
  const activeFarm = farms.length
    ? Math.max(0, Math.min(farms.length - 1, Number.isInteger(r.activeFarm) ? r.activeFarm : 0))
    : 0
  return { farms, activeFarm }
}
