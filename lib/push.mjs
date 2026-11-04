// 推送编排：状态感知 —— 已在线跳过，离线才取码更新；同一 QQ 永远复用同一农场记录
// 等级门槛不做本地预判：是否给 code 由框架按当前授权（Free≥48/Plus≥16/Pro 不限）决定，
// 插件只透传框架的成功/拒绝结果。
import { createFarmClient, newSession, matchAccount, classifyAccount } from './farm.mjs'
import { normalizeQqFlags, DEFAULT_QQ_FLAGS } from './store.mjs'

const FLAGS_FILE = 'qq-flags.json'
const QQ_FARMS_FILE = 'qq-farms.json'

function normalizeQqFarms(v) {
  const src = (v && typeof v === 'object' && v.map && typeof v.map === 'object') ? v.map : {}
  const map = {}
  for (const [k, u] of Object.entries(src)) {
    if (/^\d{5,12}$/.test(k) && typeof u === 'string' && u) map[k] = u
  }
  return { map }
}

function normalizeBot(b) {
  const proto = b?.protocol && typeof b.protocol === 'object' ? b.protocol : {}
  const platform = String(proto.platform || b?.platform || '')
  const type = String(proto.type || '')
  const linux = platform.toLowerCase() === 'pc' || type.toLowerCase() === 'linux'
  // 平台名统一成 Android / PC，便于前端比较与展示（框架可能返回 android/pc 小写）
  const platLabel = linux ? 'PC' : (/android/i.test(platform) || /android/i.test(type) ? 'Android' : (platform || 'Android'))
  return {
    selfId: String(b?.self_id ?? b?.selfId ?? ''),
    nickname: String(b?.nickname || ''),
    protocolId: Number(proto.id ?? b?.protocolId ?? b?.protocol_id ?? 0),
    platform: platLabel,
    clientType: linux ? 'linuxqq' : 'android',
    linux,
    level: Number(b?.level || 0),
    online: typeof b?.online === 'boolean' ? b.online : Number(b?.status) === 1,
  }
}

// 同一个 QQ 可能同时登录 PC 版和安卓版（萌卡里是两条 bot，protocol_id 不同）。
// 农场 code 由手机端协议提供，PC/LinuxQQ 协议通常取不到，因此取码顺序：在线优先 → 安卓优先。
function candidateRank(t) { return (t.online ? 0 : 2) + (t.linux ? 1 : 0) }

function groupTargets(list) {
  const map = new Map()
  for (const t of list) {
    if (!t || !t.selfId) continue
    let g = map.get(t.selfId)
    if (!g) { g = { selfId: t.selfId, candidates: [] }; map.set(t.selfId, g) }
    g.candidates.push(t)
  }
  const out = []
  for (const g of map.values()) {
    g.candidates.sort((a, b) => candidateRank(a) - candidateRank(b))
    const seen = new Set()
    g.candidates = g.candidates.filter(c => {
      const k = String(c.protocolId) + '|' + c.platform
      if (seen.has(k)) return false
      seen.add(k); return true
    })
    out.push(g)
  }
  return out
}

