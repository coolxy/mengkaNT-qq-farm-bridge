// QQ农场助手桥接 · 公共模块（官方 SDK 版，Windows / Linux 通用）
// 职责：读取配置、管理多台农场服务器（增删/选择）、调用框架 Action 取码、推送到选中农场。
// 日志统一写入 stderr，绝不污染 stdout（stdout 是框架的 native-ipc 通道）。
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadManagedStorage } from './sdk/managed-connection.js'

export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
export const MANIFEST = JSON.parse(readFileSync(join(PLUGIN_DIR, 'mengka-plugin.json'), 'utf8'))
export const PLUGIN_ID = MANIFEST.plugin_id
export const VERSION = MANIFEST.version

// 不同端可声明的 Action 不同：Linux QQ 不支持农场取码，这里按声明自动降级
const DECLARED = new Set((MANIFEST.runtime.actions || []).map(a => String(a).toLowerCase()))

export function makeLogger(prefix) {
  const line = (level, msg) => process.stderr.write(`[${new Date().toISOString()}] [${level}] ${prefix} ${msg}\n`)
  return {
    info: m => line('INFO', m),
    warn: m => line('WARN', m),
    error: m => line('ERROR', m),
  }
}
export const log = makeLogger('[BRIDGE]')

export function hasAction(name) {
  return DECLARED.has(String(name).toLowerCase())
}

// 框架为每个实例分配的持久化数据目录（升级与重启后不变）
export function resolveDataDirectory() {
  try {
    const storage = loadManagedStorage()
    if (storage?.dataDirectory) return storage.dataDirectory
  } catch { /* 手动运行或旧版框架时忽略 */ }
  return join(PLUGIN_DIR, 'data')
}

// ---------- 配置（框架 config schema 下发） ----------
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const qqFilter = String(c.qq_filter || '')
    .split(/[,，\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
  const interval = Number(c.interval_minutes)
  return {
    farmUrl: String(c.farm_url || '').trim().replace(/\/+$/, ''),
    username: String(c.farm_username || '').trim(),
    password: String(c.farm_password || ''),
    intervalMinutes: Number.isFinite(interval) && interval > 0 ? Math.min(120, Math.max(1, interval)) : 5,
    qqFilter,
    pushAndroid: c.push_android !== false,
    pushLinux: c.push_linux === true,
  }
}

export function configProblems(cfg) {
  const problems = []
  if (!cfg.farmUrl) problems.push('农场地址未填写')
  if (!cfg.username && !cfg.password) problems.push('农场账号/密码（或访问 Code）未填写')
  if (!cfg.pushAndroid && !cfg.pushLinux) problems.push('安卓与 Linux 推送均已关闭')
  return problems
}

export function normalizeFarmUrl(u) {
  let s = String(u || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  return s.replace(/\/+$/, '')
}

// ---------- 多农场服务器列表（插件页面可增删/切换，落盘 servers.json） ----------
function serversFile(dataDir) {
  return join(dataDir, 'servers.json')
}

function seedFarms(cfg, dataDir) {
  // 迁移：websocket 版插件把农场列表存在同目录 config.json，直接继承，避免用户重填
  const legacy = join(dataDir, 'config.json')
  try {
    if (existsSync(legacy)) {
      const j = JSON.parse(readFileSync(legacy, 'utf8'))
      if (Array.isArray(j.farms) && j.farms.length) {
        return {
          farms: j.farms.map((f, i) => ({
            baseUrl: normalizeFarmUrl(f.baseUrl),
            username: String(f.username || ''),
            password: String(f.password || ''),
            label: String(f.label || 'FARM' + (i + 1)),
          })).filter(f => f.baseUrl),
          activeFarm: Number.isInteger(j.activeFarm) ? j.activeFarm : 0,
        }
      }
    }
  } catch { /* 忽略，退回框架配置 */ }
  return {
    farms: cfg.farmUrl
      ? [{ baseUrl: normalizeFarmUrl(cfg.farmUrl), username: cfg.username, password: cfg.password, label: 'FARM1' }]
      : [],
    activeFarm: 0,
  }
}

export function loadServers(cfg, dataDir) {
  const file = serversFile(dataDir)
  let state = null
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(j.farms)) state = j
    }
  } catch { /* 损坏则重建 */ }
  // 框架配置只在首次安装（还没有 servers.json）时用来种出第 1 台；
  // 之后服务器列表完全以管理后台维护的 servers.json 为准（v1.6.2 起，不再被框架配置覆盖）。
  if (!state) state = seedFarms(cfg, dataDir)
  if (typeof state.configSyncUrl !== 'string') state.configSyncUrl = ''
  state.farms = state.farms
    .map((f, i) => ({
      baseUrl: normalizeFarmUrl(f.baseUrl),
      username: String(f.username || ''),
      password: String(f.password || ''),
      label: String(f.label || 'FARM' + (i + 1)),
    }))
    .filter(f => f.baseUrl)
  const n = Number.isInteger(state.activeFarm) ? state.activeFarm : 0
  state.activeFarm = Math.max(0, Math.min(state.farms.length - 1, n))
  return state
}

