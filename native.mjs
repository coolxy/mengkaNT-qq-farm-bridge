// QQ农场助手桥接 · 原生 IPC 入口（Windows / Linux 通用）
// 1) 通过 stdin/stdout 与框架通信（native-ipc-v1）；
// 2) 同时在 MENGKA_PLUGIN_ADMIN_PORT 上提供本机管理页（服务器管理 + 立即推送），
//    请求由框架插件网关代理进入，必须带一次性令牌头，令牌不落前端。
import { createServer } from 'node:http'
import { createNativePlugin } from './sdk/native-plugin.js'
import { authorizeManagedRequest, resolvePluginRuntime } from './sdk/plugin-runtime.js'
import {
  PLUGIN_ID, VERSION, MANIFEST, makeLogger, createPusher, normalizeConfig, configProblems,
  resolveDataDirectory, loadServers, saveServers, publicFarms, normalizeFarmUrl, syncConfigFarms,
} from './core.mjs'
import { renderPage } from './ui.mjs'

const logger = makeLogger('[native]')
const actions = (MANIFEST.runtime.actions || []).map(a => String(a).toLowerCase())
const dataDir = resolveDataDirectory()

const plugin = createNativePlugin({ pluginId: PLUGIN_ID, version: VERSION, actions, events: [] })

// 管理端运行时（admin: true 时框架注入；缺失则不启动 HTTP 服务，退化为纯定时推送）
let adminRuntime = null
try {
  adminRuntime = resolvePluginRuntime()
  if (!adminRuntime.managed || !adminRuntime.adminPort) adminRuntime = null
} catch (e) {
  logger.warn('管理端不可用：' + (e?.message || e))
}

// 服务器列表（选中哪台就推哪台）；列表以管理后台维护的 servers.json 为准，
// 萌卡卡片「配置」里的主服务器改动通过 syncConfig() 合并进来（v1.6.2）
let servers = loadServers(normalizeConfig(plugin.ctx.config.get()), dataDir)

function syncConfig() {
  const cfg = normalizeConfig(plugin.ctx.config.get())
  const r = syncConfigFarms(cfg, servers)
  if (r.changed) {
    servers = r.state
    saveServers(dataDir, servers)
    if (r.note) logger.info('配置同步：' + r.note)
  }
  return cfg
}

const pusher = createPusher({
  callAction: (action, params) => plugin.ctx.actions.call(action, params, { timeoutMs: 60000 }),
  getConfig: () => plugin.ctx.config.get(),
  getServers: () => servers,
  saveServersState: st => saveServers(dataDir, st),
  logger,
})

// ---------- 定时器 ----------
let timer = null
let activated = false
function reschedule() {
  if (timer) { clearInterval(timer); timer = null }
  if (!activated) return
  const minutes = normalizeConfig(plugin.ctx.config.get()).intervalMinutes
  timer = setInterval(() => { void pusher.push('定时') }, minutes * 60 * 1000)
  logger.info(`定时器已启动：每 ${minutes} 分钟推送一次`)
}

plugin.ctx.config.onChange(() => {
  // 主服务器地址/账号可能在萌卡卡片「配置」里被改过 → 合并进服务器列表（不覆盖管理后台维护的列表）
  syncConfig()
  pusher.resetSession()
  reschedule()
})

plugin.ctx.lifecycle.on('activate', async () => {
  activated = true
  logger.info(`插件已激活 ${PLUGIN_ID} v${VERSION}，服务器 ${servers.farms.length} 台，推送目标：${servers.farms[servers.activeFarm]?.baseUrl || '未配置'}`)
  reschedule()
  await pusher.push('启动')
})

plugin.ctx.lifecycle.on('stop', () => {
  activated = false
  if (timer) { clearInterval(timer); timer = null }
  logger.info('插件停止')
})

