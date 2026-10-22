// QQ农场助手桥接 · 官方 UI 配色（跟随萌卡明暗主题）
const CSS = `
:root{--bg:#f6f7f9;--card:#ffffff;--fg:#1b1f24;--muted:#66707a;--line:#e3e7ec;--brand:#0d9488;--brand-fg:#fff;
--ok:#15803d;--ok-bg:#e8f7ee;--err:#b42318;--err-bg:#fdecea;--warn:#92400e;--warn-bg:#fef3c7}
@media (prefers-color-scheme: dark){:root{--bg:#0f1418;--card:#161d23;--fg:#e6edf3;--muted:#93a1ae;--line:#243039;
--ok:#4ade80;--ok-bg:#132e1f;--err:#f87171;--err-bg:#33191a;--warn:#fbbf24;--warn-bg:#33280d}}
html.dark{--bg:#0f1418;--card:#161d23;--fg:#e6edf3;--muted:#93a1ae;--line:#243039;--ok:#4ade80;--ok-bg:#132e1f;
--err:#f87171;--err-bg:#33191a;--warn:#fbbf24;--warn-bg:#33280d}}
*{box-sizing:border-box}
body{margin:0;padding:22px;background:var(--bg);color:var(--fg);
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:980px;margin:0 auto;display:grid;gap:16px}
.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.head h1{font-size:20px;margin:0;font-weight:700}
.head .ver{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.spacer{flex:1}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.card h2{font-size:14px;margin:0 0 12px;font-weight:600;color:var(--muted);letter-spacing:.02em}
button{font:inherit;cursor:pointer;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);
padding:9px 16px;font-weight:600;transition:.15s}
button:hover{border-color:var(--brand);color:var(--brand)}
button.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-fg)}
button.primary:hover{filter:brightness(1.08);color:var(--brand-fg)}
button:disabled{opacity:.55;cursor:not-allowed}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tip{color:var(--muted);font-size:12.5px}
.state{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;padding:3px 10px;border-radius:999px;
background:var(--ok-bg);color:var(--ok);font-weight:600}
.state.bad{background:var(--err-bg);color:var(--err)}
.state.warn{background:var(--warn-bg);color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12px}
td.err{color:var(--err);white-space:normal}
.pill{font-size:12px;padding:2px 8px;border-radius:999px;font-weight:600;background:var(--line);color:var(--muted)}
.pill.ok{background:var(--ok-bg);color:var(--ok)}
.pill.bad{background:var(--err-bg);color:var(--err)}
.mono{font-family:ui-monospace,Consolas,monospace}
.empty{color:var(--muted);font-size:13px;padding:10px 0}
.form{display:grid;grid-template-columns:150px 1fr;gap:10px 14px;align-items:center}
.form label{color:var(--muted);font-size:13px}
.form input[type=text],.form input[type=password]{width:100%;padding:9px 11px;border-radius:9px;
border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
select{padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;min-width:300px}
.msg{margin-top:10px;font-size:13px}
.msg.bad{color:var(--err)}
.msg.ok{color:var(--ok)}
@media(max-width:640px){.form{grid-template-columns:1fr}select{min-width:0;width:100%}}
`

export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>QQ农场助手桥接</title><style>${CSS}</style></head>
<body><div class="wrap">
  <div class="head">
    <h1>QQ农场助手桥接</h1><span class="ver" id="ver"></span>
    <span class="state warn" id="conn">连接中…</span>
    <div class="spacer"></div>
    <button class="primary" id="push">⚡ 立即推送 code 到选中服务器</button>
  </div>

  <div class="card" id="farmCard">
    <h2>服务器管理（推送目标 = 下拉选中的那台，每台单独配置）</h2>
    <div class="row" style="margin-bottom:14px">
      <label for="sel" class="tip" style="font-weight:600;color:var(--fg)">推送目标</label>
      <select id="sel"></select>
      <button id="add">＋ 新增服务器</button>
      <button id="del">删除该服务器</button>
      <span class="pill" id="targetInfo">-</span>
    </div>
    <div class="form">
      <label for="f-url">服务器地址</label>
      <input id="f-url" type="text" placeholder="如 http://192.168.1.99:3007"/>
      <label for="f-user">管理员账号</label>
      <input id="f-user" type="text" placeholder="无账号验证可留空"/>
      <label for="f-pass">密码 / 访问 Code</label>
      <input id="f-pass" type="password" autocomplete="new-password" placeholder="留空 = 不修改"/>
      <div></div>
      <div class="row"><button class="primary" id="save">保存设置</button><span class="msg" id="saveMsg"></span></div>
    </div>
    <div class="tip" style="margin-top:10px">切换下拉项即刻生效（推送就发到选中的服务器）；新增/删除后要点「保存设置」。</div>
  </div>

  <div class="card">
    <h2>最近一次推送</h2>
    <div class="row" id="summary"><span class="empty">还没有推送记录</span></div>
    <div id="items"></div>
  </div>

  <div class="card" id="botsCard">
    <h2>在线 QQ（萌卡当前账号）</h2>
    <div id="bots"><span class="empty">读取中…</span></div>
  </div>

  <div class="card">
    <h2>说明</h2>
    <div class="tip">插件每 <b id="iv">5</b> 分钟自动为在线 QQ 取新 code 并推送到<b>选中的服务器</b>（同名账号自动续登）。
    本页的服务器列表（新增/删除/选择推送目标）是<b>唯一权威</b>，重启不会丢失。
    萌卡插件卡片「配置」里改主服务器地址/账号/密码时，会自动合并进本页列表：地址已存在 → 更新该台的账号/密码；新地址 → 新增一台并设为推送目标。
    访问 Code 版农场：把访问 Code 填到「密码」一栏即可。</div>
  </div>