export function saveServers(dataDir, state) {
  try {
    mkdirSync(dataDir, { recursive: true })
    const file = serversFile(dataDir)
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify({
      farms: state.farms,
      activeFarm: state.activeFarm,
      configSyncUrl: String(state.configSyncUrl || ''),
    }, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch (e) {
    log.warn('保存服务器列表失败：' + e.message)
    return false
  }
}

// ---------- 配置面板 → 服务器列表 同步（v1.6.2） ----------
// 萌卡卡片「配置」里的 farm_url/farm_username/farm_password 改动按以下规则合并进服务器列表：
//  1) 地址已在列表中 → 只更新该台的账号/密码（密码留空不覆盖，框架密文字段可能不回显）；
//  2) 地址是新的 → 新增一台并设为推送目标；
//  3) 列表本身的增删/选择以管理后台为准，配置面板不会覆盖或删减它。
export function syncConfigFarms(cfg, state) {
  const url = normalizeFarmUrl(cfg.farmUrl)
  if (!url) return { state, changed: false, note: '' }
  const farms = state.farms.map(f => ({ ...f }))
  const idx = farms.findIndex(f => f.baseUrl === url)
  let note = ''
  if (idx >= 0) {
    const f = farms[idx]
    if (cfg.username && f.username !== cfg.username) f.username = cfg.username
    if (cfg.password && f.password !== cfg.password) f.password = cfg.password
    note = `配置改动已合并到第 ${idx + 1} 台（${url}）`
  } else {
    farms.push({ baseUrl: url, username: cfg.username || '', password: cfg.password || '', label: 'FARM' + (farms.length + 1) })
    note = `配置里的新地址已作为第 ${farms.length} 台加入并设为推送目标（${url}）`
  }
  const next = {
    farms,
    activeFarm: idx >= 0 ? state.activeFarm : farms.length - 1,
    configSyncUrl: url,
  }
  next.activeFarm = Math.max(0, Math.min(next.farms.length - 1, next.activeFarm))
  return { state: next, changed: true, note }
}

export function publicFarms(state) {
  return state.farms.map((f, i) => ({
    index: i,
    label: f.label,
    baseUrl: f.baseUrl,
    username: f.username,
    passwordSet: !!f.password,
    active: i === state.activeFarm,
  }))
}

// ---------- 农场面板 API（三种后台形态自适应） ----------
// 1) access-code：/api/auth/status 显示已设置「访问 Code」，/api/login {code} 换会话 Cookie
// 2) password   ：/api/login {username,password} → data.token
// 3) none       ：/api/login 不存在（无登录验证）→ 不带令牌直接推送
function newSession() {
  return { mode: '', token: '', cookie: '', blockedUntil: 0, failStreak: 0 }
}

export function makeFarmClient(fetchImpl = fetch, logger = log) {
  async function detectMode(farm) {
    try {
      const res = await fetchImpl(farm.baseUrl + '/api/auth/status', { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const d = await res.json().catch(() => ({}))
        if (d && d.ok && d.data && typeof d.data.setupRequired === 'boolean') {
          if (d.data.setupRequired) {
            throw new Error(`[${farm.baseUrl}] 农场后台尚未设置「访问 Code」：请先在农场面板完成首次设置`)
          }
          logger.info(`[${farm.baseUrl}] 后台为「访问 Code」模式 → 用密码字段作为访问 Code`)
          return 'access-code'
        }
      }
    } catch (e) {
      if (/访问 Code/.test(String(e?.message))) throw e
    }
    try {
      const res = await fetchImpl(farm.baseUrl + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000),
      })
      if (res.status === 404) {
        logger.info(`[${farm.baseUrl}] 无登录验证（/api/login 404）→ 直接推送`)
        return 'none'
      }
      return 'password'
    } catch (e) {
      throw new Error(`农场无法连接（${farm.baseUrl}）：${e?.message || e}`)
    }
  }

  async function login(farm, session) {
    const now = Date.now()
    if (now < session.blockedUntil) {
      throw new Error(`[${farm.baseUrl}] 登录冷却中，还需 ${Math.ceil((session.blockedUntil - now) / 1000)} 秒（此前登录失败/被限流）`)
    }
    if (session.mode === '') session.mode = await detectMode(farm)
    if (session.mode === 'none') return ''
    if (session.mode === 'access-code') {
      const res = await fetchImpl(farm.baseUrl + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: farm.password }), signal: AbortSignal.timeout(20000),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) {
        if (res.status === 409) { session.mode = ''; throw new Error(`[${farm.baseUrl}] 访问 Code 未设置（HTTP 409），请先在农场面板设置`) }
        if (res.status === 401) {
          session.failStreak += 1
          const backoff = Math.min(60 * 60 * 1000, 5 * 60 * 1000 * Math.pow(2, session.failStreak - 1))
          session.blockedUntil = Date.now() + backoff
          throw new Error(`[${farm.baseUrl}] 访问 Code 被拒(第${session.failStreak}次)，${Math.round(backoff / 60000)} 分钟内不再重试`)
        }
        throw new Error(`[${farm.baseUrl}] 访问 Code 登录失败：HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}`)
      }
      const setc = String(res.headers.get('set-cookie') || '')
      const m = setc.match(/farm_admin_session=([^;]+)/)
      session.cookie = m ? decodeURIComponent(m[1]) : ''
      session.token = session.cookie || String(j.data?.token || '')
      if (!session.token) throw new Error(`[${farm.baseUrl}] 访问 Code 登录成功但未拿到会话令牌`)
      session.failStreak = 0; session.blockedUntil = 0
      logger.info(`[${farm.baseUrl}] ✔ 已用访问 Code 登录农场`)
      return session.token
    }
    const res = await fetchImpl(farm.baseUrl + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: farm.username, password: farm.password }), signal: AbortSignal.timeout(20000),
    })
    if (res.status === 404) { session.mode = 'none'; return '' }
    const j = await res.json().catch(() => ({}))
    if (!res.ok || !j.data?.token) {
      if (res.status === 401) {
        session.failStreak += 1
        const backoff = Math.min(60 * 60 * 1000, 5 * 60 * 1000 * Math.pow(2, session.failStreak - 1))
        session.blockedUntil = Date.now() + backoff
        throw new Error(`[${farm.baseUrl}] 密码被拒(第${session.failStreak}次)，${Math.round(backoff / 60000)} 分钟内不再重试`)
      }
      throw new Error(`[${farm.baseUrl}] 农场登录失败：HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}`)
    }
    session.token = String(j.data.token)
    session.failStreak = 0; session.blockedUntil = 0
    logger.info(`[${farm.baseUrl}] ✔ 管理令牌已获取/续期`)
    return session.token
  }

  async function api(farm, session, method, path, body, retried = false) {
    if (!session.token && session.mode !== 'none') await login(farm, session)
    const headers = { 'Content-Type': 'application/json' }
    if (session.token) {
      headers['x-admin-token'] = session.token
      if (session.mode === 'access-code' && session.cookie) headers['Cookie'] = 'farm_admin_session=' + encodeURIComponent(session.cookie)
    }
    const res = await fetchImpl(farm.baseUrl + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let data; try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 200) } }
    if (res.status === 401 && !retried) {
      session.token = ''; session.cookie = ''
      if (session.mode === 'none') session.mode = ''
      await login(farm, session)
      return api(farm, session, method, path, body, true)
    }
    if (!res.ok || data?.ok === false) throw new Error(`[${farm.baseUrl}] ${method} ${path} → HTTP ${res.status} ${JSON.stringify(data).slice(0, 160)}`)
    return data
  }

  return { detectMode, login, api, newSession }
}

