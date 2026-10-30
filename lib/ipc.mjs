// 萌卡 native-ipc-v1 客户端（自研，无历史包袱）
// 协议：stdin/stdout 逐行 JSON；stdout 只能写协议消息，日志一律走 stderr。
import { createInterface } from 'node:readline'

export function createIpc({ pluginId, version, frameworkApi = '3.0.0', actions = [], log, onEvent, onLifecycle }) {
  const declared = new Set(actions.map(a => String(a).toLowerCase()))
  const pending = new Map()
  let seq = 0
  let ready = false
  let readyResolve = null
  let readyReject = null
  let closed = false

  const out = (msg) => { if (closed) throw new Error('ipc closed'); process.stdout.write(JSON.stringify(msg) + '\n') }

  function call(action, params = {}, { timeoutMs = 60000 } = {}) {
    const name = String(action || '').toLowerCase()
    if (!declared.has(name)) return Promise.reject(new Error('action not declared in manifest: ' + name))
    if (!ready) return Promise.reject(new Error('framework ipc not ready'))
    const id = 'ng_' + Date.now().toString(36) + '_' + (++seq).toString(36)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('action ' + name + ' timeout (' + timeoutMs + 'ms)')) }, Math.max(1000, timeoutMs))
      pending.set(id, { resolve, reject, timer })
      try { out({ type: 'action', id, action: name, params }) } catch (e) { clearTimeout(timer); pending.delete(id); reject(e) }
    })
  }

  function handleLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { log.error('框架下发了非法 JSON'); return }
    if (msg.type === 'ready') {
      if (msg.api_version != null && String(msg.api_version) !== '1') { readyReject?.(new Error('ipc api_version mismatch')); return }
      ready = true
      log.info('框架就绪（framework_api=' + (msg.framework_api || frameworkApi) + '）')
      readyResolve?.()
      return
    }
    if (msg.type === 'action_result') {
      const waiter = pending.get(msg.id)
      if (!waiter) return
      clearTimeout(waiter.timer); pending.delete(msg.id)
      if (msg.ok) waiter.resolve(msg.data)
      else waiter.reject(new Error(msg.error || 'action failed'))
      return
    }
    if (msg.type === 'event') { try { onEvent?.(msg.data || {}) } catch (e) { log.error('event handler failed: ' + e.message) } return }
    if (msg.type === 'lifecycle') { try { onLifecycle?.(msg) } catch (e) { log.error('lifecycle handler failed: ' + e.message) } return }
    if (msg.type === 'config') return // 3.0 不下发插件配置，忽略
  }

  function start() {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
    rl.on('line', handleLine)
    rl.on('close', () => { closed = true; ready = false; for (const w of pending.values()) { clearTimeout(w.timer); w.reject(new Error('ipc closed')) } pending.clear(); readyReject?.(new Error('ipc closed')) })
    const started = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    out({ type: 'hello', api_version: '1', framework_api: frameworkApi, plugin_id: pluginId, version })
    return started
  }

  return { call, start, get ready() { return ready } }
}
