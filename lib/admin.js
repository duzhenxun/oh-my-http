import os from 'node:os'
import { MIN_PASSWORD } from './accounts.js'
import { hasKey } from './i18n.js'
import { AUTH_STYLE, escapeHTML } from './ui.js'

/** 分享链接默认有效期（天），与 server.js 保持一致。 */
const DEFAULT_SHARE_DAYS = 3

/** 操作结果码 -> 提示文案（走词典，避免回显用户输入造成 XSS）。 */
function banner(t, kind, code) {
  if (!code) return ''
  const key = `${kind === 'ok' ? 'ok' : 'err'}.${code}`
  const text = hasKey(key) ? t(key, { min: MIN_PASSWORD }) : t('err.default')
  return `<div class="${kind === 'ok' ? 'ok' : 'err'}">${escapeHTML(text)}</div>`
}

/** 当前锁定 / 失败记录表格。 */
function lockedRows(t, locks, csrf, policy) {
  if (locks.length === 0) return ''
  const rows = locks
    .map((l) => {
      const hidden = `<input type="hidden" name="csrf" value="${escapeHTML(csrf)}"><input type="hidden" name="key" value="${escapeHTML(l.key)}">`
      const kind =
        l.kind === 'account'
          ? `<span class="tag admin">${escapeHTML(t('admin.tagAccount'))}</span>`
          : `<span class="tag">${escapeHTML(t('admin.tagIp'))}</span>`
      const state = l.locked
        ? `<span class="tag off">${escapeHTML(t('admin.tagLocked'))}</span> ${t('admin.lockUntil', {
            time: `<b>${escapeHTML(fmtTime(l.lockedUntil))}</b>`,
            mins: Math.max(1, Math.ceil(l.retryAfter / 60)),
          })}`
        : `<span class="tag">${escapeHTML(
            t('admin.lockFails', {
              n: l.failures,
              left: Math.max(0, (l.limit || 0) - l.failures),
            }),
          )}</span>`
      return `<tr>
  <td>${kind}</td>
  <td>${escapeHTML(l.target)}</td>
  <td>${state}</td>
  <td class="actions"><form method="post" action="/admin/users">${hidden}<button class="ghost" name="action" value="unlock-key">${escapeHTML(
        l.locked ? t('admin.unlockNow') : t('admin.clearRecord'),
      )}</button></form></td>
</tr>`
    })
    .join('\n')
  return `<section>
  <h2>${escapeHTML(t('admin.locksTitle'))}</h2>
  <table>
    <thead><tr><th>${escapeHTML(t('admin.thType'))}</th><th>${escapeHTML(t('admin.thTarget'))}</th><th>${escapeHTML(
      t('admin.thState'),
    )}</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="sub" style="margin:1rem 0 0">${escapeHTML(t('admin.locksNote'))}</p>
</section>`
}

