// 推送编排：状态感知 —— 已在线跳过，离线才取码更新；同一 QQ 永远复用同一农场记录
// 等级门槛不做本地预判：是否给 code 由框架按当前授权（Free≥48/Plus≥16/Pro 不限）决定，
// 插件只透传框架的成功/拒绝结果。
import { createFarmClient, newSession, matchAccount, classifyAccount } from './farm.mjs'
import { normalizeQqFlags, DEFAULT_QQ_FLAGS } from './store.mjs'

const FLAGS_FILE = 'qq-flags.json'

function normalizeBot(b) {
  const proto = b?.protocol && typeof b.protocol === 'object' ? b.protocol : {}
  const platform = String(proto.platform || b?.platform || '')
  const type = String(proto.type || '')
  const linux = platform.toLowerCase() === 'pc' || type.toLowerCase() === 'linux'
  return {
    selfId: String(b?.self_id ?? b?.selfId ?? ''),
    nickname: String(b?.nickname || ''),
    protocolId: Number(proto.id ?? b?.protocolId ?? b?.protocol_id ?? 0),
    platform: platform || (linux ? 'PC' : 'Android'),
    clientType: linux ? 'linuxqq' : 'android',
    linux,
    level: Number(b?.level || 0),
    online: typeof b?.online === 'boolean' ? b.online : Number(b?.status) === 1,
  }
}

