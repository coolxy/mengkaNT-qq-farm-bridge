// QQ农场助手桥接 · 萌卡NT 3.0 native-ipc-v1 入口（v3.2.0，参考 qq-farm-bridge-ng 重构）
// stdout 只走 IPC 协议，日志全部 stderr。
// 管理端：优先监听框架分配的 MENGKA_PLUGIN_ADMIN_PORT（health/control 启动闸门，
// 卡片出现「管理插件」入口）；同时兜底监听 18089 供局域网直连与注入脚本使用。
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'

import { createIpc } from './lib/ipc.mjs'
import { createStore, resolveDataDir, normalizeOptions, normalizeServers, DEFAULT_OPTIONS } from './lib/store.mjs'
import { createPusher } from './lib/push.mjs'
import { makeSandboxFetch, sandboxDiagnostics } from './lib/sandbox-fetch.mjs'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN_DIR, 'mengka-plugin.json'), 'utf8'))
const PLUGIN_ID = MANIFEST.plugin_id
const VERSION = MANIFEST.version

const logRing = []
function log(level, msg) {
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + msg
  process.stderr.write(line + '\n')
  logRing.push(line)
  if (logRing.length > 300) logRing.shift()
}
const logger = {
  info: m => log('INFO', m),
  warn: m => log('WARN', m),
  error: m => log('ERROR', m),
  debug: m => log('DEBUG', m),
}

process.on('uncaughtException', e => logger.error('uncaught: ' + (e?.stack || e)))
process.on('unhandledRejection', e => logger.error('unhandled: ' + (e?.stack || e)))

const dataDir = resolveDataDir()
const store = createStore(dataDir)
logger.info('数据目录：' + dataDir)

function getOptions() { return normalizeOptions(store.read('options.json', legacyOptions())) }
function getServers() { return normalizeServers(store.read('servers.json', { farms: [], activeFarm: 0 })) }
const saveOptions = o => store.write('options.json', normalizeOptions(o))
const saveServers = s => store.write('servers.json', normalizeServers(s))

// 旧版（3.1.x 明文 config.json）→ 新 options.json 一次性迁移
function legacyOptions() {
  try {
    const f = join(dataDir, 'config.json')
    if (!existsSync(f)) return DEFAULT_OPTIONS
    const raw = JSON.parse(readFileSync(f, 'utf8')) || {}
    const mapped = normalizeOptions({
      intervalMinutes: raw.intervalMinutes ?? raw.interval_minutes,
      qqFilter: raw.qqFilter ?? raw.qq_filter,
      pushAndroid: raw.pushAndroid ?? raw.push_android,
      pushLinux: raw.pushLinux ?? raw.push_linux,
    })
    logger.info('已从旧版 config.json 迁移推送设置：间隔 ' + mapped.intervalMinutes + ' 分钟')
    return mapped
  } catch { return DEFAULT_OPTIONS }
}

// ---------- IPC ----------
const ipc = createIpc({
  pluginId: PLUGIN_ID,
  version: VERSION,
  frameworkApi: MANIFEST.framework_api,
  actions: MANIFEST.runtime.actions,
  log: logger,
  onEvent: ev => {
    const type = String(ev?.post_type || ev?.event_type || '').toLowerCase()
    if (type === 'bot_online' && getOptions().useEvents) {
      const selfId = ev?.self_id != null ? String(ev.self_id) : null
      logger.info('事件 bot_online' + (selfId ? '：' + selfId : '') + ' → 触发推送')
      pusher.push('事件 bot_online', { selfId }).catch(() => {})
    }
  },
  onLifecycle: m => { if (m?.event) logger.info('生命周期：' + m.event) },
})

const sandboxFetch = makeSandboxFetch({ logger })
const pusher = createPusher({ ipc, store, logger, getOptions, getServers, log, fetchImpl: sandboxFetch })

// ---------- 定时器 ----------
let timer = null
function reschedule() {
  if (timer) { clearInterval(timer); timer = null }
  const opts = getOptions()
  timer = setInterval(() => { pusher.push('定时').catch(() => {}) }, opts.intervalMinutes * 60 * 1000)
  logger.info('定时器：每 ' + opts.intervalMinutes + ' 分钟')
}