function roleTag(t, role) {
  return role === 'admin'
    ? `<span class="tag admin">${escapeHTML(t('common.admin'))}</span>`
    : `<span class="tag">${escapeHTML(t('common.member'))}</span>`
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function row(t, user, store, actor, csrf) {
  const isSelf = user.username === actor
  const hidden = `<input type="hidden" name="csrf" value="${escapeHTML(csrf)}"><input type="hidden" name="target" value="${escapeHTML(
    user.username,
  )}">`
  const roleForm =
    user.role === 'admin'
      ? `<form method="post" action="/admin/users">${hidden}<button class="ghost" name="action" value="set-member">${escapeHTML(
          t('admin.setMember'),
        )}</button></form>`
      : `<form method="post" action="/admin/users">${hidden}<button class="ghost" name="action" value="set-admin">${escapeHTML(
          t('admin.setAdmin'),
        )}</button></form>`
  const toggle = user.disabled
    ? `<form method="post" action="/admin/users">${hidden}<button class="ghost" name="action" value="enable">${escapeHTML(
        t('admin.enable'),
      )}</button></form>`
    : `<form method="post" action="/admin/users">${hidden}<button class="ghost" name="action" value="disable">${escapeHTML(
        t('admin.disable'),
      )}</button></form>`
  const remove = isSelf
    ? `<button class="ghost" disabled title="${escapeHTML(t('admin.selfDelete'))}">${escapeHTML(t('common.delete'))}</button>`
    : `<form method="post" action="/admin/users" onsubmit="return confirm(${JSON.stringify(
        t('admin.deleteConfirm', { user: user.username }),
      )})">${hidden}<button class="danger" name="action" value="delete">${escapeHTML(t('common.delete'))}</button></form>`

  return `<tr>
  <td>${escapeHTML(user.username)}${isSelf ? ` <span class="tag">${escapeHTML(t('common.you'))}</span>` : ''}${
    store.needsUpgrade(user.username)
      ? ` <span class="tag off" title="${escapeHTML(t('admin.legacyHint'))}">${escapeHTML(t('admin.legacyHash'))}</span>`
      : ''
  }</td>
  <td>${roleTag(t, user.role)}</td>
  <td>${
    user.disabled
      ? `<span class="tag off">${escapeHTML(t('common.disabled'))}</span>`
      : `<span class="tag">${escapeHTML(t('common.enabled'))}</span>`
  }</td>
  <td>${escapeHTML(fmtTime(user.createdAt))}</td>
  <td>${escapeHTML(fmtTime(user.lastLoginAt))}</td>
  <td class="actions">
    <form method="post" action="/admin/users">${hidden}<input name="password" type="password" placeholder="${escapeHTML(
      t('admin.newPassword'),
    )}" autocomplete="new-password"><button class="ghost" name="action" value="set-password">${escapeHTML(
      t('admin.resetPassword'),
    )}</button></form>
    ${roleForm}
    ${toggle}
    ${remove}
  </td>
</tr>`
}

function bindingRows(t, bindings, csrf, origin = '') {
  const sub = bindings.filter((b) => b.mount !== '/')
  if (sub.length === 0) {
    return `<tr><td colspan="6" class="sub">${escapeHTML(t('bindings.empty'))}</td></tr>`
  }
  const now = Date.now()
  return sub
    .map((b) => {
      const base = `<input type="hidden" name="csrf" value="${escapeHTML(csrf)}"><input type="hidden" name="bind_path" value="${escapeHTML(
        b.mount,
      )}">`
      const authCell = !b.auth
        ? `<span class="tag">${escapeHTML(t('bindings.authPublic'))}</span>`
        : b.auth.username
          ? `<span class="tag admin">${escapeHTML(t('bindings.authBoth'))}</span> <code>${escapeHTML(b.auth.username)}</code>`
          : `<span class="tag admin">${escapeHTML(t('bindings.authPassword'))}</span>`

      const share = b.share || null
      const expired = Boolean(share && share.expiresAt <= now)
      const daysCell = share ? escapeHTML(t('bindings.shareDays', { n: share.days })) : t('common.none')
      const endCell = !share
        ? t('common.none')
        : expired
          ? `<span class="tag off">${escapeHTML(t('bindings.expired'))}</span>`
          : escapeHTML(fmtTime(new Date(share.expiresAt).toISOString()))
      const shareUrl = share
        ? `${origin || ''}${b.mount === '/' ? '/' : b.mount}?toke=${encodeURIComponent(share.token)}`
        : ''
      const copy =
        share && !expired
          ? `<button class="ghost" type="button" data-copy="${escapeHTML(shareUrl)}" title="${escapeHTML(
              shareUrl,
            )}">${escapeHTML(t('common.copyLink'))}</button>`
          : ''

      const shareForm = `<form method="post" action="/admin/bindings" class="inline">${base}<input name="share_days" type="number" min="1" max="365" value="${
        share?.days || DEFAULT_SHARE_DAYS
      }" title="${escapeHTML(t('bindings.daysTitle'))}" class="days"><button class="ghost" name="action" value="share-binding">${escapeHTML(
        share ? t('bindings.regenerate') : t('bindings.generate'),
      )}</button></form>`
      const remove = `<form method="post" action="/admin/bindings" onsubmit="return confirm(${JSON.stringify(
        t('bindings.deleteConfirm', { mount: b.mount }),
      )})">${base}<button class="danger" name="action" value="delete-binding">${escapeHTML(
        t('common.delete'),
      )}</button></form>`

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
    return { saved: null, root: cfg.root, origin: 'cli', where: cfg.mount === '/' ? '/' : `${cfg.mount}/` }
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
  return `<datalist id="dir-options">${list.map((p) => `<option value="${escapeHTML(p)}"></option>`).join('')}</datalist>`
}

/** 输入框旁边的「浏览…」按钮：打开弹窗挑目录。 */
const browseButton = (t, targetId) =>
  `<button type="button" class="ghost" data-browse="${escapeHTML(targetId)}">${escapeHTML(t('common.browse'))}</button>`

/** 目录浏览弹窗：仿 Finder 的两栏选择器（原生 JS，无外部依赖）。 */
function dirModal(t) {
  const msg = JSON.stringify({
    empty: t('dir.empty'),
    noMatch: t('dir.noMatch'),
    reading: t('dir.reading'),
    loadFail: t('dir.loadFail'),
    tooMany: t('dir.tooMany'),
    folder: t('dir.folder'),
    up: t('dir.up'),
    title: t('dir.title'),
    name: t('dir.name'),
    size: t('dir.size'),
    kind: t('dir.kind'),
    date: t('dir.date'),
    search: t('dir.search'),
    pick: t('dir.pick'),
    cancel: t('common.cancel'),
    groupFavorite: t('dir.group.favorite'),
    groupLocation: t('dir.group.location'),
    groupBinding: t('dir.group.binding'),
  })
  return `<div id="dir-modal" class="mk" hidden>
  <div class="mk-window" role="dialog" aria-modal="true" aria-labelledby="dir-title">
    <aside class="mk-side">
      <div id="dir-roots" class="mk-roots"></div>
    </aside>
    <div class="mk-main">
      <div class="mk-title" id="dir-title">${escapeHTML(t('dir.title'))}</div>
      <div class="mk-toolbar">
        <button type="button" class="mk-icon" data-nav="back" title="${escapeHTML(t('dir.up'))}">‹</button>
        <div class="mk-crumbs" id="dir-crumbs"></div>
        <input class="mk-search" id="dir-search" placeholder="${escapeHTML(t('dir.search'))}" autocomplete="off">
      </div>
      <div class="mk-table">
        <div class="mk-head">
          <span></span><span class="c-name">${escapeHTML(t('dir.name'))}</span><span class="c-size">${escapeHTML(
            t('dir.size'),
          )}</span><span class="c-kind">${escapeHTML(t('dir.kind'))}</span><span class="c-date">${escapeHTML(
            t('dir.date'),
          )}</span>
        </div>
        <div class="mk-body" id="dir-list"></div>
      </div>
      <div class="mk-foot">
        <span class="mk-msg" id="dir-msg"></span>
        <div class="mk-actions">
          <button type="button" class="mk-btn" data-close>${escapeHTML(t('common.cancel'))}</button>
          <button type="button" class="mk-btn mk-primary" id="dir-pick">${escapeHTML(t('dir.pick'))}</button>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
(() => {
  const MSG = ${msg}
  const modal = document.getElementById('dir-modal')
  if (!modal) return
  const rootsEl = document.getElementById('dir-roots')
  const crumbsEl = document.getElementById('dir-crumbs')
  const listEl = document.getElementById('dir-list')
  const searchEl = document.getElementById('dir-search')
  const msgEl = document.getElementById('dir-msg')
  const pickBtn = document.getElementById('dir-pick')
  const GROUP = { favorite: MSG.groupFavorite, location: MSG.groupLocation, binding: MSG.groupBinding }
  const ICON = { '⌂': '⌂' }

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
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i]
  }
  const fmtDate = (iso) => {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    const p = (x) => String(x).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  const groupOf = (kind) => GROUP[kind] || GROUP.location

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
        ico.textContent = r.icon || (r.kind === 'binding' ? '🔗' : '📁')
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
      if (i === parts.length - 1) {
        const b = document.createElement('b')
        b.textContent = seg
        crumbsEl.appendChild(b)
      } else {
        crumbsEl.appendChild(crumb(seg, acc))
      }
    })
  }

  const selectRow = (rowEl, p, isDir) => {
    for (const el of listEl.querySelectorAll('.mk-row.on')) el.classList.remove('on')
    if (rowEl) rowEl.classList.add('on')
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
      empty.textContent = q ? MSG.noMatch : MSG.empty
      listEl.appendChild(empty)
      return
    }
    for (const e of shown) {
      const rowEl = document.createElement('div')
      rowEl.className = 'mk-row' + (e.path === selected ? ' on' : '') + (e.dir ? '' : ' file')
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
      kind.textContent = e.kind || MSG.folder
      const date = document.createElement('span')
      date.className = 'c-date'
      date.textContent = fmtDate(e.mtime)
      rowEl.append(icon, name, size, kind, date)
      rowEl.addEventListener('click', () => selectRow(rowEl, e.path, e.dir))
      rowEl.addEventListener('dblclick', () => { if (e.dir) load(e.path) })
      listEl.appendChild(rowEl)
    }
  }

  const render = (data) => {
    current = data.path || ''
    parent = data.parent || null
    entries = data.entries || []
    selected = current
    pickBtn.disabled = !current
    msgEl.textContent = data.error || (data.truncated ? MSG.tooMany : '')
    renderRoots(data.roots || [])
    renderCrumbs(current)
    renderRows()
  }

  const load = async (p) => {
    msgEl.textContent = MSG.reading
    try {
      const res = await fetch('/admin/api/dirs?path=' + encodeURIComponent(p || ''), {
        headers: { accept: 'application/json' },
      })
      render(await res.json())
    } catch {
      msgEl.textContent = MSG.loadFail
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
  document.querySelector('[data-nav="back"]').addEventListener('click', () => { if (parent) load(parent) })
  searchEl.addEventListener('input', renderRows)
  searchEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); pickBtn.click() }
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

/** 语言切换（两个小表单，各自提交一种语言）。 */
function langSwitch(t, csrf, lang, action) {
  const item = (code, label) =>
    code === lang
      ? `<b>${escapeHTML(label)}</b>`
      : `<form method="post" action="${escapeHTML(action)}" class="inline"><input type="hidden" name="csrf" value="${escapeHTML(
          csrf,
        )}"><input type="hidden" name="action" value="set-lang"><input type="hidden" name="lang" value="${code}"><button class="linklike" type="submit">${escapeHTML(
          label,
        )}</button></form>`
  return `<span class="langs" title="${escapeHTML(t('nav.language'))}">${item('zh', '中文')}<span class="sep">/</span>${item(
    'en',
    'English',
  )}</span>`
}

/**
 * 目录绑定页（/admin/bindings）：默认目录 + 子路径绑定 + 分享链接。
 */
export function bindingsPage(
  cfg,
  store,
  { actor, actorMethod, csrf, ok, err, bindings = [], share = '', shareMount = '', shareDays = '', shareExp = '', origin = '', t, lang },
) {
  const def = defaultState(bindings, cfg)
  const draft = def.origin === 'admin' ? def.root : ''
  const current =
    def.origin === 'admin'
      ? `<code>${escapeHTML(def.root)}</code> (${escapeHTML(t('bindings.current.admin'))})`
      : def.origin === 'cli'
        ? `<code>${escapeHTML(def.root)}</code> (${escapeHTML(
            t('bindings.current.cli', { flag: def.where === '/' ? '--root' : `--mount ${def.where}` }),
          )})`
        : `<b>${escapeHTML(t('bindings.current.none'))}</b> (${escapeHTML(t('bindings.current.noneHint'))})`
  const persistent = store.file
    ? t('bindings.persist.file', { file: `<code>${escapeHTML(store.file)}</code>` })
    : t('bindings.persist.memory')

  const shareUrl =
    share && shareMount ? `${origin || ''}${shareMount === '/' ? '/' : shareMount}?toke=${encodeURIComponent(share)}` : ''
  const shareBox = shareUrl
    ? `<section>
  <h2>${escapeHTML(t('bindings.shareTitle'))}</h2>
  <p class="sub" style="margin:0 0 .6rem">${escapeHTML(t('bindings.shareNote'))}${
    shareExp
      ? ` ${t('bindings.shareExpires', {
          time: `<b>${escapeHTML(fmtTime(shareExp))}</b>`,
          days: escapeHTML(String(shareDays || '')),
        })}`
      : ''
  }</p>
  <div class="newuser"><div class="f" style="flex:1 1 100%"><input id="share-url" value="${escapeHTML(
    shareUrl,
  )}" readonly onclick="this.select()"></div><button type="button" onclick="const i=document.getElementById('share-url');i.select();document.execCommand('copy')">${escapeHTML(
    t('common.copy'),
  )}</button></div>
  <p class="sub" style="margin:.75rem 0 0">${escapeHTML(t('bindings.shareNoPassword'))}</p>
