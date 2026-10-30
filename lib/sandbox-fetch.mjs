// 沙箱网络兼容层（萌卡 3.0.5 Landlock 适配）
// 问题：沙箱拒绝读取 /etc/{nsswitch.conf,hosts,resolv.conf} 等，glibc getaddrinfo
// 无法完成解析，node 的 fetch（undici→net.connect→dns.lookup）全部超时。
// 方案：自带解析链 —— ① 包启动时预载 /etc/hosts（可读则用）② DoH（1.1.1.1 / 8.8.4.4，
// 直连 IP + IP SAN 证书）③ 全部失败才报错；fetch 实现为 http/https + 自定义 lookup，
// SNI/证书校验仍按原域名进行。
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'

const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]|[0-9a-fA-F:]+:\d{0,5})$/
const isIp = h => IP_RE.test(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)

// ---- /etc/hosts 预载（沙箱内可能拒绝读取，忽略即可）----
const hostsMap = new Map()
try {
  for (const line of String(readFileSync('/etc/hosts', 'utf8')).split('\n')) {
    if (/^\s*#/.test(line)) continue
    const m = line.match(/^\s*([0-9a-fA-F:.]+)\s+(.+)$/)
    if (!m) continue
    for (const name of m[2].split(/\s+/)) {
      if (name && !hostsMap.has(name)) hostsMap.set(name, m[1].replace(/^\[|\]$/g, ''))
    }
  }
} catch {}

// ---- DoH 解析（JSON API，直连 IP）----
const dohCache = new Map() // name -> { ip, at }
// 选用国内可达的 DoH（1.1.1.1 / 8.8.4.4 在部分网络不可达）；阿里 DoH 证书含 IP SAN，可直连 IP
const DOH_SERVERS = [
  { host: '223.5.5.5', path: '/resolve' },
  { host: '223.6.6.6', path: '/resolve' },
]

let dbg = null
function setDebugLogger(fn) { dbg = fn }

function dohQuery(server, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: server.host,
      path: server.path + '?name=' + encodeURIComponent(name) + '&type=A',
      method: 'GET',
      headers: { accept: 'application/dns-json' },
      // DoH 服务器本身就是 IP，直接短路 lookup，避免递归解析
      lookup: (h, o, cb) => cb(null, server.host, 4),
      autoSelectFamily: false,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (e) { reject(e) }
      })
      res.on('error', reject)
    })
    // 显式计时器：connect 挂起时 req.setTimeout 不可靠
    const timer = setTimeout(() => { try { req.destroy() } catch {} reject(new Error('doh timeout')) }, timeoutMs)
    req.on('error', e => { clearTimeout(timer); reject(e) })
    req.on('response', () => clearTimeout(timer))
    req.end()
  })
}

async function resolveHost(name) {
  if (isIp(name)) return name
  const cached = dohCache.get(name)
  if (cached && Date.now() - cached.at < 300000) return cached.ip
  const neg = dohCache.get('!' + name)
  if (neg && Date.now() - neg.at < 15000) throw new Error('沙箱 DNS 解析失败（近期失败，负缓存）: ' + name)
  if (hostsMap.has(name)) {
    const ip = hostsMap.get(name)
    dohCache.set(name, { ip, at: Date.now() })
    return ip
  }
  for (const server of DOH_SERVERS) {
    try {
      const j = await dohQuery(server, name, 4000)
      const answers = (Array.isArray(j?.Answer) ? j.Answer : []).filter(a => a.type === 1 && a.data)
      if (answers.length) {
        const ip = String(answers[0].data)
        dohCache.set(name, { ip, at: Date.now() })
        return ip
      }
    } catch {}
  }
  dohCache.set('!' + name, { at: Date.now() })
  const err = new Error('沙箱 DNS 解析失败（hosts/DoH 均不可用）: ' + name)
  err.code = 'EAI_AGAIN'
  throw err
}

// net/tls 兼容的 lookup 回调
export function sandboxLookup(name, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  resolveHost(name)
    .then(ip => { if (dbg) dbg('lookup ' + name + ' → ' + ip); cb(null, ip, ip.includes(':') ? 6 : 4) })
    .catch(e => { if (dbg) dbg('lookup ' + name + ' 失败: ' + (e?.message || e)); cb(e) })
}

// ---- fetch 兼容实现（支持 farm.mjs 用到的子集）----
export function makeSandboxFetch({ logger } = {}) {
  if (logger) setDebugLogger(m => logger.info('[net] ' + m))
  return function sandboxFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      let u
      try { u = new URL(url) } catch (e) { return reject(e) }
      if (dbg) dbg((opts.method || 'GET') + ' ' + url)
      const isHttps = u.protocol === 'https:'
      const mod = isHttps ? https : http
      let settled = false
      const fail = e => {
        if (!settled) {
          settled = true
          if (dbg) dbg('fail ' + u.host + (e?.code ? ' [' + e.code + '] ' : '') + (e?.message || e))
          try { req.destroy() } catch {}
          reject(e)
        }
      }
      const headers = { ...(opts.headers || {}) }
      if (opts.body != null && headers['Content-Length'] == null) {
        headers['Content-Length'] = Buffer.byteLength(opts.body)
      }
      const req = mod.request({
        host: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers,
        lookup: sandboxLookup,
        // 关闭 autoSelectFamily：经典 lookup 回调签名 (err, ip, family)
        autoSelectFamily: false,
      }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          if (settled) return
          settled = true
          const raw = Buffer.concat(chunks)
          if (dbg) dbg('← ' + res.statusCode + ' ' + u.host + ' (' + raw.length + 'B)')
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: {
              get(k) {
                const v = res.headers[String(k).toLowerCase()]
                return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v)
              },
            },
            json: async () => JSON.parse(raw.toString('utf8')),
            text: async () => raw.toString('utf8'),
          })
        })
        res.on('error', fail)
      })
      req.on('error', fail)
      const signal = opts.signal
      if (signal) {
        if (signal.aborted) {
          const e = new Error('The operation was aborted due to timeout')
          e.name = 'TimeoutError'
          return fail(e)
        }
        signal.addEventListener('abort', () => fail(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), { once: true })
      }
      if (opts.body != null) req.write(opts.body)
      req.end()
    })
  }
}

// ---- 启动诊断：确认沙箱内 /etc 读取情况，写入 runtime.log ----
export function sandboxDiagnostics(logger) {
  for (const f of ['/etc/hosts', '/etc/resolv.conf', '/etc/nsswitch.conf']) {
    try {
      const t = String(readFileSync(f, 'utf8'))
      logger.info('沙箱诊断 ' + f + '：可读（' + t.length + ' 字节）')
    } catch (e) {
      logger.warn('沙箱诊断 ' + f + '：不可读（' + (e?.code || e?.message || e) + '）→ 出站解析走 hosts 缓存/DoH')
    }
  }
  logger.info('hosts 预载条目：' + hostsMap.size + '（' + [...hostsMap.keys()].slice(0, 6).join(', ') + '）')
}
