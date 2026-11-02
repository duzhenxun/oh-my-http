import os from 'node:os'
import { MIN_PASSWORD } from './accounts.js'

/** 分享链接默认有效期（天），与 server.js 保持一致。 */
const DEFAULT_SHARE_DAYS = 3
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
  bound: '子路径绑定已添加，立即生效（不用重启）',
  unbound: '子路径绑定已删除，立即生效',
  default_bound: '默认目录已设置，立即生效（挂在 /，优先于命令行绑定）',
  default_cleared: '后台设置的默认目录已清除，回到命令行绑定 / 内置首页',
  binding_auth: '独立账号已保存，访问该路径会弹框要求输入',
  binding_public: '已取消独立账号，该路径改回跟随主站认证',
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
  bind_exists: '该路径已经绑定过了，先删掉旧的再绑',
  bind_root: '根路径 / 请在「默认目录」里设置（子路径绑定要写 /abc 这种前缀）',
  bind_invalid: '路径不合法：必须以 / 开头，例如 /abc（不能含空格、?、#、..）',
  bind_reserved: '这个路径被内置接口占用（/admin、/login、/logout、/healthz、/whoami、/api）',
  bind_missing: '本地目录不存在或不是目录，请检查路径（支持绝对路径与 ~/xxx）',
  bind_auth_user: '独立账号用户名只能是字母、数字、. _ -，1-32 位',
  bind_auth_pass: '独立口令的密码不能为空，且至少 6 位',
  bind_auth_incomplete: '要设独立口令，至少要填密码（账号可选）',
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

function bindingRows(bindings, csrf, origin = '') {
  const sub = bindings.filter((b) => b.mount !== '/')
  if (sub.length === 0) {
    return '<tr><td colspan="6" class="sub">还没有子路径绑定</td></tr>'
  }
  const now = Date.now()
  return sub
    .map((b) => {
      const base = `<input type="hidden" name="csrf" value="${escapeHTML(csrf)}"><input type="hidden" name="bind_path" value="${escapeHTML(b.mount)}">`
      const authCell = !b.auth
        ? '<span class="tag">跟随主站</span>'
        : b.auth.username
          ? `<span class="tag admin">账号 + 密码</span> <code>${escapeHTML(b.auth.username)}</code>`
          : '<span class="tag admin">仅密码</span>'

      // 最近一次生成的分享链接：有效期（天）+ 结束时间（过期后标红）
      const share = b.share || null
      const expired = Boolean(share && share.expiresAt <= now)
      const daysCell = share ? `${share.days} 天` : '—'
      const endCell = !share
        ? '—'
        : expired
          ? '<span class="tag off">已过期</span>'
          : escapeHTML(fmtTime(new Date(share.expiresAt).toISOString()))
      const shareUrl = share
        ? `${origin || ''}${b.mount === '/' ? '/' : b.mount}?toke=${encodeURIComponent(share.token)}`
        : ''
      const copy =
        share && !expired
          ? `<button class="ghost" type="button" data-copy="${escapeHTML(shareUrl)}" title="${escapeHTML(shareUrl)}">复制链接</button>`
          : ''

      // 「分享链接」= 自动生成/轮换口令 + 签发带有效期的令牌（不提供手动设密码）
      const shareForm = `<form method="post" action="/admin/bindings" class="inline">${base}<input name="share_days" type="number" min="1" max="365" value="${share?.days || DEFAULT_SHARE_DAYS}" title="有效期（天）" class="days"><button class="ghost" name="action" value="share-binding">${share ? '重新生成分享链接' : '生成分享链接'}</button></form>`
      const remove = `<form method="post" action="/admin/bindings" onsubmit="return confirm('确定取消绑定 ${escapeHTML(b.mount)} ？文件不会被删')">${base}<button class="danger" name="action" value="delete-binding">删除</button></form>`

      return `<tr>
  <td><a href="${escapeHTML(b.mount)}/"><code>${escapeHTML(b.mount)}/</code></a></td>
  <td><code>${escapeHTML(b.root)}</code></td>
  <td>${authCell}</td>
  <td>${daysCell}</td>
  <td>${endCell}</td>
  <td class="actions">${copy}${shareForm}${remove}</td>
</tr>`
    })
    .join('\n')
}