</section>`
    : ''

  return `<!doctype html><html lang="${lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(t('bindings.title'))} · ${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="wrap">
${adminNav(cfg, t, lang, actor, actorMethod, csrf, 'bindings')}

${banner(t, 'ok', ok)}${banner(t, 'err', err)}
${shareBox}

<section>
  <h2>${escapeHTML(t('bindings.defaultDir'))}</h2>
  <form class="newuser" method="post" action="/admin/bindings">
    <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
    <div class="f"><label for="dd">${escapeHTML(t('bindings.dirLabel'))}</label><input id="dd" name="default_dir" value="${escapeHTML(
      draft,
    )}" list="dir-options" placeholder="${escapeHTML(
      def.origin === 'cli' ? def.root : t('bindings.defaultPlaceholder'),
    )}" autocomplete="off" required></div>
    ${browseButton(t, 'dd')}
    <button name="action" value="save-default" type="submit">${escapeHTML(t('common.save'))}</button>
    ${
      def.saved
        ? `<button class="ghost" name="action" value="clear-default" type="submit" onclick="return confirm(${JSON.stringify(
            t('bindings.clearConfirm'),
          )})">${escapeHTML(t('bindings.clear'))}</button>`
        : ''
    }
  </form>
  <p class="sub" style="margin:.9rem 0 0">${escapeHTML(t('bindings.currentLabel'))}${current}</p>