</div>
<script>
var FARMS = [], ACTIVE = 0, data = null, busy = false
function $(id) { return document.getElementById(id) }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
function api(path, opts) {
  return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {}))
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j }) })
}
function setConn(text, cls) { var el = $('conn'); el.textContent = text; el.className = 'state ' + (cls || '') }

function renderSel() {
  var sel = $('sel'); sel.innerHTML = ''
  if (!FARMS.length) { sel.innerHTML = '<option>（还没有服务器，请点新增）</option>'; return }
  FARMS.forEach(function (f, i) {
    var o = document.createElement('option'); o.value = i
    o.textContent = (i === ACTIVE ? '★ ' : '　') + f.baseUrl + (f.passwordSet ? '' : '（未配密码/访问Code）')
    sel.appendChild(o)
  })
  sel.value = ACTIVE
}
function fillFarm(i) {
  var f = FARMS[i] || { baseUrl: '', username: '' }
  $('f-url').value = f.baseUrl || ''; $('f-user').value = f.username || ''; $('f-pass').value = ''
}

function paint(d) {
  data = d
  $('ver').textContent = 'v' + (d.version || '') + (d.platform ? ' · ' + d.platform : '')
  if (!d.connected) setConn(d.active ? '框架未连接' : '待激活', 'warn')
  else setConn(d.active ? '运行中' : '已连接', d.active ? '' : 'warn')
  var p = d.problems || []
  if (p.length) setConn(p.join(' / '), 'bad')

  FARMS = d.farms || []; ACTIVE = d.activeFarm || 0
  if (ACTIVE >= FARMS.length) ACTIVE = 0
  renderSel(); if (document.activeElement !== $('f-url')) fillFarm(ACTIVE)
  $('targetInfo').textContent = FARMS.length ? ('共 ' + FARMS.length + ' 台 · 推送目标 ' + FARMS[ACTIVE].baseUrl) : '未配置服务器'
  $('iv').textContent = (d.config || {}).interval_minutes || 5
  $('push').disabled = busy || !d.connected || d.active === false || !FARMS.length
  $('push').textContent = busy || d.busy ? '推送中…' : '⚡ 立即推送 code 到选中服务器'

  var bots = d.bots || []
  if (!bots.length) $('bots').innerHTML = '<span class="empty">框架里还没有可读取的账号</span>'
  else {
    var brows = bots.map(function (b) {
      var plat = b.client_type === 'linuxqq' ? 'Linux' : 'Android'
      var st = b.online ? '<span class="pill ok">在线</span>' : '<span class="pill">离线</span>'
      return '<tr><td class="mono">' + esc(b.self_id) + '</td><td>' + esc(b.nickname || '-') + '</td><td>' + plat + '</td><td>' + st + '</td></tr>'
    }).join('')
    $('bots').innerHTML = '<table><thead><tr><th>QQ</th><th>昵称</th><th>平台</th><th>状态</th></tr></thead><tbody>' + brows + '</tbody></table>'
  }

  var r = d.last
  if (!r) { $('summary').innerHTML = '<span class="empty">还没有推送记录</span>'; $('items').innerHTML = ''; return }
  var when = new Date(r.at).toLocaleString('zh-CN', { hour12: false })
  var head = r.empty ? '<span class="state warn">' + esc(r.message) + '</span>'
    : r.error ? '<span class="state bad">' + esc(r.error) + '</span>'
    : '<span class="state">' + (r.success || 0) + '/' + (r.total || 0) + ' 成功</span>'
  $('summary').innerHTML = head + '<span class="tip">目标：' + esc(r.farmUrl || '-') + ' · 触发：' + esc(r.reason || '') + ' · ' + when +
    (r.ms ? ' · 用时 ' + r.ms + ' ms' : '') + '</span>'
  if (!r.items || !r.items.length) { $('items').innerHTML = ''; return }
  var rows = r.items.map(function (i) {
    return '<tr><td class="mono">' + esc(i.selfId) + '</td><td>' + esc(i.nickname || '-') + '</td><td>' +
      (i.clientType === 'linuxqq' ? 'Linux' : 'Android') + '</td><td><span class="pill ' + (i.ok ? 'ok' : 'bad') + '">' +
      (i.ok ? '成功' : '失败') + '</span></td><td>' + (i.ms || 0) + ' ms</td><td class="err">' + esc(i.error || '') + '</td></tr>'
  }).join('')
  $('items').innerHTML = '<table><thead><tr><th>QQ</th><th>昵称</th><th>平台</th><th>结果</th><th>耗时</th><th>说明</th></tr></thead><tbody>' + rows + '</tbody></table>'
}