/** 当前生效的默认目录（后台设置 > 命令行的 --root / --mount）。 */
function defaultState(bindings, cfg) {
  const saved = bindings.find((b) => b.mount === '/') || null
  if (saved) return { saved, root: saved.root, origin: 'admin' }
  if (cfg.root) {
    return {
      saved: null,
      root: cfg.root,
      origin: 'cli',
      where: cfg.mount === '/' ? '/' : `${cfg.mount}/`,
    }
  }
  return { saved: null, root: null, origin: 'none' }
}

/** 目录候选（datalist）：默认目录、命令行目录、各绑定目录、家目录、工作目录。 */
function dirCandidates(cfg, bindings) {
  const list = []
  const add = (p) => {
    if (p && !list.includes(p)) list.push(p)
  }
  add(bindings.find((b) => b.mount === '/')?.root)
  if (cfg.root) add(cfg.root)
  for (const b of bindings) add(b.root)
  add(os.homedir())
  add(process.cwd())
  return list.slice(0, 40)
}

function dirDatalist(cfg, bindings) {
  const list = dirCandidates(cfg, bindings)
  if (list.length === 0) return ''
  return `<datalist id="dir-options">${list
    .map((p) => `<option value="${escapeHTML(p)}"></option>`)
    .join('')}</datalist>`
}

/** 输入框旁边的「浏览…」按钮：打开弹窗挑目录。 */
const browseButton = (targetId) =>
  `<button type="button" class="ghost" data-browse="${escapeHTML(targetId)}">浏览…</button>`