</section>

<section>
  <h2>${escapeHTML(t('bindings.subpaths'))}</h2>
  <form class="newuser" method="post" action="/admin/bindings">
    <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
    <input type="hidden" name="action" value="add-binding">
    <div class="f"><label for="bp">${escapeHTML(t('bindings.path'))}</label><input id="bp" name="bind_path" placeholder="/abc" autocomplete="off" required></div>
    <div class="f"><label for="bd">${escapeHTML(t('bindings.dir'))}</label><input id="bd" name="bind_dir" list="dir-options" placeholder="${escapeHTML(
      t('bindings.dirPlaceholder'),
    )}" autocomplete="off" required></div>
    ${browseButton(t, 'bd')}
    <label class="check"><input type="checkbox" name="auto_auth" value="1" checked> ${escapeHTML(t('bindings.autoAuth'))}</label>
    <button type="submit">${escapeHTML(t('bindings.bind'))}</button>
  </form>
  <p class="sub" style="margin:.75rem 0 0">${escapeHTML(t('bindings.addHint'))}</p>
  <table style="margin-top:1.2rem">
    <thead><tr><th>${escapeHTML(t('bindings.path'))}</th><th>${escapeHTML(t('bindings.dir'))}</th><th>${escapeHTML(
      t('bindings.auth'),
    )}</th><th>${escapeHTML(t('bindings.expiry'))}</th><th>${escapeHTML(t('bindings.endTime'))}</th><th></th></tr></thead>
    <tbody>${bindingRows(t, bindings, csrf, origin)}</tbody>
  </table>