export function createPusher({ ipc, store, logger, getOptions, getServers, log, fetchImpl }) {
  const client = createFarmClient({ logger, fetchImpl })
  const sessions = new Map()
  let inflight = null
  let lastResult = null
  const accountsCache = new Map() // baseUrl -> { at, list }

  const sessionFor = (farm) => {
    let s = sessions.get(farm.baseUrl)
    if (!s) { s = newSession(); sessions.set(farm.baseUrl, s) }
    return s
  }

  async function fetchFarmAccounts(farm, { force = false } = {}) {
    const now = Date.now()
    const hit = accountsCache.get(farm.baseUrl)
    if (!force && hit && now - hit.at < 30000) return hit.list
    const list = await client.listAccounts(farm, sessionFor(farm))
    accountsCache.set(farm.baseUrl, { at: now, list })
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

  // ---- 每 QQ 推送目标农场（空 = 跟随「服务器管理」里选中的那台）----
  function qqFarms() { return normalizeQqFarms(store.read(QQ_FARMS_FILE, { map: {} })) }
  function qqFarmUrl(selfId) {
    const map = qqFarms().map
    return map[String(selfId)] || ''
  }
  function setQqFarm(selfId, baseUrl) {
    const id = String(selfId ?? '').trim()
    if (!/^\d{5,12}$/.test(id)) return qqFarms()
    const url = String(baseUrl || '').trim()
    const farms = getServers().farms
    const cur = qqFarms(); const map = { ...cur.map }
    const prev = map[id] || ''
    if (!url || !farms.some(f => f.baseUrl === url)) delete map[id]
    else map[id] = url
    store.write(QQ_FARMS_FILE, { map })
    const next = map[id] || ''
    if (prev !== next) {
      // 换了农场：旧 farmId/codeHash 属于上一台农场，清掉避免写错账号
      const b = bindings()
      if (b[id]) { delete b[id]; saveBindings(b) }
    }
    logger.info('QQ ' + id + ' 推送农场 → ' + (next || '默认（跟随当前推送目标）'))
    return qqFarms()
  }

  // 某 QQ 实际要推的农场：自选 → 选中的服务器 → 当前推送目标
  function farmFor(selfId, state = getServers()) {
    const url = qqFarmUrl(selfId)
    const hit = url ? state.farms.find(f => f.baseUrl === url) : null
    if (hit) return { farm: hit, pinned: true }
    return { farm: state.farms[state.activeFarm], pinned: false }
  }

  async function runOnce(reason, { selfId = null, force = false } = {}) {
    const started = Date.now()
    const opts = getOptions()
    const state = getServers()
    const active = state.farms[state.activeFarm]
    const fail = (error, extra = {}) => {
      const res = { reason, at: Date.now(), ok: false, error, items: [], ...extra }
      lastResult = res; logger.warn(error); return res
    }
    if (!state.farms.length) return fail('没有可用的农场服务器：请在「服务器管理」里新增一台')

    let rawBots
    try { rawBots = await ipc.call('get_bot_list', {}, { timeoutMs: 20000 }) }
    catch (e) { return fail('读取在线 QQ 失败：' + e.message) }
    let list = (Array.isArray(rawBots) ? rawBots : rawBots?.items || []).filter(b => b && b.self_id != null).map(normalizeBot)
    if (selfId) list = list.filter(t => t.selfId === String(selfId))
    // 手动单号推送不套用「QQ 白名单 / 平台开关 / 必须在线」过滤：点了一定给结果（成功/失败/跳过）
    if (!selfId) {
      const filter = String(opts.qqFilter || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
      if (filter.length) list = list.filter(t => filter.includes(t.selfId))
      list = list.filter(t => (t.linux ? opts.pushLinux : opts.pushAndroid) && t.online)
    }

    // 同一 QQ 的多协议（PC + 安卓）合成一个目标，按 priority 顺序备用取码
    let targets = groupTargets(list)

    // 「自动推送」开关只作用于定时/事件等批量推送；手动单号推送始终放行，由用户自己决定
    const off = disabledSet()
    if (!selfId && off.size) targets = targets.filter(g => !off.has(g.selfId))

    if (!targets.length) {
      const res = { reason, at: Date.now(), ok: true, empty: true, farmUrl: active?.baseUrl || '', message: selfId ? ('该 QQ（' + selfId + '）当前不在萌卡在线列表') : ((off.size) ? '没有可自动推送的在线 QQ（' + off.size + ' 个号已关闭自动推送）' : '没有匹配的在线 QQ'), items: [] }
      lastResult = res; logger.info('[' + reason + '] ' + res.message); return res
    }

    // 按每个 QQ 选定的农场分组：各自推到自己那台
    targets = targets.map(g => ({ ...g, farm: farmFor(g.selfId, state).farm })).filter(g => g.farm)
    const farmsUsed = [...new Map(targets.map(g => [g.farm.baseUrl, g.farm])).values()]

    const bind = bindings()
    const items = []
    logger.info('开始推送（' + reason + '）：' + targets.length + ' 个候选 → ' + farmsUsed.map(f => f.label || f.baseUrl).join('、'))

    for (const farm of farmsUsed) {
      const groups = targets.filter(g => g.farm.baseUrl === farm.baseUrl)
      let accounts
      try { accounts = await fetchFarmAccounts(farm, { force: true }) }
      catch (e) {
        for (const g of groups) {
          items.push({
            selfId: g.selfId, nickname: g.candidates[0]?.nickname || '', level: g.candidates[0]?.level || 0,
            platform: g.candidates[0]?.platform || '', platforms: g.candidates.map(c => c.platform).join(' + '),
            farmUrl: farm.baseUrl, farmLabel: farm.label || '', farmState: 'unknown', action: 'fail', detail: '读取农场账号失败', error: e.message, ms: 0,
          })
        }
        logger.warn('[FARM] ' + (farm.label || farm.baseUrl) + ' 读取账号失败：' + e.message)
        continue
      }

      for (const g of groups) {
        const t0 = Date.now()
        const head = g.candidates[0]
        const plats = g.candidates.map(c => c.platform).join(' + ')
        // 一个 QQ 只产出一条结果；platform 记实际取码用的协议
        const mk = (action, farmState, detail, extra = {}) => ({
          selfId: g.selfId, nickname: head.nickname, level: head.level, platform: head.platform, platforms: plats,
          farmUrl: farm.baseUrl, farmLabel: farm.label || '', farmState, action, detail, ms: Date.now() - t0, ...extra,
        })
        const prev = bind[g.selfId] || {}
        const found = matchAccount(accounts, g.selfId, prev.farmUrl === farm.baseUrl ? prev.farmId : undefined)
        const cls = classifyAccount(found.account, { now: Date.now(), refreshBeforeExpireMin: opts.refreshBeforeExpireMin })

        if (!force && opts.skipWhenOnline && (cls.state === 'online' || cls.state === 'transient')) {
          items.push(mk('skip', cls.state, cls.detail + '，跳过'))
          logger.info('[SKIP] ' + g.selfId + ' ' + cls.detail)
          continue
        }

        // 取码：按 安卓 → PC 的顺序逐个协议尝试，一个取不到就换下一个
        let code = null, used = null, errs = []
        for (const c of g.candidates) {
          try {
            const r = await ipc.call('get_qq_classic_farm_code', { self_id: Number(g.selfId), protocol_id: Number(c.protocolId) }, { timeoutMs: 60000 })
            if (r && r.skipped) throw new Error(r.reason || '该平台不支持取码')
            const v = r && (r.code ?? r.Code)
            if (!v) throw new Error('框架未返回 code')
            code = v; used = c; break
          } catch (e) {
            errs.push(c.platform + '：' + e.message)
            logger.warn('[CODE] ' + g.selfId + ' ' + c.platform + '（protocol ' + c.protocolId + '）取码失败：' + e.message)
          }
        }
        if (!code) {
          items.push(mk('fail', cls.state, '取码失败', { error: errs.join('；') }))
          logger.error('[CODE] ' + g.selfId + ' 所有协议均取码失败：' + errs.join('；'))
          continue
        }
        if (used && used !== head) logger.info('[CODE] ' + g.selfId + ' 改用 ' + used.platform + ' 协议取码成功')
        const usedInfo = used && used !== head ? { platform: used.platform, nickname: used.nickname || head.nickname, level: used.level || head.level } : {}

        const codeHash = Buffer.from(String(code)).toString('base64').slice(0, 16)
        if (!force && prev.farmUrl === farm.baseUrl && prev.codeHash === codeHash && cls.state !== 'expiring') {
          items.push(mk('skip', cls.state, 'code 未变化，跳过', usedInfo))
          continue
        }

        const payload = {
          ...(found.account ? { id: found.account.id } : {}),
          name: found.account?.name || head.nickname || g.selfId,
          code: String(code),
          platform: 'qq',
          uin: g.selfId,
          qq: g.selfId,
        }
        try {
          const saved = await client.api(farm, sessionFor(farm), 'POST', '/api/accounts', payload)
          const newId = saved?.data?.account?.id ?? saved?.data?.id ?? found.account?.id ?? null
          if (opts.startAfterUpdate && newId != null) {
            try { await client.api(farm, sessionFor(farm), 'POST', '/api/accounts/' + newId + '/start') }
            catch (e) { logger.warn('[START] ' + g.selfId + ' 启动失败：' + e.message) }
          }
          bind[g.selfId] = { farmId: newId, farmUrl: farm.baseUrl, codeHash, at: Date.now() }
          saveBindings(bind)
          accountsCache.delete(farm.baseUrl)
          items.push(mk(found.account ? 'update' : 'create', cls.state, (found.account ? '已更新（id ' + newId + '）' : '已新建（id ' + newId + '）') + ' · ' + cls.detail, usedInfo))
          logger.info('[PUSH] ' + g.selfId + (found.account ? ' 更新' : ' 新建') + ' id=' + newId + ' @ ' + (farm.label || farm.baseUrl))
        } catch (e) {
          items.push(mk('fail', cls.state, '写入农场失败', { error: e.message, ...usedInfo }))
          logger.error('[PUSH] ' + g.selfId + ' ' + e.message)
        }
      }
    }

    const okCount = items.filter(i => i.action === 'update' || i.action === 'create').length
    const res = {
      reason, at: Date.now(), ok: okCount > 0, items, total: items.length, changed: okCount,
      skipped: items.filter(i => i.action === 'skip').length, failed: items.filter(i => i.action === 'fail').length,
      ms: Date.now() - started,
      farmUrl: farmsUsed.map(f => f.baseUrl).join('，'),
      farmLabels: farmsUsed.map(f => f.label || f.baseUrl),
    }
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
      const state = getServers()
      const active = state.farms[state.activeFarm]
      if (!active) return []
      try {
        const map = qqFarms().map
        const bots = (await ipc.call('get_bot_list', {}, { timeoutMs: 15000 })) || []
        const arr = Array.isArray(bots) ? bots : []
        const targetOf = (id) => {
          const hit = map[id] ? state.farms.find(f => f.baseUrl === map[id]) : null
          return hit || active
        }
        // 只拉「有号要用」的农场账号（自选农场可能不是当前推送目标）
        const need = new Map()
        for (const b of arr) { const f = targetOf(String(b?.self_id ?? b?.selfId ?? '')); if (f) need.set(f.baseUrl, f) }
        const accByUrl = new Map()
        await Promise.all([...need.values()].map(async f => {
          try { accByUrl.set(f.baseUrl, await fetchFarmAccounts(f)) }
          catch (e) { logger.warn('状态快照：读取农场失败（' + (f.label || f.baseUrl) + '）：' + e.message); accByUrl.set(f.baseUrl, []) }
        }))
        const bind = bindings()
        const off = disabledSet()
        const opt = getOptions()
        // 固定顺序：按 QQ 号升序（长度优先再字典序 = 数值升序），不受萌卡返回顺序影响，刷新时行不会跳动
        return arr.map(b => {
          const t = normalizeBot(b)
          const f = targetOf(t.selfId)
          const accs = (f && accByUrl.get(f.baseUrl)) || []
          const prev = bind[t.selfId] || {}
          const found = matchAccount(accs, t.selfId, prev.farmUrl === f?.baseUrl ? prev.farmId : undefined)
          const cls = classifyAccount(found.account, { refreshBeforeExpireMin: opt.refreshBeforeExpireMin })
          return {
            ...t,
            farmUrl: f?.baseUrl || '', farmLabel: f?.label || '', farmIndex: f ? state.farms.indexOf(f) : -1,
            farmPinned: !!(f && map[t.selfId] === f.baseUrl),
            farmId: found.account?.id ?? null, farmState: cls.state, farmDetail: cls.detail,
            expiresAt: Number(found.account?.expires_at || 0) || null,
            pushEnabled: !off.has(t.selfId),
          }
        }).sort((a, b) => (a.selfId.length - b.selfId.length) || (a.selfId < b.selfId ? -1 : a.selfId > b.selfId ? 1 : 0))
      } catch (e) { logger.warn('状态快照失败：' + e.message); return [] }
    },
    get lastResult() { return lastResult },
    get busy() { return !!inflight },
    invalidate(url) { if (url) accountsCache.delete(url); else accountsCache.clear() },
    resetSessions() { sessions.clear() },
    qqFlags,
    setQqEnabled,
    qqFarms,
    setQqFarm,
  }
}
