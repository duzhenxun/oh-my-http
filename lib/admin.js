import { MIN_PASSWORD } from './accounts.js'
import { AUTH_STYLE, escapeHTML } from './ui.js'

/** 操作结果码 -> 提示文案。用 code 而不是回显用户输入，避免 XSS。 */
const OK_MESSAGES = {
  created: '账号已创建',
  deleted: '账号已删除',
  password: '密码已重置',
  role: '角色已更新',
  enabled: '账号已启用',
  disabled: '账号已禁用',
  settings: '登录保护设置已保存并立即生效',
  unlocked: '已解除所有锁定',
  unlocked_one: '已解除该锁定',
}

const ERR_MESSAGES = {
  exists: '该用户名已存在',
  invalid_user: '用户名不合法（字母、数字、. _ -，1-32 位）',
  invalid_password: `密码至少 ${MIN_PASSWORD} 位`,
  invalid_role: '角色不合法',
  last_admin: '至少要保留一个可用的管理员账号',
  self_delete: '不能删除当前登录的账号',
  notfound: '账号不存在',
  not_locked: '该记录已经不存在了（可能已自动解锁）',
  csrf: '安全校验失败，请刷新页面重试',
  bad_request: '请求格式不正确',
  invalid_settings: '设置不合法：失败次数 0-100，锁定时长 0-10080 分钟',
}

function banner(kind, code) {
  if (!code) return ''
  const text = (kind === 'ok' ? OK_MESSAGES : ERR_MESSAGES)[code] || '操作完成'
  return `<div class="${kind === 'ok' ? 'ok' : 'err'}">${escapeHTML(text)}</div>`
}

/** 当前锁定 / 失败记录表格。 */
function lockedRows(locks, csrf, policy) {
  if (locks.length === 0) return ''
  const rows = locks
    .map((l) => {
      const hidden = `<input type="hidden" name="csrf" value="${escapeHTML(csrf)}"><input type="hidden" name="key" value="${escapeHTML(l.key)}">`
      const kind = l.kind === 'account' ? '<span class="tag admin">账号</span>' : '<span class="tag">IP</span>'
      const state = l.locked
        ? `<span class="tag off">已锁定</span> 将于 <b>${escapeHTML(fmtTime(l.lockedUntil))}</b> 自动解锁（还剩 ${Math.max(1, Math.ceil(l.retryAfter / 60))} 分钟）`
        : `<span class="tag">失败 ${l.failures} 次</span> 再错 ${Math.max(0, (l.limit || 0) - l.failures)} 次就会锁定`
      return `<tr>
  <td>${kind}</td>
  <td>${escapeHTML(l.target)}</td>
  <td>${state}</td>
  <td class="actions"><form method="post" action="/admin/users">${hidden}<button class="ghost" name="action" value="unlock-key">${l.locked ? '立即解锁' : '清除记录'}</button></form></td>
</tr>`
    })
    .join('\n')
  return `<section>
  <h2>当前锁定 / 失败记录</h2>
  <table>
    <thead><tr><th>类型</th><th>对象</th><th>状态</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="sub" style="margin:1rem 0 0">
    锁定是按账号（默认）或来源 IP（可选）计的，存在内存里：<b>重置密码会自动解除该账号的锁定</b>，重启服务会清空全部锁定。
  </p>
</section>`
}

