// QQ农场助手桥接 · 公共模块（Windows / Linux 通用）
// 职责：读取配置、调用框架 Action 取码、推送到农场面板、批量推送。
// 日志统一写入 stderr，绝不污染 stdout（stdout 是框架的 IPC 通道）。
import { readFileSync } from 'node:fs'
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

// ---------- 配置 ----------
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
  if (!cfg.username) problems.push('农场管理员用户名未填写')
  if (!cfg.password) problems.push('农场管理员密码未填写')
  if (!cfg.pushAndroid && !cfg.pushLinux) problems.push('安卓与 Linux 推送均已关闭')
  return problems
}

// ---------- 农场面板 API ----------
export async function farmLogin(cfg, fetchImpl) {
  const res = await fetchImpl(cfg.farmUrl + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await res.json().catch(() => ({}))
  if (!j.ok || !j.data?.token) throw new Error('农场登录失败：' + (j.error || 'HTTP ' + res.status))
  return j.data.token
}

async function farmPost(cfg, token, name, code, fetchImpl) {
  const res = await fetchImpl(cfg.farmUrl + '/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({ name, code, platform: 'qq' }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await res.json().catch(() => ({}))
  return { status: res.status, j }
}

export async function farmPushAccount(session, name, code) {
  const { cfg, fetchImpl } = session
  let r = await farmPost(cfg, session.token, name, code, fetchImpl)
  const authProblem = r.status === 401 || (r.j?.ok === false && /token|登录|expired/i.test(String(r.j?.error || '')))
  if (authProblem) {
    session.token = await farmLogin(cfg, fetchImpl)
    r = await farmPost(cfg, session.token, name, code, fetchImpl)
  }
  if (r.status >= 400) throw new Error('农场返回 HTTP ' + r.status)
  if (r.j?.ok === false) throw new Error(r.j?.error || '农场返回失败')
  return true
}

// ---------- 账号筛选 ----------
// status: 0 离线 / 1 在线 / 2 登录中；也兼容已归一化的 {selfId, online} 对象
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

// ---------- 取码 ----------
export async function fetchFarmCode(callAction, target) {
  const result = await callAction('get_qq_farm_code', { self_id: Number(target.selfId), client_type: target.clientType })
  const code = result && result.code
  if (!code || !/^[0-9a-fA-F]{32}$/.test(String(code))) throw new Error('框架未返回有效 code')
  return String(code)
}

// ---------- 批量推送 ----------
// callAction(action, params) -> Promise<data>
// 同一时间的并发请求被合并为一次执行（手动点击与定时任务不会重复取码）
export function createPusher({ callAction, getConfig, fetchImpl = fetch, logger = log }) {
  let inflight = null
  let lastResult = null
  let lastOnline = []
  const session = { token: '', cfg: null, fetchImpl }

  async function listBots() {
    const bots = await callAction('get_bot_list', {})
    const list = (Array.isArray(bots) ? bots : (bots?.items || bots?.accounts || bots?.bots || []))
      .filter(b => b && b.self_id != null)
      .map(normalizeBot)
    lastOnline = list
    return list
  }

  async function runOnce(reason) {
    const started = Date.now()
    const cfg = normalizeConfig(getConfig())
    const problems = configProblems(cfg)
    if (problems.length) {
      const res = { reason, at: Date.now(), ok: false, error: '配置不完整：' + problems.join('、'), items: [] }
      lastResult = res
      logger.warn(res.error)
      return res
    }
    if (!hasAction('get_qq_farm_code')) {
      const res = { reason, at: Date.now(), ok: false, error: '当前框架不支持 get_qq_farm_code（仅 Android QQ 可取码）', items: [] }
      lastResult = res
      logger.warn(res.error)
      return res
    }
    session.cfg = cfg
    const targets = pickTargets(await listBots(), cfg)
    if (!targets.length) {
      const res = { reason, at: Date.now(), ok: true, empty: true, message: '没有匹配的在线 QQ（检查在线状态 / 平台开关 / 指定QQ过滤）', items: [] }
      lastResult = res
      logger.info(res.message)
      return res
    }
    if (!session.token) session.token = await farmLogin(cfg, fetchImpl)
    logger.info(`开始推送（${reason}）：${targets.length} 个账号 → ${cfg.farmUrl}`)
    const items = []
    for (const t of targets) {
      const t0 = Date.now()
      try {
        const code = await fetchFarmCode(callAction, t)
        await farmPushAccount(session, t.selfId, code)
        items.push({ selfId: t.selfId, nickname: t.nickname, clientType: t.clientType, ok: true, ms: Date.now() - t0 })
        logger.info(`[PUSH] ${t.selfId}${t.nickname ? '（' + t.nickname + '）' : ''} 推送成功 ${Date.now() - t0}ms`)
      } catch (e) {
        if (/token|登录失败/i.test(String(e?.message || ''))) session.token = ''
        items.push({ selfId: t.selfId, nickname: t.nickname, clientType: t.clientType, ok: false, error: String(e?.message || e), ms: Date.now() - t0 })
        logger.error(`[PUSH] ${t.selfId} 推送失败：${e?.message || e}`)
      }
    }
    const okCount = items.filter(i => i.ok).length
    const res = { reason, at: Date.now(), ok: okCount > 0, items, total: items.length, success: okCount, ms: Date.now() - started }
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
    // 供管理页展示的在线账号（最近一次 get_bot_list 的结果）
    async bots({ refresh = true } = {}) {
      if (refresh || !lastOnline.length) {
        try { await listBots() } catch { /* 保留旧快照 */ }
      }
      return lastOnline
    },
    resetSession() { session.token = '' },
    get lastResult() { return lastResult },
    get busy() { return !!inflight },
  }
}