// ---------- 本机管理端 ----------
const statePayload = async () => {
  const cfg = normalizeConfig(plugin.ctx.config.get())
  let bots = []
  try { bots = await pusher.bots() } catch { /* 框架未连接时忽略 */ }
  return {
    version: VERSION,
    platform: `${process.platform}-${process.arch}`,
    mode: adminRuntime ? 'native' : 'standalone',
    connected: plugin.ctx.ready,
    active: plugin.ctx.active,
    busy: pusher.busy,
    problems: configProblems(cfg),
    farms: publicFarms(servers),
    activeFarm: servers.activeFarm,
    config: {
      farm_url: cfg.farmUrl,
      farm_username: cfg.username,
      password_set: !!cfg.password,
      interval_minutes: cfg.intervalMinutes,
      qq_filter: cfg.qqFilter.join(','),
      push_android: cfg.pushAndroid,
      push_linux: cfg.pushLinux,
      synced_url: String(servers.configSyncUrl || ''),
    },
    bots: bots.map(b => ({ self_id: b.selfId, nickname: b.nickname, client_type: b.clientType, online: b.online })),
    last: pusher.lastResult,
  }
}

function applyServersPayload(body) {
  const incoming = body?.farms
  if (!Array.isArray(incoming) || !incoming.length) throw new Error('至少保留 1 台服务器')
  const merged = []
  for (let i = 0; i < incoming.length && i < 8; i++) {
    const inc = incoming[i] || {}
    const old = servers.farms[i] || {}
    const baseUrl = normalizeFarmUrl(inc.baseUrl || old.baseUrl || '')
    if (!baseUrl) continue
    merged.push({
      baseUrl,
      username: String(inc.username !== undefined ? inc.username : (old.username || '')),
      password: (inc.password !== undefined && String(inc.password) !== '') ? String(inc.password) : String(old.password || ''),
      label: i === 0 ? 'FARM1' : String(old.label || 'FARM' + (i + 1)),
    })
  }
  if (!merged.length) throw new Error('没有合法的服务器地址（需要 http:// 或 https:// 开头）')
  let active = Number.isInteger(body.activeFarm) ? body.activeFarm : servers.activeFarm
  active = Math.max(0, Math.min(merged.length - 1, active))
  servers = { farms: merged, activeFarm: active }
  saveServers(dataDir, servers)
  return servers
}

function startAdmin() {
  if (!adminRuntime) return
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const readBody = async () => {
      let buf = ''
      for await (const chunk of req) { buf += chunk; if (buf.length > 64 * 1024) throw new Error('请求体过大') }
      return buf
    }
    if (path === '/api/managed/health') {
      return json(200, {
        ready: plugin.ctx.ready,
        connected: plugin.ctx.ready,
        configured: servers.farms.length > 0,
        active: plugin.ctx.active,
      })
    }
    if (!authorizeManagedRequest(adminRuntime, req)) return json(403, { error: '请从萌卡插件卡片的「管理后台」进入' })

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(renderPage())
    }
    if (path === '/api/state' && req.method === 'GET') return json(200, await statePayload())

    // 服务器管理：新增/删除/切换（推送目标=选中的那台）
    if (path === '/api/farms' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody()) || '{}')
        applyServersPayload(body)
        pusher.resetSession()
        logger.info(`服务器列表已更新：${servers.farms.length} 台，推送目标 ${servers.farms[servers.activeFarm]?.baseUrl}`)
        return json(200, await statePayload())
      } catch (e) {
        return json(400, { error: String(e?.message || e) })
      }
    }
    if (path === '/api/push' && req.method === 'POST') {
      if (!plugin.ctx.ready) return json(503, { error: '框架尚未就绪，请稍后再试' })
      if (plugin.ctx.active === false) return json(503, { error: '插件未激活，请先在萌卡插件卡片中启动插件' })
      return json(200, { last: await pusher.push('手动') })
    }
    return json(404, { error: 'Not found' })
  })
  server.requestTimeout = 180000
  server.on('error', e => logger.error('管理端监听失败：' + (e?.code || e)))
  server.listen(adminRuntime.adminPort, adminRuntime.adminHost || '127.0.0.1')
  logger.info(`管理端已监听 ${adminRuntime.adminHost || '127.0.0.1'}:${adminRuntime.adminPort}`)
}

await plugin.start()
// 注意：ready 之前框架下发的 config 还读不到，必须等 start() 返回后再补种服务器列表，
// 否则全新安装（数据目录没有 servers.json）会得到 0 台服务器，激活后直接报「没有可用的农场服务器」。
servers = loadServers(normalizeConfig(plugin.ctx.config.get()), dataDir)
syncConfig()
saveServers(dataDir, servers)
logger.info(`框架配置已就绪：${servers.farms.length} 台服务器，推送目标 ${servers.farms[servers.activeFarm]?.baseUrl || '未配置'}`)
startAdmin()