function roleTag(role) {
  return role === 'admin' ? '<span class="tag admin">管理员</span>' : '<span class="tag">成员</span>'
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function row(user, store, actor, csrf) {
  const isSelf = user.username === actor
  const hidden = `<input type="hidden" name="csrf" value="${escapeHTML(csrf)}"><input type="hidden" name="target" value="${escapeHTML(user.username)}">`
  const roleForm =
    user.role === 'admin'
      ? `<form method="post" action="/admin/users">${hidden}<button class="ghost" name="action" value="set-member">降为成员</button></form>`
      : `<form method="post" action="/admin/users">${hidden}<button class="ghost" name="action" value="set-admin">设为管理员</button></form>`
  const toggle = user.disabled
    ? `<form method="post" action="/admin/users">${hidden}<button class="ghost" name="action" value="enable">启用</button></form>`
    : `<form method="post" action="/admin/users">${hidden}<button class="ghost" name="action" value="disable">禁用</button></form>`
  const remove = isSelf
    ? '<button class="ghost" disabled title="不能删除自己">删除</button>'
    : `<form method="post" action="/admin/users" onsubmit="return confirm('确定删除账号 ${escapeHTML(user.username)} ？')">${hidden}<button class="danger" name="action" value="delete">删除</button></form>`

  return `<tr>
  <td>${escapeHTML(user.username)}${isSelf ? ' <span class="tag">你</span>' : ''}${
    store.needsUpgrade(user.username)
      ? ' <span class="tag off" title="由 --pass-sha256 引导创建，建议重置密码">旧哈希</span>'
      : ''
  }</td>
  <td>${roleTag(user.role)}</td>
  <td>${user.disabled ? '<span class="tag off">已禁用</span>' : '<span class="tag">正常</span>'}</td>
  <td>${escapeHTML(fmtTime(user.createdAt))}</td>
  <td>${escapeHTML(fmtTime(user.lastLoginAt))}</td>
  <td class="actions">
    <form method="post" action="/admin/users">${hidden}<input name="password" type="password" placeholder="新密码" autocomplete="new-password"><button class="ghost" name="action" value="set-password">重置密码</button></form>
    ${roleForm}
    ${toggle}
    ${remove}
  </td>
</tr>`
}

/**
 * 管理后台页面。
 * @param {object} cfg
 * @param {object} store
 * @param {{actor: string, csrf: string, ok?: string, err?: string}} opts
 */
export function adminPage(cfg, store, { actor, csrf, ok, err, policy, lockedCount = 0, locks = [] }) {
  const users = store.list()
  const rows = users.map((u) => row(u, store, actor, csrf)).join('\n')
  const storage = store.file
    ? `<code>${escapeHTML(store.file)}</code>`
    : '未启用账号文件（本进程内的临时账号）'
  const sourceNote =
    policy.source === 'cli'
      ? '<div class="info">当前值是本次启动的命令行参数（<code>--account-max-attempts</code> / <code>--ip-max-attempts</code> / <code>--lockout-minutes</code>）指定的，会覆盖这里的设置；去掉命令行参数后以本页为准。</div>'
      : policy.source === 'default'
        ? '<div class="info">当前用的是默认值（3 次 / 60 分钟）。保存一次后就会持久化到这个账号文件里。</div>'
        : ''

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理 · ${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="wrap">
<div class="top">
  <div>
    <h1>账号管理</h1>
    <div class="who">${escapeHTML(cfg.realm)} · 当前登录 <b>${escapeHTML(actor)}</b>（管理员）</div>
  </div>
  <div>
    <a href="${cfg.mount === '/' ? '/' : `${escapeHTML(cfg.mount || '/')}/`}">文件</a>
    &nbsp;·&nbsp;<a href="/whoami">状态</a>
    &nbsp;·&nbsp;<a href="/logout">退出登录</a>
  </div>
</div>

${banner('ok', ok)}${banner('err', err)}

<section>
  <h2>添加账号</h2>
  <form class="newuser" method="post" action="/admin/users">
    <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
    <input type="hidden" name="action" value="create">
    <div class="f"><label for="nu">用户名</label><input id="nu" name="username" placeholder="alice" autocomplete="off" required></div>
    <div class="f"><label for="np">密码</label><input id="np" name="password" type="password" placeholder="至少 ${MIN_PASSWORD} 位" autocomplete="new-password" required></div>
    <div class="f"><label for="nr">角色</label><select id="nr" name="role"><option value="member">成员（只能看文件）</option><option value="admin">管理员（可管理账号）</option></select></div>
    <button type="submit">创建</button>
  </form>
</section>

<section>
  <h2>登录保护</h2>
  <form class="newuser" method="post" action="/admin/users">
    <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
    <input type="hidden" name="action" value="save-settings">
    <div class="f"><label for="ama">同一账号失败几次锁定</label><input id="ama" name="account_max_attempts" type="number" min="0" max="100" value="${policy.accountMaxAttempts}" required></div>
    <div class="f"><label for="ima">同一 IP 失败几次锁定</label><input id="ima" name="ip_max_attempts" type="number" min="0" max="100" value="${policy.ipMaxAttempts}" required></div>
    <div class="f"><label for="lm">锁定时长（分钟）</label><input id="lm" name="lockout_minutes" type="number" min="0" max="10080" value="${policy.lockoutMinutes}" required></div>
    <button type="submit">保存</button>
  </form>
  <p class="sub" style="margin:1rem 0 0">
    当前策略：同一账号失败 <b>${policy.accountMaxAttempts}</b> 次锁 <b>${policy.lockoutMinutes}</b> 分钟；${
      policy.ipMaxAttempts > 0
        ? `同一 IP 失败 <b>${policy.ipMaxAttempts}</b> 次也锁`
        : '按 IP 锁定已关闭（<b>0</b>，推荐：隧道 / 反代 / 公司出口后面大家共用一个 IP，开了会误伤整片人）'
    }。填 0 表示该维度不锁。
  </p>
  <p class="sub" style="margin:.5rem 0 0">
    表单登录和 <code>curl -u</code> 共用这把锁；同一个错误密码重复提交只算一次；锁定期间连正确密码也会被拒。当前被锁的键：<b>${lockedCount}</b> 个。
  </p>
  ${lockedCount > 0 ? `<form method="post" action="/admin/users" style="margin-top:1rem"><input type="hidden" name="csrf" value="${escapeHTML(csrf)}"><input type="hidden" name="action" value="unlock"><button class="danger" type="submit">立即解除所有锁定（${lockedCount} 个）</button></form>` : ''}
  ${sourceNote}
  <p class="sub" style="margin:.75rem 0 0">内网免认证的来源不受影响，即使被锁也能从局域网直接进来。</p>
</section>

${lockedRows(locks, csrf, policy)}

<section>
  <h2>共 ${users.length} 个账号</h2>
  <table>
    <thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th>最近登录</th><th></th></tr></thead>
    <tbody>
${rows || '<tr><td colspan="6">还没有账号</td></tr>'}
    </tbody>
  </table>
</section>

<section>
  <h2>说明</h2>
  <p class="sub" style="margin:0">账号保存在 ${storage}，密码用 scrypt 加盐哈希存储，文件权限 0600。会话密钥也保存在这里，所以登录状态 <b>在服务重启后依旧有效</b>；把该文件删掉才会让所有人重新登录。</p>
</section>
</body></html>`
}

/** 非管理员访问后台。 */
export function adminForbiddenPage(cfg, actor) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>无权访问</title>${AUTH_STYLE}</head>
<body class="center"><div class="card">
<h1>无权访问</h1>
<p class="sub">当前账号 <b>${escapeHTML(actor)}</b> 不是管理员。</p>
<p><a href="/">返回首页</a> · <a href="/logout">退出登录</a></p>
</div></body></html>`
}

/** 未启用认证时（没配密码）访问后台。 */
export function adminDisabledPage(cfg) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>管理</title>${AUTH_STYLE}</head>
<body class="center"><div class="card">
<h1>认证未启用</h1>
<p class="sub">当前没有配置密码，任何人都能访问，因此账号管理已关闭。</p>
<div class="info">用以下方式启动即可创建管理员账号：<br><code>--user admin --pass &lt;你的密码&gt;</code></div>
<p><a href="/">返回首页</a></p>
</div></body></html>`
}