</section>

<section>
  <h2>${escapeHTML(t('bindings.shareTitle'))}</h2>
  <p class="sub" style="margin:0 0 .6rem">${escapeHTML(t('bindings.notes.1'))}</p>
  <p class="sub" style="margin:0 0 .6rem">${escapeHTML(t('bindings.notes.2'))}</p>
  <p class="sub" style="margin:0 0 .6rem">${escapeHTML(t('bindings.notes.3'))}</p>
  <p class="sub" style="margin:0">${persistent}</p>
</section>

${dirModal(t)}
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
    btn.textContent = ok ? ${JSON.stringify(t('common.copied'))} : ${JSON.stringify(t('common.copyFailed'))}
    setTimeout(() => { btn.textContent = old }, 1200)
  })
})()
</script>
</body></html>`
}

/** 后台顶部：标题 + 两个 tab + 语言切换。 */
function adminNav(cfg, t, lang, actor, actorMethod, csrf, active) {
  const localNote = actorMethod === 'local' ? ` · <span class="tag">${escapeHTML(t('common.localSession'))}</span>` : ''
  const fileUrl = cfg.mount === '/' ? '/' : `${cfg.mount || '/'}/`
  const tab = (id, href, label) =>
    `<a class="tab${id === active ? ' on' : ''}" href="${href}">${escapeHTML(label)}</a>`
  const action = active === 'bindings' ? '/admin/bindings' : '/admin'
  return `<div class="top">
  <div>
    <h1>${escapeHTML(active === 'bindings' ? t('bindings.title') : t('admin.title'))}</h1>
    <div class="who">${t('admin.who', {
      realm: escapeHTML(cfg.realm),
      actor: `<b>${escapeHTML(actor)}</b>`,
    })}${localNote}</div>
  </div>
  <div>
    <a href="${escapeHTML(fileUrl)}">${escapeHTML(t('nav.files'))}</a>
    &nbsp;·&nbsp;<a href="/whoami">${escapeHTML(t('nav.status'))}</a>
    &nbsp;·&nbsp;<a href="/logout">${escapeHTML(t('nav.logout'))}</a>
    &nbsp;·&nbsp;${langSwitch(t, csrf, lang, action)}
  </div>