/** 目录浏览弹窗：仿 Finder 的两栏选择器（纯原生 JS，无外部依赖；没有 JS 时仍可手输路径）。 */
function dirModal() {
  return `<div id="dir-modal" class="mk" hidden>
  <div class="mk-window" role="dialog" aria-modal="true" aria-labelledby="dir-title">
    <aside class="mk-side">
      <div id="dir-roots" class="mk-roots"></div>
    </aside>
    <div class="mk-main">
      <div class="mk-title" id="dir-title">选择项目文件夹</div>
      <div class="mk-toolbar">
        <button type="button" class="mk-icon" data-nav="back" title="上一级">‹</button>
        <div class="mk-crumbs" id="dir-crumbs"></div>
        <input class="mk-search" id="dir-search" placeholder="搜索" autocomplete="off">
      </div>
      <div class="mk-table">
        <div class="mk-head">
          <span class="c-name">名称</span><span class="c-size">大小</span><span class="c-kind">类型</span><span class="c-date">修改日期</span>
        </div>
        <div class="mk-body" id="dir-list"></div>
      </div>
      <div class="mk-foot">
        <span class="mk-msg" id="dir-msg"></span>
        <div class="mk-actions">
          <button type="button" class="mk-btn" data-close>取消</button>
          <button type="button" class="mk-btn primary" id="dir-pick">选取</button>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
(() => {
  const modal = document.getElementById('dir-modal')
  if (!modal) return
  const rootsEl = document.getElementById('dir-roots')
  const crumbsEl = document.getElementById('dir-crumbs')
  const listEl = document.getElementById('dir-list')
  const searchEl = document.getElementById('dir-search')
  const msgEl = document.getElementById('dir-msg')
  const pickBtn = document.getElementById('dir-pick')
  const GROUP = { favorite: '个人收藏', location: '位置', binding: '已绑定' }
  const ICON = {
    家目录: '⌂',
    桌面: '🖥',
    下载: '⇩',
    文稿: '🗒',
    应用程序: '▦',
    音乐: '♪',
    影片: '▷',
    图片: '◍',
    工作目录: '▤',
    '根目录 /': '💾',
  }

  let current = ''
  let parent = null
  let entries = []
  let selected = ''
  let target = null

  const humanSize = (n) => {
    if (n === null || n === undefined) return '—'
    if (n < 1024) return n + ' B'
    const units = ['KB', 'MB', 'GB', 'TB']
    let v = n / 1024
    let i = 0
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024
      i++
    }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i]
  }
  const fmtDate = (iso) => {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    const p = (x) => String(x).padStart(2, '0')
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  const groupOf = (kind) => GROUP[kind] || '其它'

  const renderRoots = (roots) => {
    rootsEl.textContent = ''
    const groups = new Map()
    for (const r of roots || []) {
      const g = groupOf(r.kind)
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(r)
    }
    for (const [g, items] of groups) {
      const title = document.createElement('div')
      title.className = 'mk-side-title'
      title.textContent = g
      rootsEl.appendChild(title)
      for (const r of items) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'mk-side-item' + (r.path === current ? ' on' : '')
        const ico = document.createElement('span')
        ico.className = 'mk-side-ico'
        ico.textContent = ICON[r.name] || (r.kind === 'binding' ? '🔗' : '📁')
        const label = document.createElement('span')
        label.textContent = r.name
        b.append(ico, label)
        b.title = r.path
        b.addEventListener('click', () => load(r.path))
        rootsEl.appendChild(b)
      }
    }
  }

  const renderCrumbs = (p) => {
    crumbsEl.textContent = ''
    if (!p) return
    const parts = p.split('/').filter(Boolean)
    const crumb = (label, full) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'mk-crumb'
      b.textContent = label
      b.addEventListener('click', () => load(full))
      return b
    }
    crumbsEl.appendChild(crumb('/', '/'))
    let acc = ''
    parts.forEach((seg, i) => {
      acc += '/' + seg
      const sep = document.createElement('span')
      sep.className = 'mk-sep'
      sep.textContent = '›'
      crumbsEl.appendChild(sep)
      crumbsEl.appendChild(i === parts.length - 1 ? (() => {
        const b = document.createElement('b')
        b.textContent = seg
        return b
      })() : crumb(seg, acc))
    })
  }

  const selectRow = (row, p, isDir) => {
    for (const el of listEl.querySelectorAll('.mk-row.on')) el.classList.remove('on')
    if (row) row.classList.add('on')
    selected = isDir ? p : ''
    pickBtn.disabled = !selected
  }

  const renderRows = () => {
    const q = searchEl.value.trim().toLowerCase()
    listEl.textContent = ''
    const shown = entries.filter((e) => !q || e.name.toLowerCase().includes(q))
    if (shown.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'mk-empty'
      empty.textContent = q ? '没有匹配的项目' : '（没有内容）'
      listEl.appendChild(empty)
      return
    }
    for (const e of shown) {
      const row = document.createElement('div')
      row.className = 'mk-row' + (e.path === selected ? ' on' : '') + (e.dir ? '' : ' file')
      const icon = document.createElement('span')
      icon.className = 'mk-icon-cell'
      icon.textContent = e.dir ? '📁' : '📄'
      const name = document.createElement('span')
      name.className = 'c-name'
      name.textContent = e.name
      name.title = e.path
      const size = document.createElement('span')
      size.className = 'c-size'
      size.textContent = e.dir ? '—' : humanSize(e.size)
      const kind = document.createElement('span')
      kind.className = 'c-kind'
      kind.textContent = e.kind || (e.dir ? '文件夹' : '文件')
      const date = document.createElement('span')
      date.className = 'c-date'
      date.textContent = fmtDate(e.mtime)
      row.append(icon, name, size, kind, date)
      row.addEventListener('click', () => selectRow(row, e.path, e.dir))
      row.addEventListener('dblclick', () => {
        if (e.dir) load(e.path)
      })
      listEl.appendChild(row)
    }
  }

  const render = (data) => {
    current = data.path || ''
    parent = data.parent || null
    entries = data.entries || []
    selected = current
    pickBtn.disabled = !current
    msgEl.textContent = data.error || (data.truncated ? '条目太多，只显示前 300 个；可直接手输完整路径' : '')
    renderRoots(data.roots || [])
    renderCrumbs(current)
    renderRows()
  }

  const load = async (p) => {
    msgEl.textContent = '读取中…'
    try {
      const res = await fetch('/admin/api/dirs?path=' + encodeURIComponent(p || ''), {
        headers: { accept: 'application/json' },
      })
      render(await res.json())
    } catch {
      msgEl.textContent = '读取失败，请重试'
    }
  }

  document.addEventListener('click', (ev) => {
    const trigger = ev.target.closest('[data-browse]')
    if (trigger) {
      target = document.getElementById(trigger.getAttribute('data-browse'))
      modal.hidden = false
      searchEl.value = ''
      load((target && target.value.trim()) || '')
      return
    }
    if (ev.target.closest('[data-close]') || ev.target === modal) modal.hidden = true
  })
  document.querySelector('[data-nav="back"]').addEventListener('click', () => {
    if (parent) load(parent)
  })
  searchEl.addEventListener('input', renderRows)
  searchEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      pickBtn.click()
    }
  })
  pickBtn.addEventListener('click', () => {
    if (target && selected) target.value = selected
    modal.hidden = true
  })
  document.addEventListener('keydown', (ev) => {
    if (modal.hidden) return
    if (ev.key === 'Escape') modal.hidden = true
    if (ev.key === 'Enter' && !pickBtn.disabled && document.activeElement !== searchEl) pickBtn.click()
  })
})()
</script>`
}