function findAccount(accounts, qq) {
  return accounts.find(a => String(a.qq || '') === qq || String(a.uin || '') === qq)
      || accounts.find(a => String(a.name || '') === qq)
}

// ---------- 取码 ----------
export async function fetchFarmCode(callAction, target) {
  const result = await callAction('get_qq_farm_code', { self_id: Number(target.selfId), client_type: target.clientType })
  const code = result && (result.code ?? result.Code)
  if (!code) throw new Error('框架未返回 code')
  return String(code)
}

// ---------- 账号筛选 ----------
export function normalizeBot(b) {
  const platform = String(b.platform || '')
  const clientType = String(b.client_type || b.clientType || '')
  const linux = platform === 'linux' || clientType === 'linuxqq'
  const online = typeof b.online === 'boolean' ? b.online : Number(b.status) === 1
  return {
    selfId: String(b.self_id ?? b.selfId),
    nickname: String(b.nickname || ''),
    clientType: linux ? 'linuxqq' : 'android',
    linux,
    online,
  }
}

export function pickTargets(bots, cfg) {
  const list = Array.isArray(bots) ? bots : (bots?.items || bots?.accounts || bots?.bots || [])
  return list
    .filter(b => b && (b.self_id != null || b.selfId != null))
    .map(normalizeBot)
    .filter(b => (b.linux ? cfg.pushLinux : cfg.pushAndroid))
    .filter(b => b.online)
    .filter(b => !cfg.qqFilter.length || cfg.qqFilter.includes(b.selfId))
}

