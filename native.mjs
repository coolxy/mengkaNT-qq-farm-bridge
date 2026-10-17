// QQ农场助手桥接 · 原生 IPC 入口（Windows / Linux 通用）
// 1) 通过 stdin/stdout 与框架通信（native-ipc-v1）；
// 2) 同时在 MENGKA_PLUGIN_ADMIN_PORT 上提供本机管理页（含「立即推送」按钮），
//    请求由框架插件网关代理进入，必须带一次性令牌头，令牌不落前端。
import { createServer } from 'node:http'
import { createNativePlugin } from './sdk/native-plugin.js'
import { authorizeManagedRequest, resolvePluginRuntime } from './sdk/plugin-runtime.js'
import { PLUGIN_ID, VERSION, MANIFEST, makeLogger, createPusher, normalizeConfig, configProblems } from './core.mjs'
import { renderPage } from './ui.mjs'

const logger = makeLogger('[native]')
const actions = (MANIFEST.runtime.actions || []).map(a => String(a).toLowerCase())

const plugin = createNativePlugin({ pluginId: PLUGIN_ID, version: VERSION, actions, events: [] })

// 管理端运行时（admin: true 时框架注入；缺失则不启动 HTTP 服务，退化为纯定时推送）
let adminRuntime = null
try {
  adminRuntime = resolvePluginRuntime()
  if (!adminRuntime.managed || !adminRuntime.adminPort) adminRuntime = null
} catch (e) {
  logger.warn('管理端不可用：' + (e?.message || e))
}

const pusher = createPusher({
  callAction: (action, params) => plugin.ctx.actions.call(action, params, { timeoutMs: 60000 }),
  getConfig: () => plugin.ctx.config.get(),
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

plugin.ctx.config.onChange((_c, revision) => {
  logger.info(`配置已更新到 revision ${revision}，重新调度`)
  pusher.resetSession()
  reschedule()
})

plugin.ctx.lifecycle.on('activate', async () => {
  activated = true
  logger.info(`插件已激活 ${PLUGIN_ID} v${VERSION}`)
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
    connected: plugin.ctx.ready,
    active: plugin.ctx.active,
    busy: pusher.busy,
    problems: configProblems(cfg),
    config: {
      farm_url: cfg.farmUrl,
      farm_username: cfg.username,
      password_set: !!cfg.password,
      interval_minutes: cfg.intervalMinutes,
      qq_filter: cfg.qqFilter.join(','),
      push_android: cfg.pushAndroid,
      push_linux: cfg.pushLinux,
    },
    bots: bots.map(b => ({ self_id: b.selfId, nickname: b.nickname, client_type: b.clientType, online: b.online })),
    last: pusher.lastResult,
  }
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
    if (path === '/api/managed/health') {
      return json(200, { ready: plugin.ctx.ready, connected: plugin.ctx.ready, configured: configProblems(normalizeConfig(plugin.ctx.config.get())).length === 0 })
    }
    if (!authorizeManagedRequest(adminRuntime, req)) return json(403, { error: '请从萌卡插件卡片的「管理后台」进入' })

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(renderPage())
    }
    if (path === '/api/state' && req.method === 'GET') return json(200, await statePayload())
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
startAdmin()