export function createPusher({ ipc, store, logger, getOptions, getServers, log, fetchImpl }) {
  const client = createFarmClient({ logger, fetchImpl })
  const sessions = new Map()
  let inflight = null
  let lastResult = null
  let accountsCache = { at: 0, farmUrl: '', list: [] }

  const sessionFor = (farm) => {
    let s = sessions.get(farm.baseUrl)
    if (!s) { s = newSession(); sessions.set(farm.baseUrl, s) }
    return s
  }

  async function fetchFarmAccounts(farm, { force = false } = {}) {
    const now = Date.now()
    if (!force && accountsCache.farmUrl === farm.baseUrl && now - accountsCache.at < 30000) return accountsCache.list
    const list = await client.listAccounts(farm, sessionFor(farm))
    accountsCache = { at: now, farmUrl: farm.baseUrl, list }
    return list
  }

  function bindings() { return store.read('bindings.json', {}) }
  function saveBindings(b) { store.write('bindings.json', b) }

  // ---- 每 QQ 推送开关（不启用的号不参与任何推送：定时/事件/手动/单号）----
  function qqFlags() { return normalizeQqFlags(store.read(FLAGS_FILE, DEFAULT_QQ_FLAGS)) }
  function disabledSet() { return new Set(qqFlags().disabled) }

  function setQqEnabled(selfId, enabled) {
    const id = String(selfId ?? '').trim()
    if (!/^\d{5,12}$/.test(id)) return qqFlags()
    const cur = qqFlags()
    const set = new Set(cur.disabled)
    if (enabled) set.delete(id)
    else set.add(id)
    store.write(FLAGS_FILE, { disabled: [...set] })
    logger.info('推送开关：' + id + ' → ' + (enabled ? '启用' : '停用'))
    return qqFlags()
  }

  async function runOnce(reason, { selfId = null, force = false } = {}) {
    const started = Date.now()
    const opts = getOptions()
    const state = getServers()
    const farm = state.farms[state.activeFarm]
    const fail = (error, extra = {}) => {
      const res = { reason, at: Date.now(), ok: false, error, items: [], ...extra }
      lastResult = res; logger.warn(error); return res
    }
    if (!farm) return fail('没有可用的农场服务器：请在「服务器管理」里新增一台')

    let bots
    try { bots = await ipc.call('get_bot_list', {}, { timeoutMs: 20000 }) }
    catch (e) { return fail('读取在线 QQ 失败：' + e.message) }
    let targets = (Array.isArray(bots) ? bots : bots?.items || []).filter(b => b && b.self_id != null).map(normalizeBot)
    if (selfId) targets = targets.filter(t => t.selfId === String(selfId))
    const filter = String(opts.qqFilter || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
    if (filter.length) targets = targets.filter(t => filter.includes(t.selfId))
    // 手动单号推送不套用「平台开关 + 必须在线」的批量过滤：点了一定给结果（成功/失败/跳过）
    if (!selfId) targets = targets.filter(t => (t.linux ? opts.pushLinux : opts.pushAndroid) && t.online)

    // 「自动推送」开关只作用于定时/事件等批量推送；手动单号推送始终放行，由用户自己决定
    const off = disabledSet()
    if (!selfId && off.size) targets = targets.filter(t => !off.has(t.selfId))

    if (!targets.length) {
      const res = { reason, at: Date.now(), ok: true, empty: true, farmUrl: farm.baseUrl, message: selfId ? ('该 QQ（' + selfId + '）当前不在萌卡在线列表') : ((off.size) ? '没有可自动推送的在线 QQ（' + off.size + ' 个号已关闭自动推送）' : '没有匹配的在线 QQ'), items: [] }
      lastResult = res; logger.info('[' + reason + '] ' + res.message); return res
    }

    let accounts
    try { accounts = await fetchFarmAccounts(farm, { force: true }) }
    catch (e) { return fail('读取农场账号列表失败：' + e.message, { farmUrl: farm.baseUrl }) }

    const bind = bindings()
    const items = []
    logger.info('开始推送（' + reason + '）：' + targets.length + ' 个候选 → ' + farm.baseUrl)

    for (const t of targets) {
      const t0 = Date.now()
      const mk = (action, farmState, detail, extra = {}) => ({ selfId: t.selfId, nickname: t.nickname, level: t.level, platform: t.platform, farmState, action, detail, ms: Date.now() - t0, ...extra })
      const found = matchAccount(accounts, t.selfId, bind[t.selfId]?.farmId)
      const cls = classifyAccount(found.account, { now: Date.now(), refreshBeforeExpireMin: opts.refreshBeforeExpireMin })

      if (!force && opts.skipWhenOnline && (cls.state === 'online' || cls.state === 'transient')) {
        items.push(mk('skip', cls.state, cls.detail + '，跳过'))
        logger.info('[SKIP] ' + t.selfId + ' ' + cls.detail)
        continue
      }

      let code
      try {
        const r = await ipc.call('get_qq_classic_farm_code', { self_id: Number(t.selfId), protocol_id: Number(t.protocolId) }, { timeoutMs: 60000 })
        if (r && r.skipped) throw new Error('框架跳过取码：' + (r.reason || '该平台不支持'))
        code = r && (r.code ?? r.Code)
        if (!code) throw new Error('框架未返回 code')
      } catch (e) {
        items.push(mk('fail', cls.state, '取码失败', { error: e.message }))
        logger.error('[CODE] ' + t.selfId + ' ' + e.message)
        continue
      }

      const codeHash = Buffer.from(String(code)).toString('base64').slice(0, 16)
      const prev = bind[t.selfId] || {}
      if (!force && prev.codeHash === codeHash && cls.state !== 'expiring') {
        items.push(mk('skip', cls.state, 'code 未变化，跳过'))
        continue
      }

      const payload = {
        ...(found.account ? { id: found.account.id } : {}),
        name: found.account?.name || t.nickname || t.selfId,
        code: String(code),
        platform: 'qq',
        uin: t.selfId,
        qq: t.selfId,
      }
      try {
        const saved = await client.api(farm, sessionFor(farm), 'POST', '/api/accounts', payload)
        const newId = saved?.data?.account?.id ?? saved?.data?.id ?? found.account?.id ?? null
        if (opts.startAfterUpdate && newId != null) {
          try { await client.api(farm, sessionFor(farm), 'POST', '/api/accounts/' + newId + '/start') }
          catch (e) { logger.warn('[START] ' + t.selfId + ' 启动失败：' + e.message) }
        }
        bind[t.selfId] = { farmId: newId, codeHash, at: Date.now() }
        saveBindings(bind)
        accountsCache.at = 0
        items.push(mk(found.account ? 'update' : 'create', cls.state, (found.account ? '已更新（id ' + newId + '）' : '已新建（id ' + newId + '）') + ' · ' + cls.detail))
        logger.info('[PUSH] ' + t.selfId + (found.account ? ' 更新' : ' 新建') + ' id=' + newId)
      } catch (e) {
        items.push(mk('fail', cls.state, '写入农场失败', { error: e.message }))
        logger.error('[PUSH] ' + t.selfId + ' ' + e.message)
      }
    }

    const okCount = items.filter(i => i.action === 'update' || i.action === 'create').length
    const res = { reason, at: Date.now(), farmUrl: farm.baseUrl, ok: okCount > 0, items, total: items.length, changed: okCount, skipped: items.filter(i => i.action === 'skip').length, failed: items.filter(i => i.action === 'fail').length, ms: Date.now() - started }
    lastResult = res
    logger.info('[SYNC] ' + reason + '：更新 ' + okCount + ' / 跳过 ' + res.skipped + ' / 失败 ' + res.failed + '，用时 ' + res.ms + 'ms')
    return res
  }

  return {
    push(reason = '手动', opts) {
      if (inflight) return inflight
      inflight = runOnce(reason, opts).catch(e => {
        const res = { reason, at: Date.now(), ok: false, error: String(e?.message || e), items: [] }
        lastResult = res; logger.error('推送异常：' + res.error); return res
      }).finally(() => { inflight = null })
      return inflight
    },
    async snapshot() {
      const farm = getServers().farms[getServers().activeFarm]
      if (!farm) return []
      try {
        const list = await fetchFarmAccounts(farm)
        const bind = bindings()
        const off = disabledSet()
        const bots = (await ipc.call('get_bot_list', {}, { timeoutMs: 15000 })) || []
        // 固定顺序：按 QQ 号升序（长度优先再字典序 = 数值升序），不受萌卡返回顺序影响，刷新时行不会跳动
        return (Array.isArray(bots) ? bots : []).map(b => {
          const t = normalizeBot(b)
          const found = matchAccount(list, t.selfId, bind[t.selfId]?.farmId)
          const cls = classifyAccount(found.account, { refreshBeforeExpireMin: getOptions().refreshBeforeExpireMin })
          return { ...t, farmId: found.account?.id ?? null, farmState: cls.state, farmDetail: cls.detail, expiresAt: Number(found.account?.expires_at || 0) || null, pushEnabled: !off.has(t.selfId) }
        }).sort((a, b) => (a.selfId.length - b.selfId.length) || (a.selfId < b.selfId ? -1 : a.selfId > b.selfId ? 1 : 0))
      } catch (e) { logger.warn('状态快照失败：' + e.message); return [] }
    },
    get lastResult() { return lastResult },
    get busy() { return !!inflight },
    invalidate() { accountsCache.at = 0 },
    resetSessions() { sessions.clear() },
    qqFlags,
    setQqEnabled,
  }
}