function reload() { return api('/api/state').then(paint).catch(function (e) { setConn(e.message, 'bad') }) }

$('sel').onchange = function () {
  var i = parseInt(this.value, 10) || 0
  var body = { activeFarm: i, farms: FARMS.map(function (f) { return { baseUrl: f.baseUrl, username: f.username } }) }
  api('/api/farms', { method: 'POST', body: JSON.stringify(body) })
    .then(function (j) { ACTIVE = j.activeFarm; paint(j); $('saveMsg').className = 'msg ok'; $('saveMsg').textContent = '推送目标已切换' })
    .catch(function (e) { $('saveMsg').className = 'msg bad'; $('saveMsg').textContent = '切换失败：' + e.message })
}
$('add').onclick = function () {
  FARMS.push({ baseUrl: 'http://', username: '', passwordSet: false })
  ACTIVE = FARMS.length - 1; renderSel(); fillFarm(ACTIVE)
  $('saveMsg').className = 'msg'; $('saveMsg').textContent = '已新增条目：填好地址与密码后点「保存设置」'
}
$('del').onclick = function () {
  if (FARMS.length <= 1) { alert('至少要保留 1 台服务器'); return }
  var f = FARMS[ACTIVE]
  if (!confirm('确定删除服务器 ' + f.baseUrl + ' ？（点保存后生效）')) return
  FARMS.splice(ACTIVE, 1); ACTIVE = 0; renderSel(); fillFarm(ACTIVE)
  $('saveMsg').className = 'msg'; $('saveMsg').textContent = '已删除 ' + f.baseUrl + '，点「保存设置」生效'
}
$('save').onclick = function () {
  var farms = FARMS.map(function (f, i) {
    var it = { baseUrl: (i === ACTIVE ? $('f-url').value.trim() : f.baseUrl), username: (i === ACTIVE ? $('f-user').value.trim() : f.username) }
    if (i === ACTIVE) { var pw = $('f-pass').value; if (pw) it.password = pw }
    return it
  })
  $('saveMsg').className = 'msg'; $('saveMsg').textContent = '保存中…'
  api('/api/farms', { method: 'POST', body: JSON.stringify({ farms: farms, activeFarm: ACTIVE }) })
    .then(function (j) { $('f-pass').value = ''; paint(j); $('saveMsg').className = 'msg ok'; $('saveMsg').textContent = '已保存并生效' })
    .catch(function (e) { $('saveMsg').className = 'msg bad'; $('saveMsg').textContent = '保存失败：' + e.message })
}
$('push').onclick = function () {
  busy = true; paint(data || { farms: FARMS, last: null })
  api('/api/push', { method: 'POST', body: '{}' })
    .then(function (j) { busy = false; paint(Object.assign({}, data, { last: j.last })); reload() })
    .catch(function (e) { busy = false; reload(); $('summary').innerHTML = '<span class="state bad">' + esc(e.message) + '</span>' })
}

reload()
setInterval(function () { if (!busy) reload() }, 5000)
</script>
</body></html>`
}