// ---------- 批量推送（只推到「选中的服务器」） ----------
export function createPusher({ callAction, getConfig, getServers, saveServersState, fetchImpl = fetch, logger = log }) {
  let inflight = null
  let lastResult = null
  let lastOnline = []
  const client = makeFarmClient(fetchImpl, logger)
  const sessions = new Map()   // baseUrl -> session

  function sessionFor(farm) {
    let s = sessions.get(farm.baseUrl)
    if (!s) { s = client.newSession(); sessions.set(farm.baseUrl, s) }
    return s
  }

  async function listBots() {
    const bots = await callAction('get_bot_list', {})
    const list = (Array.isArray(bots) ? bots : (bots?.items || bots?.accounts || bots?.bots || []))
      .filter(b => b && b.self_id != null)
      .map(normalizeBot)
    lastOnline = list
    return list
  }

  async function pushOne(farm, target) {
    const session = sessionFor(farm)
    const accountsData = await client.api(farm, session, 'GET', '/api/accounts')
    const accounts = Array.isArray(accountsData?.data?.accounts) ? accountsData.data.accounts : []
    const acc = findAccount(accounts, target.selfId)
    const code = await fetchFarmCode(callAction, target)
    const name = acc?.name || target.nickname || target.selfId
    const body = acc
      ? { id: acc.id, name: acc.name, code, platform: 'qq', uin: target.selfId, qq: target.selfId }
      : { name, code, platform: 'qq', uin: target.selfId, qq: target.selfId }
    await client.api(farm, session, 'POST', '/api/accounts', body)
    return code
  }

  async function runOnce(reason) {
    const started = Date.now()
    const cfg = normalizeConfig(getConfig())
    const state = getServers(cfg)
    const farm = state.farms[state.activeFarm]
    if (!farm) {
      const res = { reason, at: Date.now(), ok: false, error: '没有可用的农场服务器：请在插件页面「服务器管理」里新增一台', items: [] }
      lastResult = res; logger.warn(res.error); return res
    }
    if (!hasAction('get_qq_farm_code')) {
      const res = { reason, at: Date.now(), ok: false, error: '当前框架不支持 get_qq_farm_code（仅 Android QQ 可取码）', items: [] }
      lastResult = res; logger.warn(res.error); return res
    }
    const targets = pickTargets(await listBots(), cfg)
    if (!targets.length) {
      const res = { reason, at: Date.now(), ok: true, empty: true, farmUrl: farm.baseUrl, message: '没有匹配的在线 QQ（检查在线状态 / 平台开关 / 指定QQ过滤）', items: [] }
      lastResult = res; logger.info(res.message); return res
    }
    logger.info(`开始推送（${reason}）：${targets.length} 个账号 → ${farm.baseUrl}`)
    const items = []
    for (const t of targets) {
      const t0 = Date.now()
      try {
        const code = await pushOne(farm, t)
        items.push({ selfId: t.selfId, nickname: t.nickname, clientType: t.clientType, ok: true, ms: Date.now() - t0, code: code.slice(0, 6) + '***' })
        logger.info(`[PUSH] ${t.selfId} 推送成功 ${Date.now() - t0}ms`)
      } catch (e) {
        if (/登录|令牌|token/i.test(String(e?.message || ''))) { const s = sessions.get(farm.baseUrl); if (s) s.token = '' }
        items.push({ selfId: t.selfId, nickname: t.nickname, clientType: t.clientType, ok: false, error: String(e?.message || e), ms: Date.now() - t0 })
        logger.error(`[PUSH] ${t.selfId} 推送失败：${e?.message || e}`)
      }
    }
    const okCount = items.filter(i => i.ok).length
    const res = { reason, at: Date.now(), ok: okCount > 0, farmUrl: farm.baseUrl, items, total: items.length, success: okCount, ms: Date.now() - started }
    lastResult = res
    logger.info(`[SYNC] 本轮完成：${okCount}/${items.length} 成功，用时 ${res.ms}ms`)
    return res
  }

  return {
    push(reason = '手动') {
      if (inflight) return inflight
      inflight = runOnce(reason).catch(e => {
        const res = { reason, at: Date.now(), ok: false, error: String(e?.message || e), items: [] }
        lastResult = res
        logger.error('推送流程异常：' + res.error)
        return res
      }).finally(() => { inflight = null })
      return inflight
    },
    async bots({ refresh = true } = {}) {
      if (refresh || !lastOnline.length) {
        try { await listBots() } catch { /* 保留旧快照 */ }
      }
      return lastOnline
    },
    resetSession(farmUrl) {
      if (farmUrl) sessions.delete(farmUrl)
      else sessions.clear()
    },
    // 服务器列表变更后同步落盘
    saveServers(state) { return saveServersState(state) },
    get lastResult() { return lastResult },
    get busy() { return !!inflight },
  }
}
