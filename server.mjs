// QQ农场助手桥接 · 本地调试/备用入口
// 不带框架时只提供管理页（可改服务器列表、看 UI），推送会提示未连接框架。
// 正式安装请用「插件导入」上传成品包，框架以 native-ipc-v1 启动 native.mjs。
import { createServer } from 'node:http'
import { PLUGIN_ID, VERSION, makeLogger, createPusher, normalizeConfig, normalizeFarmUrl,
  resolveDataDirectory, loadServers, saveServers, publicFarms } from './core.mjs'
import { renderPage } from './ui.mjs'

const logger = makeLogger('[standalone]')
const dataDir = resolveDataDirectory()
let config = {
  farm_url: process.env.QQFARM_URL || '',
  farm_username: process.env.QQFARM_USER || 'admin',
  farm_password: process.env.QQFARM_PASS || '',
  interval_minutes: 5,
}
let servers = loadServers(normalizeConfig(config), dataDir)

const pusher = createPusher({
  callAction: async () => { throw new Error('独立模式未连接萌卡框架，请在萌卡中安装插件后再推送') },
  getConfig: () => config,
  getServers: () => servers,
  saveServersState: st => saveServers(dataDir, st),
  logger,
})

const statePayload = async () => ({
  version: VERSION,
  platform: `${process.platform}-${process.arch}`,
  mode: 'standalone',
  connected: false,
  active: false,
  busy: pusher.busy,
  problems: [],
  farms: publicFarms(servers),
  activeFarm: servers.activeFarm,
  config: {
    farm_url: normalizeConfig(config).farmUrl,
    farm_username: normalizeConfig(config).username,
    password_set: !!normalizeConfig(config).password,
    interval_minutes: normalizeConfig(config).intervalMinutes,
    qq_filter: '',
    push_android: true, push_linux: false,
  },
  bots: [],
  last: pusher.lastResult,
})

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
  const readBody = async () => { let b = ''; for await (const c of req) { b += c; if (b.length > 65536) throw new Error('too large') } return b }
  if (path === '/' || path === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(renderPage()) }
  if (path === '/api/state') return json(200, await statePayload())
  if (path === '/api/farms' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody()) || '{}')
      const inc = Array.isArray(body.farms) ? body.farms : []
      if (!inc.length) return json(400, { error: '至少保留 1 台服务器' })
      const merged = inc.slice(0, 8).map((f, i) => {
        const old = servers.farms[i] || {}
        const baseUrl = normalizeFarmUrl(f.baseUrl || old.baseUrl || '')
        if (!baseUrl) return null
        return {
          baseUrl,
          username: String(f.username !== undefined ? f.username : (old.username || '')),
          password: (f.password !== undefined && String(f.password) !== '') ? String(f.password) : String(old.password || ''),
          label: i === 0 ? 'FARM1' : String(old.label || 'FARM' + (i + 1)),
        }
      }).filter(Boolean)
      if (!merged.length) return json(400, { error: '没有合法地址' })
      let active = Number.isInteger(body.activeFarm) ? body.activeFarm : servers.activeFarm
      active = Math.max(0, Math.min(merged.length - 1, active))
      servers = { farms: merged, activeFarm: active }
      saveServers(dataDir, servers)
      return json(200, await statePayload())
    } catch (e) { return json(400, { error: String(e?.message || e) }) }
  }
  if (path === '/api/push' && req.method === 'POST') return json(503, { error: '独立模式未连接萌卡框架' })
  json(404, { error: 'Not found' })
})

const host = process.env.QQFARM_ADMIN_HOST || '127.0.0.1'
const port = Number(process.env.QQFARM_ADMIN_PORT || 8088)
server.listen(port, host, () => logger.info(`${PLUGIN_ID} v${VERSION} 独立管理页：http://${host}:${port}`))
