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
.wrap{max-width:960px;margin:0 auto;display:grid;gap:16px}
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
.pill.ok{background:var(--ok-bg);color:var(--ok)}
.empty{color:var(--muted);font-size:13px;padding:10px 0}
.form{display:grid;grid-template-columns:180px 1fr;gap:10px 14px;align-items:center}
.form label{color:var(--muted);font-size:13px}
.form input[type=text],.form input[type=password],.form input[type=number]{width:100%;padding:9px 11px;border-radius:9px;
border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
.form .chk{display:flex;gap:16px;flex-wrap:wrap}
.form .chk label{color:var(--fg);display:flex;gap:6px;align-items:center;font-size:13px}
.hint{grid-column:2;color:var(--muted);font-size:12px;margin-top:-4px}
.msg{margin-top:10px;font-size:13px}
.msg.bad{color:var(--err)}
.msg.ok{color:var(--ok)}
@media(max-width:640px){.form{grid-template-columns:1fr}.hint{grid-column:1}}
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
    <button class="primary" id="push">⚡ 立即推送 code 到农场</button>
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

  <div class="card" id="cfgCard">
    <h2>运行设置</h2>
    <div id="cfgLocked" class="tip" hidden>托管模式下请在萌卡插件卡片的「配置」里修改，保存后框架会把新配置下发给插件；本页只做展示与手动推送。</div>
    <div class="form">
      <label for="farm_url">农场面板地址</label>
      <input id="farm_url" type="text" placeholder="https://farm.qqai.ren:59443"/>
      <label for="farm_username">农场管理员</label>
      <input id="farm_username" type="text" placeholder="admin"/>
      <label for="farm_password">农场管理员密码</label>
      <input id="farm_password" type="password" autocomplete="new-password" placeholder="留空表示不修改"/>
      <div class="hint">密码只写入萌卡插件配置，不回显；修改其他项时留空即可保留原密码。</div>
      <label for="interval_minutes">自动推送间隔</label>
      <input id="interval_minutes" type="number" min="1" max="120" step="1"/>
      <label for="qq_filter">仅推送指定 QQ</label>
      <input id="qq_filter" type="text" placeholder="逗号分隔，如 123456,789012；留空=全部在线账号"/>
      <label>推送平台</label>
      <div class="chk">
        <label><input type="checkbox" id="push_android"/> Android（可正常取码）</label>
        <label><input type="checkbox" id="push_linux"/> Linux QQ（实验，取到 code 才推）</label>
      </div>
      <div class="hint">Linux 协议目前不支持农场取码，开启后失败的账号会在结果里单独标出。</div>
      <div></div>
      <div class="row"><button class="primary" id="save">保存设置</button><span class="msg" id="saveMsg"></span></div>
    </div>
  </div>

  <div class="card">
    <h2>说明</h2>
    <div class="tip">插件每 <b id="iv">5</b> 分钟自动为在线 QQ 取新 code 并推送到农场（同名账号自动续登）；
    点击上方「立即推送」可随时手动触发，适合刚上线一个 QQ、或想立刻刷新登录态时使用。农场面板里账号备注需与 QQ 号一致，否则会新增而不是续登。</div>
  </div>
</div>
<script>
var state = { data: null, busy: false }
function $(id) { return document.getElementById(id) }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
function api(path, opts) {
  return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {}))
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j }) })
}
function setConn(text, cls) { var el = $('conn'); el.textContent = text; el.className = 'state ' + (cls || '') }