</div>
<div class="tabs">${tab('users', '/admin', t('nav.accounts'))}${tab('bindings', '/admin/bindings', t('nav.bindings'))}</div>`
}

/**
 * 管理后台（账号页）。
 */
export function adminPage(
  cfg,
  store,
  { actor, csrf, ok, err, policy, lockedCount = 0, locks = [], actorMethod, t, lang },
) {
  const users = store.list()
  const rows = users.map((u) => row(t, u, store, actor, csrf)).join('\n')
  const storage = store.file ? `<code>${escapeHTML(store.file)}</code>` : escapeHTML(t('admin.storageMemory'))
  const sourceNote =
    policy.source === 'cli'
      ? `<div class="info">${escapeHTML(t('admin.sourceCli'))}</div>`
      : policy.source === 'default'
        ? `<div class="info">${escapeHTML(t('admin.sourceDefault'))}</div>`
        : ''
  const ipNote =
    policy.ipMaxAttempts > 0
      ? t('admin.ipLocked', { n: policy.ipMaxAttempts })
      : t('admin.ipLockOff')

  return `<!doctype html><html lang="${lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(t('admin.title'))} · ${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="wrap">
${adminNav(cfg, t, lang, actor, actorMethod, csrf, 'users')}

${banner(t, 'ok', ok)}${banner(t, 'err', err)}

<section>
  <h2>${escapeHTML(t('admin.addUser'))}</h2>
  <form class="newuser" method="post" action="/admin/users">
    <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
    <input type="hidden" name="action" value="create">
    <div class="f"><label for="nu">${escapeHTML(t('admin.username'))}</label><input id="nu" name="username" placeholder="alice" autocomplete="off" required></div>
    <div class="f"><label for="np">${escapeHTML(t('admin.password'))}</label><input id="np" name="password" type="password" placeholder="${escapeHTML(
      t('admin.passwordHint', { min: MIN_PASSWORD }),
    )}" autocomplete="new-password" required></div>
    <div class="f"><label for="nr">${escapeHTML(t('admin.role'))}</label><select id="nr" name="role"><option value="member">${escapeHTML(
      t('admin.roleMemberOption'),
    )}</option><option value="admin">${escapeHTML(t('admin.roleAdminOption'))}</option></select></div>
    <button type="submit">${escapeHTML(t('admin.create'))}</button>
  </form>
</section>

