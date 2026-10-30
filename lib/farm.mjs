// 农场端客户端：三态认证自适应 + 账号读写 + 在线状态分类
export function newSession() {
  return { mode: '', token: '', cookie: '', blockedUntil: 0, failStreak: 0 }
}

export function createFarmClient({ fetchImpl = fetch, logger }) {
  async function detectMode(farm) {
    try {
      const res = await fetchImpl(farm.baseUrl + '/api/auth/status', { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const d = await res.json().catch(() => ({}))
        if (d && d.ok && d.data && typeof d.data.setupRequired === 'boolean') {
          if (d.data.setupRequired) throw new Error('[' + farm.baseUrl + '] 农场后台尚未设置访问 Code')
          logger.info('[' + farm.baseUrl + '] 后台为「访问 Code」模式')
          return 'access-code'
        }
      }
    } catch (e) {
      if (/访问 Code/.test(String(e?.message))) throw e
    }
    const res = await fetchImpl(farm.baseUrl + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000),
    })
    if (res.status === 404) { logger.info('[' + farm.baseUrl + '] 无登录验证 → 直接推送'); return 'none' }
    return 'password'
  }

  async function login(farm, session) {
    const now = Date.now()
    if (now < session.blockedUntil) throw new Error('[' + farm.baseUrl + '] 登录冷却中，还需 ' + Math.ceil((session.blockedUntil - now) / 1000) + ' 秒')
    if (session.mode === '') session.mode = await detectMode(farm)
    if (session.mode === 'none') return ''
    const body = session.mode === 'access-code' ? { code: farm.password } : { username: farm.username, password: farm.password }
    const res = await fetchImpl(farm.baseUrl + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || (!j.ok && !j.data?.token)) {
      if (res.status === 401 || res.status === 403) {
        session.failStreak += 1
        const backoff = Math.min(3600000, 300000 * Math.pow(2, session.failStreak - 1))
        session.blockedUntil = Date.now() + backoff
        throw new Error('[' + farm.baseUrl + '] 凭据被拒（第 ' + session.failStreak + ' 次），' + Math.round(backoff / 60000) + ' 分钟内不再重试')
      }
      if (res.status === 409) { session.mode = ''; throw new Error('[' + farm.baseUrl + '] 访问 Code 未设置（HTTP 409）') }
      throw new Error('[' + farm.baseUrl + '] 登录失败：HTTP ' + res.status + ' ' + JSON.stringify(j).slice(0, 160))
    }
    const setc = String(res.headers.get('set-cookie') || '')
    const m = setc.match(/farm_admin_session=([^;]+)/)
    session.cookie = m ? decodeURIComponent(m[1]) : ''
    session.token = session.cookie || String(j.data?.token || '')
    session.failStreak = 0; session.blockedUntil = 0
    logger.info('[' + farm.baseUrl + '] 已登录农场（' + session.mode + '）')
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
    if (!res.ok || data?.ok === false) throw new Error('[' + farm.baseUrl + '] ' + method + ' ' + path + ' → HTTP ' + res.status + ' ' + JSON.stringify(data).slice(0, 160))
    return data
  }

  async function listAccounts(farm, session) {
    const d = await api(farm, session, 'GET', '/api/accounts')
    return Array.isArray(d?.data?.accounts) ? d.data.accounts : []
  }

  return { newSession, login, api, listAccounts, detectMode }
}

/** 在农场账号列表里定位同一个 QQ：uin/qq 优先，其次本地绑定 id，最后按 name 兜底 */
export function matchAccount(list, qq, bindingId) {
  const target = String(qq)
  const byQq = list.filter(a => {
    const plat = String(a.platform || '').toLowerCase()
    const ids = [a.uin, a.qq].filter(v => v != null && String(v).trim() !== '').map(String)
    return (plat === '' || plat === 'qq') && ids.includes(target)
  })
  if (byQq.length) {
    byQq.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    return { account: byQq[0], duplicates: byQq.slice(1), via: 'uin' }
  }
  if (bindingId != null) {
    const byId = list.find(a => String(a.id) === String(bindingId))
    if (byId) return { account: byId, duplicates: [], via: 'binding' }
  }
  const byName = list.find(a => String(a.name || '') === target)
  if (byName) return { account: byName, duplicates: [], via: 'name' }
  return { account: null, duplicates: [], via: null }
}

/** 在线状态分类：online / transient / expiring / offline / unknown */
export function classifyAccount(acc, { now = Date.now(), refreshBeforeExpireMin = 5 } = {}) {
  if (!acc) return { state: 'missing', detail: '农场无此号' }
  const rs = String(acc.runtimeState || '').toLowerCase()
  const running = acc.running === true
  const exp = Number(acc.expires_at || 0)
  const expLeftMin = exp > 0 ? (exp - now) / 60000 : null
  const transient = ['logging_in', 'starting', 'connecting', 'stopping'].includes(rs)
  if (transient) return { state: 'transient', detail: '农场侧' + rs + '，本轮跳过' }
  if (acc.reloginAt) return { state: 'offline', detail: '等待重登' }
  if (!running || (rs && rs !== 'running' && rs !== 'idle')) return { state: 'offline', detail: '未运行（' + (rs || 'stopped') + '）' }
  if (expLeftMin != null && expLeftMin <= 0) return { state: 'expiring', detail: 'code 已过期' }
  if (expLeftMin != null && refreshBeforeExpireMin > 0 && expLeftMin <= refreshBeforeExpireMin) {
    return { state: 'expiring', detail: 'code 剩余 ' + Math.max(0, Math.round(expLeftMin)) + ' 分钟' }
  }
  return { state: 'online', detail: '在线' + (expLeftMin != null ? '（剩余 ' + Math.round(expLeftMin) + ' 分钟）' : '') }
}