function paint(d) {
  state.data = d
  $('ver').textContent = 'v' + (d.version || '') + (d.platform ? ' · ' + d.platform : '')
  if (!d.connected) setConn(d.active ? '框架未连接' : '待激活', 'warn')
  else setConn(d.active ? '运行中' : '已连接', d.active ? '' : 'warn')
  var p = d.problems || []
  if (p.length) setConn(p.join(' / '), 'bad')
  var c = d.config || {}
  if (document.activeElement !== $('farm_url')) {
    $('farm_url').value = c.farm_url || ''
    $('farm_username').value = c.farm_username || ''
    $('interval_minutes').value = c.interval_minutes || 5
    $('qq_filter').value = c.qq_filter || ''
    $('push_android').checked = c.push_android !== false
    $('push_linux').checked = c.push_linux === true
    $('farm_password').placeholder = c.password_set ? '已保存，留空则不修改' : '请输入农场管理员密码'
  }
  // 托管模式配置由萌卡插件卡片管理，本页只读
  var locked = d.mode === 'managed' || d.mode === 'native'
  $('cfgLocked').hidden = !locked
  if (locked) {
    var inputs = document.querySelectorAll('.form input, #save')
    for (var i = 0; i < inputs.length; i++) inputs[i].disabled = true
    $('saveMsg').textContent = ''
  }
  $('iv').textContent = c.interval_minutes || 5
  $('push').disabled = state.busy || !d.connected || d.active === false
  $('push').textContent = state.busy || d.busy ? '推送中…' : '⚡ 立即推送 code 到农场'

  // 在线账号
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
  $('summary').innerHTML = head + '<span class="tip">触发：' + esc(r.reason || '') + ' · ' + when +
    (r.ms ? ' · 用时 ' + r.ms + ' ms' : '') + '</span>'
  if (!r.items || !r.items.length) { $('items').innerHTML = ''; return }
  var rows = r.items.map(function (i) {
    return '<tr><td class="mono">' + esc(i.selfId) + '</td><td>' + esc(i.nickname || '-') + '</td><td>' +
      (i.clientType === 'linuxqq' ? 'Linux' : 'Android') + '</td><td><span class="pill ' + (i.ok ? 'ok' : 'bad') + '">' +
      (i.ok ? '成功' : '失败') + '</span></td><td>' + (i.ms || 0) + ' ms</td><td class="err">' + esc(cnError(i.error)) + '</td></tr>'
  }).join('')
  $('items').innerHTML = '<table><thead><tr><th>QQ</th><th>昵称</th><th>平台</th><th>结果</th><th>耗时</th><th>说明</th></tr></thead><tbody>' +
    rows + '</tbody></table>'
}

function cnError(e) {
  if (!e) return ''
  var s = String(e)
  if (/not.*support|unsupported|不支持/i.test(s)) return s + '（Linux 协议无法取农场 code，属正常）'
  if (/not online|离线|offline/i.test(s)) return s + '（账号已下线）'
  return s
}

function reload() { return api('/api/state').then(paint).catch(function (e) { setConn(e.message, 'bad') }) }

$('push').onclick = function () {
  state.busy = true; paint(state.data || { config: {}, last: null })
  api('/api/push', { method: 'POST', body: '{}' })
    .then(function (j) { state.busy = false; paint(Object.assign({}, state.data, { last: j.last })); reload() })
    .catch(function (e) { state.busy = false; reload(); $('summary').innerHTML = '<span class="state bad">' + esc(e.message) + '</span>' })
}

$('save').onclick = function () {
  var body = {
    farm_url: $('farm_url').value.trim(),
    farm_username: $('farm_username').value.trim(),
    interval_minutes: Number($('interval_minutes').value) || 5,
    qq_filter: $('qq_filter').value.trim(),
    push_android: $('push_android').checked,
    push_linux: $('push_linux').checked
  }
  if ($('farm_password').value) body.farm_password = $('farm_password').value
  var msg = $('saveMsg'); msg.className = 'msg'; msg.textContent = '保存中…'
  api('/api/config', { method: 'POST', body: JSON.stringify(body) })
    .then(function (j) { msg.className = 'msg ok'; msg.textContent = '已保存并生效'; $('farm_password').value = ''; paint(j) })
    .catch(function (e) { msg.className = 'msg bad'; msg.textContent = '保存失败：' + e.message })
}

reload()
setInterval(function () { if (!state.busy) reload() }, 5000)
</script>
</body></html>`
}