<section>
  <h2>${escapeHTML(t('admin.protection'))}</h2>
  <form class="newuser" method="post" action="/admin/users">
    <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
    <input type="hidden" name="action" value="save-settings">
    <div class="f"><label for="ama">${escapeHTML(t('admin.accountMax'))}</label><input id="ama" name="account_max_attempts" type="number" min="0" max="100" value="${policy.accountMaxAttempts}" required></div>
    <div class="f"><label for="ima">${escapeHTML(t('admin.ipMax'))}</label><input id="ima" name="ip_max_attempts" type="number" min="0" max="100" value="${policy.ipMaxAttempts}" required></div>
    <div class="f"><label for="lm">${escapeHTML(t('admin.lockout'))}</label><input id="lm" name="lockout_minutes" type="number" min="0" max="10080" value="${policy.lockoutMinutes}" required></div>
    <button type="submit">${escapeHTML(t('common.save'))}</button>
  </form>
  <p class="sub" style="margin:1rem 0 0">${escapeHTML(
    t('admin.policy', {
      attempts: policy.accountMaxAttempts,
      minutes: policy.lockoutMinutes,
      ip: ipNote,
    }),
  )}</p>
  <p class="sub" style="margin:.5rem 0 0">${escapeHTML(t('admin.lockShared', { count: lockedCount }))}</p>
  ${
    lockedCount > 0
      ? `<form method="post" action="/admin/users" style="margin-top:1rem"><input type="hidden" name="csrf" value="${escapeHTML(
          csrf,
        )}"><input type="hidden" name="action" value="unlock"><button class="danger" type="submit">${escapeHTML(
          t('admin.unlockAll', { count: lockedCount }),
        )}</button></form>`
      : ''
  }
  ${sourceNote}
  <p class="sub" style="margin:.75rem 0 0">${escapeHTML(t('admin.trustedNote'))}</p>
</section>

${lockedRows(t, locks, csrf, policy)}

<section>
  <h2>${escapeHTML(t('admin.usersTitle', { count: users.length }))}</h2>
  <table>
    <thead><tr><th>${escapeHTML(t('admin.thUser'))}</th><th>${escapeHTML(t('admin.thRole'))}</th><th>${escapeHTML(
      t('admin.thState'),
    )}</th><th>${escapeHTML(t('admin.thCreated'))}</th><th>${escapeHTML(
      t('admin.thLastLogin'),
    )}</th><th></th></tr></thead>
    <tbody>
${rows || `<tr><td colspan="6">${escapeHTML(t('admin.noUsers'))}</td></tr>`}
    </tbody>
  </table>
</section>

<section>
  <h2>${escapeHTML(t('nav.status'))}</h2>
  <p class="sub" style="margin:0">${t('admin.storage', { storage })}</p>
</section>
</body></html>`
}

/** 非管理员访问后台。 */
export function adminForbiddenPage(cfg, t, actor) {
  return `<!doctype html><html lang="${t('common.admin') === 'admin' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(t('forbidden.title'))}</title>${AUTH_STYLE}</head>
<body class="center"><div class="card">
<h1>${escapeHTML(t('forbidden.title'))}</h1>
<p class="sub">${escapeHTML(t('forbidden.sub', { actor }))}</p>
<p><a href="/">${escapeHTML(t('forbidden.home'))}</a> · <a href="/logout">${escapeHTML(t('nav.logout'))}</a></p>
</div></body></html>`
}

/** 未启用认证时（没配密码）访问后台。 */
export function adminDisabledPage(cfg, t) {
  return `<!doctype html><html lang="${t('common.admin') === 'admin' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(t('disabled.title'))}</title>${AUTH_STYLE}</head>
<body class="center"><div class="card">
<h1>${escapeHTML(t('disabled.title'))}</h1>
<p class="sub">${escapeHTML(t('disabled.sub'))}</p>
<div class="info">${escapeHTML(t('disabled.hint'))}<br><code>--user admin --pass &lt;your password&gt;</code></div>
<p><a href="/">${escapeHTML(t('disabled.back'))}</a></p>
</div></body></html>`
}

// 供 server.js 复用时间格式
export { fmtTime }