// ---------- 框架管理端环境 ----------
const adminPort = Number(process.env.MENGKA_PLUGIN_ADMIN_PORT || 0)
const adminHost = process.env.MENGKA_PLUGIN_ADMIN_HOST || '127.0.0.1'
const adminOrigin = String(process.env.MENGKA_PLUGIN_ADMIN_ORIGIN || '')
const uiPort = Number(process.env.MENGKA_PLUGIN_UI_PORT || 18089)
let adminToken = ''
try {
  const f = process.env.MENGKA_PLUGIN_ADMIN_TOKEN_FILE
  if (f) adminToken = readFileSync(f, 'utf8').trim()
} catch (e) { logger.warn('读取管理端令牌失败：' + e.message) }

function tokenOk(req) {
  if (!adminToken) return true // 本地/直连场景无令牌
  const raw = req.headers['x-mengka-managed-token']
  if (typeof raw !== 'string' || raw.length !== adminToken.length) return false
  try { return timingSafeEqual(Buffer.from(raw), Buffer.from(adminToken)) } catch { return false }
}

function originOk(req) {
  const origin = req.headers.origin
  if (!origin || !adminOrigin) return true
  return origin === adminOrigin
}

const pageHtml = (() => {
  const f = join(PLUGIN_DIR, 'web', 'index.html')
  return existsSync(f) ? readFileSync(f, 'utf8') : '<h1>UI missing</h1>'
})()

async function statePayload() {
  const opts = getOptions()
  const servers = getServers()
  let bots = []
  try { bots = await pusher.snapshot() } catch {}
  return {
    version: VERSION,
    plugin_id: PLUGIN_ID,
    repo: 'https://github.com/coolxy/mengkaNT-qq-farm-bridge',
    framework_api: MANIFEST.framework_api,
    platform: process.platform + '-' + process.arch,
    connected: ipc.ready,
    active: true,
    ui_port: uiPort,
    options: opts,
    // 兼容旧字段（注入脚本/旧页面可能还在用）
    config: { interval_minutes: opts.intervalMinutes, qq_filter: opts.qqFilter, push_android: opts.pushAndroid, push_linux: opts.pushLinux },
    farms: servers.farms.map((f, i) => ({ index: i, label: f.label, baseUrl: f.baseUrl, username: f.username, passwordSet: !!f.password, active: i === servers.activeFarm })),
    activeFarm: servers.activeFarm,
    bots,
    last: compatLast(pusher.lastResult),
    lastRaw: pusher.lastResult,
    logs: logRing.slice(-80),
  }
}

// ng 推送结果 → 旧版注入脚本可读的形状
function compatLast(r) {
  if (!r) return null
  const items = (r.items || []).map(i => ({
    selfId: i.selfId, nickname: i.nickname, platform: i.platform,
    ok: i.action === 'update' || i.action === 'create',
    skipped: i.action === 'skip',
    detail: i.detail || '',
    error: i.error || (i.action === 'skip' ? i.detail : ''),
    ms: i.ms || 0,
  }))
  return {
    reason: r.reason, at: r.at, ok: r.ok, empty: r.empty, error: r.error,
    farmUrl: r.farmUrl, total: r.total ?? items.length, success: r.changed ?? items.filter(i => i.ok).length,
    items,
  }
}

