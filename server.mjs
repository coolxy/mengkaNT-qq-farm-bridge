// QQ农场助手桥接 · 本地调试/备用入口
// 在原生 IPC 之外，允许把本进程当作独立 HTTP 服务手动启动（不带框架时只提供管理页，便于调试 UI）。
// 正式安装请使用「插件导入」上传成品包，框架会以 native-ipc-v1 启动 native.mjs。
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ID, VERSION, makeLogger, createPusher, normalizeConfig, configProblems, resolveDataDirectory } from './core.mjs'
import { renderPage } from './ui.mjs'

const logger = makeLogger('[standalone]')
const dataDir = resolveDataDirectory()
mkdirSync(dataDir, { recursive: true })
const configFile = join(dataDir, 'config.json')

let config = {}
try { if (existsSync(configFile)) config = JSON.parse(readFileSync(configFile, 'utf8')) } catch (e) { logger.warn('读取配置失败：' + e.message) }
const saveConfig = value => { try { writeFileSync(configFile, JSON.stringify(value, null, 2)) } catch (e) { logger.warn('保存配置失败：' + e.message) } }

// 独立模式下没有框架，callAction 直接报错，界面仍可打开与改配置
const pusher = createPusher({
  callAction: async () => { throw new Error('独立模式未连接萌卡框架，请在萌卡中安装插件后再推送') },
  getConfig: () => config,
  logger,
})

const statePayload = async () => {
  const cfg = normalizeConfig(config)
  return {
    version: VERSION,
    platform: `${process.platform}-${process.arch}`,
    mode: 'standalone',
    connected: false,
    active: false,
    busy: pusher.busy,
    problems: configProblems(cfg),
    config: {
      farm_url: cfg.farmUrl, farm_username: cfg.username, password_set: !!cfg.password,
      interval_minutes: cfg.intervalMinutes, qq_filter: cfg.qqFilter.join(','),
      push_android: cfg.pushAndroid, push_linux: cfg.pushLinux,
    },
    bots: [],
    last: pusher.lastResult,
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
  if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(renderPage()) }
  if (path === '/api/state') return json(200, await statePayload())
  if (path === '/api/push' && req.method === 'POST') return json(503, { error: '独立模式未连接萌卡框架' })
  if (path === '/api/config' && req.method === 'POST') {
    let body = ''
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 16384) return json(413, { error: 'too large' }) }
      const b = JSON.parse(body || '{}')
      const next = { ...config }
      if (typeof b.farm_url === 'string') next.farm_url = b.farm_url.trim()
      if (typeof b.farm_username === 'string') next.farm_username = b.farm_username.trim()
      if (typeof b.farm_password === 'string' && b.farm_password) next.farm_password = b.farm_password
      if (b.interval_minutes != null) next.interval_minutes = Number(b.interval_minutes) || 5
      if (typeof b.qq_filter === 'string') next.qq_filter = b.qq_filter
      if (typeof b.push_android === 'boolean') next.push_android = b.push_android
      if (typeof b.push_linux === 'boolean') next.push_linux = b.push_linux
      config = next
      saveConfig(config)
      return json(200, await statePayload())
    } catch (e) { return json(400, { error: String(e?.message || e) }) }
  }
  json(404, { error: 'Not found' })
})

const host = process.env.QQFARM_ADMIN_HOST || '127.0.0.1'
const port = Number(process.env.QQFARM_ADMIN_PORT || 8088)
server.listen(port, host, () => logger.info(`${PLUGIN_ID} 独立管理页：http://${host}:${port}`))