/**
 * 目录绑定页（/admin/bindings）：默认目录 + 子路径绑定 + 每条绑定的独立账号。
 * @param {object} cfg
 * @param {object} store
 * @param {{actor: string, actorMethod?: string, csrf: string, ok?: string, err?: string, bindings?: object[]}} opts
 */
export function bindingsPage(
  cfg,
  store,
  {
    actor,
    actorMethod,
    csrf,
    ok,
    err,
    bindings = [],
    share = '',
    shareMount = '',
    shareDays = '',
    shareExp = '',
    origin = '',
  },
) {
  const def = defaultState(bindings, cfg)
  const draft = def.origin === 'admin' ? def.root : ''
  const current =
    def.origin === 'admin'
      ? `<code>${escapeHTML(def.root)}</code>（后台设置，优先于命令行）`
      : def.origin === 'cli'
        ? `<code>${escapeHTML(def.root)}</code>（来自命令行 ${def.where === '/' ? '--root' : `--mount ${escapeHTML(def.where)}`}；可在上面改成后台设置）`
        : '<b>未设置</b>（内置首页，除内置接口外不提供任何文件）'
  const persistent = store.file
    ? `绑定表保存在 <code>${escapeHTML(store.file)}</code> 的 <code>settings.mounts</code> 里，重启后依旧有效。`
    : '<b>当前没有使用账号文件</b>（<code>--users-file none</code>），绑定只会存在内存里，重启后丢失。'

  const shareUrl =
    share && shareMount
      ? `${origin || ''}${shareMount === '/' ? '/' : shareMount}?toke=${encodeURIComponent(share)}`
      : ''
  const expires = shareExp ? fmtTime(shareExp) : ''
  const shareBox = shareUrl
    ? `<section>
  <h2>分享链接</h2>
  <p class="sub" style="margin:0 0 .6rem">
    把这个链接发出去，对方打开就能直接看，之后会种一个同有效期的 Cookie，点进子目录也不用再输。
    ${expires ? `有效期至 <b>${escapeHTML(expires)}</b>（${escapeHTML(String(shareDays || ''))} 天），到期自动失效。` : ''}
  </p>
  <div class="newuser"><div class="f" style="flex:1 1 100%"><input id="share-url" value="${escapeHTML(shareUrl)}" readonly onclick="this.select()"></div><button type="button" onclick="const i=document.getElementById('share-url');i.select();document.execCommand('copy')">复制</button></div>
  <p class="sub" style="margin:.75rem 0 0">链接里是签名令牌，不含密码。需要换密码时再点一次「重新生成分享链接」，旧链接立即失效。</p>
</section>`
    : ''

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>目录绑定 · ${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="wrap">
${adminNav(cfg, actor, actorMethod, 'bindings')}

${banner('ok', ok)}${banner('err', err)}
${shareBox}

<section>
  <h2>默认目录（挂在 /）</h2>
  <form class="newuser" method="post" action="/admin/bindings">
    <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
    <div class="f"><label for="dd">目录</label><input id="dd" name="default_dir" value="${escapeHTML(draft)}" list="dir-options" placeholder="${def.origin === 'cli' ? escapeHTML(def.root) : '/Users/you/site 或 ~/Downloads'}" autocomplete="off" required></div>
    ${browseButton('dd')}
    <button name="action" value="save-default" type="submit">保存</button>
    ${def.saved ? `<button class="ghost" name="action" value="clear-default" type="submit" onclick="return confirm('清除后台设置的默认目录？文件不会被删，会回到命令行绑定或内置首页')">清除</button>` : ''}
  </form>
  <p class="sub" style="margin:.9rem 0 0">当前默认目录：${current}</p>
</section>

<section>
  <h2>子路径绑定</h2>
  <form class="newuser" method="post" action="/admin/bindings">
    <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
    <input type="hidden" name="action" value="add-binding">
    <div class="f"><label for="bp">访问路径</label><input id="bp" name="bind_path" placeholder="/abc" autocomplete="off" required></div>
    <div class="f"><label for="bd">本地目录</label><input id="bd" name="bind_dir" list="dir-options" placeholder="/Users/you/project 或 ~/Downloads" autocomplete="off" required></div>
    ${browseButton('bd')}
    <label class="check"><input type="checkbox" name="auto_auth" value="1" checked> 自动生成访问口令（不用手填密码）</label>
    <button type="submit">绑定</button>
  </form>
  <p class="sub" style="margin:.75rem 0 0">
    勾选「自动生成访问口令」时，系统会直接生成一个随机口令（与主站账号、内网免认证无关），不用自己想密码；
    生成后立刻给出<b>分享链接</b>（默认 3 天有效）。不勾选则这条路径跟随主站认证。
    之后想换密码不用找设置项：点「重新生成分享链接」就会换一个新口令，旧链接立刻失效。
  </p>
  <table style="margin-top:1.2rem">
    <thead><tr><th>访问路径</th><th>绑定目录</th><th>访问口令</th><th>有效期</th><th>结束时间</th><th></th></tr></thead>
    <tbody>${bindingRows(bindings, csrf, origin)}</tbody>
  </table>
</section>

<section>
  <h2>说明</h2>
  <p class="sub" style="margin:0 0 .6rem">
    保存后<b>立即生效，不用重启</b>：默认目录决定 <code>/</code> 下看到什么；子路径把 <code>/abc</code> 这种前缀单独指到另一个目录。
    目录可以<b>点「浏览…」在弹窗里挑</b>，也可以<b>直接手输</b>（绝对路径或 <code>~/xxx</code>）。
  </p>
  <p class="sub" style="margin:0 0 .6rem">
    路径按<b>最长前缀</b>匹配，可以绑多层（<code>/abc/logs</code>），子路径总是赢过默认目录；
    <code>/admin</code>、<code>/login</code>、<code>/healthz</code>、<code>/whoami</code>、<code>/api</code> 这些内置接口不能占用。
  </p>
  <p class="sub" style="margin:0 0 .6rem">
    目录暂时不存在时该路径返回 404，绑定不会被删掉（外挂盘没挂上时很实用）。
    独立口令的密码用 scrypt 加盐哈希保存，连错同样会被锁定，可在「账号管理 → 当前锁定 / 失败记录」里解锁。
    分享链接形如 <code>http://这台机器/路径?toke=令牌</code>（也认 <code>token</code> / <code>pwd</code> / <code>key</code>），
    令牌带过期时间（默认 3 天，行内可改），验证通过后种一个同有效期的 Cookie 并跳到不带令牌的干净地址；
    旧版直接把密码拼在 URL 里的写法仍然兼容。
  </p>
  <p class="sub" style="margin:0">${persistent}</p>
</section>

${dirModal()}
${dirDatalist(cfg, bindings)}
<script>
(() => {
  const copyText = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {}
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-copy]')
    if (!btn) return
    const ok = await copyText(btn.dataset.copy || '')
    const old = btn.textContent
    btn.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => {
      btn.textContent = old
    }, 1200)
  })
})()
</script>
</body></html>`
}

/** 后台顶部：标题 + 两个 tab（账号管理 / 目录绑定）。 */
function adminNav(cfg, actor, actorMethod, active) {
  const localNote = actorMethod === 'local' ? ' · <span class="tag">本机免登录</span>' : ''
  const fileUrl = cfg.mount === '/' ? '/' : `${cfg.mount || '/'}/`
  const tab = (id, href, label) =>
    `<a class="tab${id === active ? ' on' : ''}" href="${href}">${label}</a>`
  return `<div class="top">
  <div>
    <h1>${active === 'bindings' ? '目录绑定' : '账号管理'}</h1>
    <div class="who">${escapeHTML(cfg.realm)} · 当前登录 <b>${escapeHTML(actor)}</b>（管理员）${localNote}</div>
  </div>
  <div>
    <a href="${escapeHTML(fileUrl)}">文件</a>
    &nbsp;·&nbsp;<a href="/whoami">状态</a>
    &nbsp;·&nbsp;<a href="/logout">退出登录</a>
  </div>
</div>
<div class="tabs">${tab('users', '/admin', '账号管理')}${tab('bindings', '/admin/bindings', '目录绑定')}</div>`
}

/**
 * 管理后台页面。
 * @param {object} cfg
 * @param {object} store
 * @param {{actor: string, csrf: string, ok?: string, err?: string}} opts
 */
export function adminPage(cfg, store, { actor, csrf, ok, err, policy, lockedCount = 0, locks = [], actorMethod }) {
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
${adminNav(cfg, actor, actorMethod, 'users')}

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