async function handler(req, res, secure = true) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-mengka-managed-token',
  }
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors }); res.end(JSON.stringify(body)) }
  const readBody = async () => { let b = ''; for await (const c of req) { b += c; if (b.length > 128 * 1024) throw new Error('body too large') } return b }

  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }

  // ---- 萌卡 3.0 启动闸门（不校验令牌，active 必须为 true）----
  if (path === '/api/managed/health') {
    return json(200, { ready: true, connected: ipc.ready, configured: true, active: true })
  }
  if (path === '/api/managed/control') {
    readBody().then(b => logger.info('框架控制：' + String(b).slice(0, 300))).catch(() => {})
    return json(200, { active: true })
  }

  if (!tokenOk(req) && secure) return json(403, { error: 'forbidden' })
  if (!originOk(req) && secure) return json(403, { error: 'origin rejected' })

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(pageHtml)
  }
  if (path === '/api/state') return json(200, await statePayload())

  if (path === '/api/farms' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody()) || '{}')
      const incoming = Array.isArray(body.farms) ? body.farms : []
      if (!incoming.length) return json(400, { error: '至少保留 1 台服务器' })
      const prev = getServers()
      const farms = incoming.slice(0, 8).map((f, i) => ({
        baseUrl: f.baseUrl,
        username: String(f.username ?? ''),
        password: (f.password !== undefined && String(f.password) !== '') ? String(f.password) : String(prev.farms[i]?.password || ''),
        label: String(f.label || prev.farms[i]?.label || (i === 0 ? 'FARM1' : 'FARM' + (i + 1))),
      }))
      saveServers({ farms, activeFarm: Number.isInteger(body.activeFarm) ? Math.max(0, Math.min(farms.length - 1, body.activeFarm)) : prev.activeFarm })
      pusher.resetSessions(); pusher.invalidate()
      logger.info('服务器列表已更新：' + farms.length + ' 台，推送目标 #' + getServers().activeFarm)
      return json(200, await statePayload())
    } catch (e) { return json(400, { error: String(e?.message || e) }) }
  }

  if (path === '/api/options' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody()) || '{}')
      // 兼容旧版蛇形字段
      const mapped = {
        intervalMinutes: body.intervalMinutes ?? body.interval_minutes,
        qqFilter: body.qqFilter ?? body.qq_filter,
        pushAndroid: body.pushAndroid ?? body.push_android,
        pushLinux: body.pushLinux ?? body.push_linux,
      }
      for (const k of Object.keys(mapped)) if (mapped[k] === undefined) delete mapped[k]
      saveOptions({ ...getOptions(), ...mapped })
      reschedule()
      return json(200, await statePayload())
    } catch (e) { return json(400, { error: String(e?.message || e) }) }
  }
  // 旧版 /api/config 兼容别名
  if (path === '/api/config' && req.method === 'POST') {
    req.url = '/api/options'
    return handler(req, res, secure)
  }

  if (path === '/api/push' && req.method === 'POST') {
    if (!ipc.ready) return json(503, { error: '框架 IPC 未就绪' })
    const r = await pusher.push('手动')
    return json(200, { last: compatLast(r), lastRaw: r })
  }

  // 单台测试连接（注入脚本「测试连接」用）
  if (path === '/api/farm/test' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody()) || '{}')
      const { createFarmClient, newSession } = await import('./lib/farm.mjs')
      const c = createFarmClient({ logger, fetchImpl: sandboxFetch })
      const farm = { baseUrl: String(body.baseUrl || ''), username: String(body.username || ''), password: String(body.password || '') }
      if (!farm.baseUrl) return json(400, { ok: false, error: '缺少 baseUrl' })
      const s = newSession()
      const mode = await c.detectMode(farm)
      if (mode !== 'none') await c.login(farm, s)
      const msg = mode === 'access-code' ? '访问 Code 校验通过（' + farm.baseUrl + '）'
        : mode === 'password' ? '账号密码登录成功（' + farm.baseUrl + '）'
        : '农场无登录验证，可直接推送（' + farm.baseUrl + '）'
      return json(200, { ok: true, mode, message: msg })
    } catch (e) { return json(200, { ok: false, error: String(e?.message || e) }) }
  }

  // 全部服务器连通性测试（管理页用）
  if (path === '/api/test' && req.method === 'POST') {
    const { createFarmClient, newSession } = await import('./lib/farm.mjs')
    const c = createFarmClient({ logger, fetchImpl: sandboxFetch })
    const out = []
    for (const f of getServers().farms) {
      const s = newSession()
      try {
        const list = await c.listAccounts(f, s)
        out.push({ baseUrl: f.baseUrl, ok: true, accounts: list.length, mode: s.mode })
      } catch (e) { out.push({ baseUrl: f.baseUrl, ok: false, error: String(e?.message || e) }) }
    }
    return json(200, { results: out })
  }

  return json(404, { error: 'not found' })
}

// ---------- 启动 ----------
logger.info('等待框架 IPC 就绪…')
sandboxDiagnostics(logger)
await ipc.start()
logger.info('插件已就绪 v' + VERSION + '，服务器 ' + getServers().farms.length + ' 台')
reschedule()

function listen(port, host, tag, secure = true) {
  const srv = createServer((req, res) => { Promise.resolve(handler(req, res, secure)).catch(e => { try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e?.message || e) })) } catch {} }) })
  srv.listen(port, host, () => logger.info(tag + '已监听 ' + host + ':' + port))
  srv.on('error', e => logger.error(tag + '监听失败：' + (e?.code || e)))
}

if (adminPort > 0) listen(adminPort, adminHost, '框架管理端', true)
else logger.warn('未收到 MENGKA_PLUGIN_ADMIN_PORT，管理端闸门不启动')

// 兜底直连入口（注入脚本/浏览器直连用；局域网信任，不走令牌）
if (uiPort > 0 && uiPort !== adminPort) listen(uiPort, '0.0.0.0', '直连管理页', false)

// 首次启动如果已配置服务器，推一轮
if (getServers().farms.length) {
  setTimeout(() => { pusher.push('启动').catch(() => {}) }, 3000)
}
