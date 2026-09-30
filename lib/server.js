import { randomBytes } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import { createAccountStore, validPassword, validUsername } from './accounts.js'
import { adminDisabledPage, adminForbiddenPage, adminPage } from './admin.js'
import { basicAuthCredentials, checkCredentials, verifyUserPass } from './auth.js'
import { clientIP, isTrusted, matchPrefix } from './ip.js'
import {
  accountKey,
  createLoginThrottle,
  createSessionStore,
  credentialFingerprint,
  parseCookies,
  safeNext,
} from './session.js'
import { serveStatic } from './static.js'
import { AUTH_STYLE, escapeHTML } from './ui.js'

export { MIME } from './static.js'

const DAY_MS = 24 * 3600 * 1000

/** 配置里有没有启用认证：账号文件里有账号、命令行给了密码，或显式要求认证。 */
export function isAuthEnabled(cfg) {
  if (cfg.forceAnonymous) return false
  if (typeof cfg.authEnabled === 'boolean') return cfg.authEnabled
  return Boolean(cfg.authRequired) || Boolean(cfg.passHash) || (cfg.userCount ?? 0) > 0
}

/** 把账号存储的状态写回配置，供 explainAccess / 启动日志使用。 */
export function withAuthState(cfg, store) {
  return {
    ...cfg,
    authEnabled:
      !cfg.forceAnonymous &&
      (Boolean(cfg.authRequired) || Boolean(cfg.passHash) || (store?.count ?? 0) > 0),
    userCount: store?.count ?? 0,
  }
}

/** 启用了认证但一个账号都还没有 → 需要首次创建管理员。 */
export function needsSetup(cfg, store) {
  return isAuthEnabled(cfg) && (store?.count ?? 0) === 0
}

function pathnameOf(req) {
  const raw = req.url || '/'
  const q = raw.indexOf('?')
  const p = q === -1 ? raw : raw.slice(0, q)
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

function html(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// 访问判定
// ---------------------------------------------------------------------------

/**
 * 纯函数版判定：给定来源 IP 与路径，说明此处会怎么处理（不涉及真实请求）。
 *
 * 判定顺序：公共路径 → 未启用认证（全放行）→ 免认证网段 → 需要登录。
 *
 * @returns {{method: 'public'|'anonymous'|'intranet-bypass'|'password',
 *            allowed: boolean, requiresPassword: boolean,
 *            matched: object|null, reason: string}}
 */
export function explainAccess(ip, path, cfg) {
  if (cfg.publicPaths.includes(path)) {
    return {
      method: 'public',
      allowed: true,
      requiresPassword: false,
      matched: null,
      reason: `公共路径 ${path}`,
    }
  }
  if (!isAuthEnabled(cfg)) {
    return {
      method: 'anonymous',
      allowed: true,
      requiresPassword: false,
      matched: null,
      reason: '未启用认证（没有账号也没有密码）',
    }
  }
  const matched = ip ? matchPrefix(ip, cfg.trusted) : null
  if (matched) {
    return {
      method: 'intranet-bypass',
      allowed: true,
      requiresPassword: false,
      matched,
      reason: `命中免认证网段 ${matched.text}`,
    }
  }
  return {
    method: 'password',
    allowed: false,
    requiresPassword: true,
    matched: null,
    reason: `不在 ${cfg.trusted.length} 条免认证网段内，需要登录`,
  }
}

/** 从 Cookie 会话里认出用户。 */
function userFromSession(req, cfg, { session, store }) {
  if (!session || cfg.auth !== 'form') return null
  const token = parseCookies(req.headers?.cookie)[session.cookieName]
  if (!token) return null
  const payload = session.verify(token)
  if (!payload) return null
  if (store && store.count > 0) {
    const record = store.get(payload.username)
    if (!record || record.disabled) return null
    return { username: record.username, role: record.role, method: 'session' }
  }
  if (payload.username !== cfg.username) return null
  return { username: cfg.username, role: 'admin', method: 'session' }
}

/** 从 Basic 头里认出用户（脚本 / curl 用）。 */
function userFromBasic(req, cfg, { store }) {
  const creds = basicAuthCredentials(req)
  if (!creds) return null
  if (store && store.count > 0) {
    if (!store.verify(creds.username, creds.password)) return null
    const record = store.get(creds.username)
    return { username: record.username, role: record.role, method: 'password' }
  }
  if (!verifyUserPass(creds.username, creds.password, cfg)) return null
  return { username: cfg.username, role: 'admin', method: 'password' }
}

/** 当前请求的登录用户，未登录返回 null。被锁定时（skipCredentials）不做任何校验。 */
export function authenticatedUser(req, cfg, state = {}) {
  if (state.skipCredentials) return null
  return userFromSession(req, cfg, state) || userFromBasic(req, cfg, state)
}

/** 这个请求带了什么凭据（Basic）；没带返回 null。 */
function credentialsOf(req, state = {}) {
  const { store } = state
  const creds = basicAuthCredentials(req)
  if (!creds) return null
  const usingStore = Boolean(store && store.count > 0)
  return {
    username: creds.username,
    // 用户名是否存在：不存在也照样计数（防用户名喷洒），但不记账号维度的锁
    exists: usingStore ? Boolean(store.get(creds.username)) : creds.username === 'admin',
    // 凭据指纹：同一个错误密码重复提交只算一次
    fingerprint: credentialFingerprint('basic', creds.username, creds.password),
  }
}

/**
 * 单次请求的访问判定。
 * @returns {{allowed: boolean, method: 'public'|'anonymous'|'intranet-bypass'|'password'|'session'|'none',
 *            ip: string|null, peer: string|null, viaProxy: boolean,
 *            requiresPassword: boolean, matched: object|null,
 *            user: {username: string, role: string}|null}}
 */
export function evaluateAccess(req, cfg, state = {}) {
  const { ip, peer, viaProxy } = clientIP(req, cfg)
  const path = pathnameOf(req)
  const decision = explainAccess(ip, path, cfg)
  const user = authenticatedUser(req, cfg, state)

  if (decision.allowed) {
    return { ...decision, ip, peer, viaProxy, user }
  }
  if (user) {
    return { ...decision, allowed: true, method: user.method, ip, peer, viaProxy, user }
  }
  return { ...decision, method: 'none', allowed: false, ip, peer, viaProxy, user: null }
}

// ---------------------------------------------------------------------------
// 登录页 / 退出
// ---------------------------------------------------------------------------

/**
 * 登录保护策略：命令行显式指定 > 管理后台保存的 > 默认值。
 *
 * 默认只按账号锁（3 次 / 1 小时），来源 IP 维度默认关闭 —— 在隧道、反向代理、
 * 公司出口后面所有人共用一个 IP，按 IP 锁会误伤一整片人。
 */
export function resolvePolicy(cfg, store) {
  const saved = store?.settings || {}
  const cliGiven =
    cfg.accountMaxAttemptsExplicit || cfg.ipMaxAttemptsExplicit || cfg.lockoutMinutesExplicit
  const adminGiven =
    saved.accountMaxAttempts !== undefined ||
    saved.ipMaxAttempts !== undefined ||
    saved.lockoutMinutes !== undefined
  const pick = (explicit, fromCli, key, fallback) =>
    explicit ? fromCli : (saved[key] ?? fromCli ?? fallback)
  return {
    accountMaxAttempts: pick(cfg.accountMaxAttemptsExplicit, cfg.accountMaxAttempts, 'accountMaxAttempts', 3),
    ipMaxAttempts: pick(cfg.ipMaxAttemptsExplicit, cfg.ipMaxAttempts, 'ipMaxAttempts', 0),
    lockoutMinutes: pick(cfg.lockoutMinutesExplicit, cfg.lockoutMinutes, 'lockoutMinutes', 60),
    source: cliGiven ? 'cli' : adminGiven ? 'admin' : 'default',
  }
}

/** 统一格式的警告日志（锁定、探测等）。 */
function warnLog(state, ip, message) {
  state.logger?.({ time: new Date().toISOString(), level: 'warn', ip, message })
}

function wantsHTML(req) {
  return String(req.headers?.accept || '').includes('text/html')
}

/** 请求是否走 HTTPS（直连对端可信时才采信 X-Forwarded-Proto）。 */
function isSecureRequest(req, cfg) {
  if (cfg.secureCookie) return true
  const proto = req.headers?.['x-forwarded-proto']
  if (!proto) return false
  const { peer } = clientIP(req, cfg)
  return String(proto).split(',')[0].trim() === 'https' && Boolean(peer) && isTrusted(peer, cfg.trusted)
}

function queryParam(req, name) {
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams.get(name)
  } catch {
    return null
  }
}

function redirect(res, location, extraHeaders = {}, status = 302) {
  res.writeHead(status, { location, 'content-type': 'text/plain; charset=utf-8', ...extraHeaders })
  res.end(`${status} → ${location}\n`)
}

/** CSRF 种子：优先会话 Cookie，其次 Basic 头。 */
function csrfSeed(req, session) {
  const token = session ? parseCookies(req.headers?.cookie)[session.cookieName] : null
  return token || req.headers?.authorization || ''
}

function loginPage(cfg, { error = '', next = '/', notice = '' } = {}) {
  const remember =
    cfg.rememberDays > 0
      ? `<label class="check"><input type="checkbox" name="remember" value="1" checked> 记住我，${cfg.rememberDays} 天内不用重新登录</label>`
      : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · ${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}
<style>
label.check{display:flex;gap:.5rem;align-items:flex-start;margin:1.1rem 0 0;font-size:.85rem;color:#555}
label.check input{width:auto;margin:.2rem 0 0}
</style></head>
<body class="center">
<form class="card" method="post" action="/login">
  <h1>${escapeHTML(cfg.realm)}</h1>
  <p class="sub">请输入用户名和密码</p>
  ${error ? `<div class="err">${escapeHTML(error)}</div>` : ''}
  ${notice ? `<div class="info">${escapeHTML(notice)}</div>` : ''}
  <label for="username">用户名</label>
  <input id="username" name="username" autocomplete="username" autofocus required>
  <label for="password">密码</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  ${remember}
  <input type="hidden" name="next" value="${escapeHTML(next)}">
  <button class="primary" type="submit">登录</button>
  <div class="foot">oh-my-http · 默认可保持登录 ${cfg.sessionDays} 天</div>
</form>
</body></html>`
}

/** 首次创建管理员页面（--require-auth 且还没有任何账号时）。 */
function setupPage(cfg, { error = '', next = '/', tokenRequired = false, username = 'admin' } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>初始化 · ${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="center">
<form class="card" method="post" action="/login">
  <h1>创建管理员</h1>
  <p class="sub">还没有任何账号，先创建一个管理员。这个账号可以进 /admin 继续加人。</p>
  ${error ? `<div class="err">${escapeHTML(error)}</div>` : ''}
  <label for="username">管理员用户名</label>
  <input id="username" name="username" value="${escapeHTML(username)}" autocomplete="username" autofocus required>
  <label for="password">密码（至少 6 位）</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required>
  <label for="confirm">再输一次</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" required>
  ${
    tokenRequired
      ? `<label for="token">初始化口令</label>
  <input id="token" name="token" placeholder="见启动日志 / oh-my-http status" autocomplete="off" required>
  <div class="info">你不是从内网访问的，为防止别人抢先创建管理员，需要填启动时打印的初始化口令。</div>`
      : ''
  }
  <input type="hidden" name="next" value="${escapeHTML(next)}">
  <button class="primary" type="submit">创建并登录</button>
  <div class="foot">oh-my-http · 创建后这个页面就不再出现</div>
</form>
</body></html>`
}

function sendSetupPage(res, cfg, options, status = 200, extraHeaders = {}) {
  return html(res, status, setupPage(cfg, options), { 'cache-control': 'no-store', ...extraHeaders })
}

/** 首次创建管理员：建号 + 直接登录。 */
async function handleSetup(req, res, cfg, state, access) {
  const next = safeNext(queryParam(req, 'next'))
  const secure = isSecureRequest(req, cfg)
  // 非内网来源要带初始化口令，防止公网上有人抢注
  const tokenRequired = !access.ip || !isTrusted(access.ip, cfg.trusted)

  if (req.method === 'GET' || req.method === 'HEAD') {
    return sendSetupPage(res, cfg, { next, tokenRequired, username: cfg.username || 'admin' })
  }
  if (req.method !== 'POST') {
    return text(res, 405, '405 method not allowed\n', { allow: 'GET, POST' })
  }

  // 用账号维度的 key，这样猜初始化口令也会被限速（默认 3 次）
  const key = accountKey(`setup:${access.ip || 'unknown'}`)
  const gate = state.throttle.check(key)
  if (!gate.allowed) {
    const mins = Math.max(1, Math.ceil(gate.retryAfter / 60))
    return sendSetupPage(res, cfg, { next, tokenRequired, error: `尝试过多，请 ${mins} 分钟后再试` }, 429, {
      'retry-after': String(gate.retryAfter),
    })
  }

  let form
  try {
    form = parseForm(await readBody(req, 4096))
  } catch {
    return sendSetupPage(res, cfg, { next, tokenRequired, error: '请求体过大或无法解析' }, 400)
  }

  if (tokenRequired) {
    const given = String(form.token || '').trim()
    const expected = String(state.setupToken || '')
    if (!expected || credentialFingerprint('token', given) !== credentialFingerprint('token', expected)) {
      const hit = state.throttle.fail(key, Date.now(), credentialFingerprint('token', given))
      if (hit.locked) {
        warnLog(
          state,
          access.ip,
          `初始化口令连错 ${hit.limit} 次，已锁定 ${Math.round(state.policy.lockoutMinutes)} 分钟`,
        )
        const mins = Math.max(1, Math.ceil(hit.retryAfter / 60))
        return sendSetupPage(
          res,
          cfg,
          { next, tokenRequired, error: `初始化口令错误次数过多，请 ${mins} 分钟后再试` },
          429,
          { 'retry-after': String(hit.retryAfter) },
        )
      }
      return sendSetupPage(
        res,
        cfg,
        { next, tokenRequired, error: '初始化口令不正确（见启动日志里的「初始化口令」）' },
        401,
      )
    }
  }

  const username = String(form.username || '').trim()
  const password = String(form.password || '')
  const confirm = String(form.confirm || '')
  const again = (error) => sendSetupPage(res, cfg, { next, tokenRequired, username, error }, 400)

  if (!validUsername(username)) return again('用户名只能包含字母、数字、. _ -，长度 1-32')
  if (!validPassword(password)) return again('密码至少 6 位')
  if (password !== confirm) return again('两次输入的密码不一致')

  try {
    await state.store.create({ username, password, role: 'admin' })
  } catch (err) {
    return again(err.message)
  }

  state.throttle.reset(key)
  state.throttle.reset(accountKey(username))
  state.setupToken = null
  const ttl = (cfg.sessionDays || 7) * DAY_MS
  const token = state.session.issue(username, Date.now(), ttl)
  return redirect(res, next, {
    'set-cookie': state.session.cookieHeader(token, { secure, maxAge: Math.floor(ttl / 1000) }),
  }, 303)
}

function sendLoginPage(res, cfg, options, status = 200, extraHeaders = {}) {
  return html(res, status, loginPage(cfg, options), {
    'cache-control': 'no-store',
    ...extraHeaders,
  })
}

/** 被锁定时的页面。 */
function lockedPage(cfg, retryAfter, policy, username) {
  const mins = Math.max(1, Math.ceil(retryAfter / 60))
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>锁定 · ${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="center"><div class="card">
<h1>尝试次数过多</h1>
<p class="sub">这个地址已被暂时锁定，请在 <b>${mins} 分钟</b>后再试。</p>
<div class="info">账号 <b>${escapeHTML(username || '')}</b> 连续输错密码会触发锁定（${policy.accountMaxAttempts} 次锁 ${policy.lockoutMinutes} 分钟）。可在服务器上执行 <code>oh-my-http restart</code> 清空锁定，或让管理员在 /admin 里点“解除锁定”。</div>
</div></body></html>`
}

function parseForm(body) {
  const out = {}
  for (const [k, v] of new URLSearchParams(body)) out[k] = v
  return out
}

async function handleAuthRoute(req, res, cfg, state, access) {
  const { session, store, throttle } = state
  const path = pathnameOf(req)
  const secure = isSecureRequest(req, cfg)

  if (path === '/logout') {
    return redirect(res, '/login', { 'set-cookie': session.clearCookieHeader({ secure }) })
  }

  const next = safeNext(queryParam(req, 'next'))

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (userFromSession(req, cfg, state)) return redirect(res, next)
    return sendLoginPage(res, cfg, { next })
  }
  if (req.method !== 'POST') {
    return text(res, 405, '405 method not allowed\n', { allow: 'GET, POST' })
  }

  const clientKey = access.ip || 'unknown'

  let form
  try {
    form = parseForm(await readBody(req, 4096))
  } catch {
    return sendLoginPage(res, cfg, { next, error: '请求体过大或无法解析' }, 400)
  }

  const username = String(form.username || '')
  const password = String(form.password || '')

  // 锁定判定：账号维度 + （默认关闭的）IP 维度
  const ipGate = throttle.check(clientKey)
  const acctGate = throttle.check(accountKey(username))
  if (!ipGate.allowed || !acctGate.allowed) {
    const retryAfter = Math.max(ipGate.retryAfter, acctGate.retryAfter)
    const mins = Math.max(1, Math.ceil(retryAfter / 60))
    return sendLoginPage(
      res,
      cfg,
      { next, error: `失败次数过多，已锁定，请在 ${mins} 分钟后再试` },
      429,
      { 'retry-after': String(retryAfter) },
    )
  }

  const ok = store && store.count > 0 ? store.verify(username, password, true) : verifyUserPass(username, password, cfg)
  if (ok) {
    throttle.reset(clientKey)
    throttle.reset(accountKey(username))
    const record = store?.count > 0 ? store.get(username) : { username: cfg.username, role: 'admin' }
    const remember = cfg.rememberDays > 0 && String(form.remember || '') !== ''
    const days = remember ? cfg.rememberDays : cfg.sessionDays
    const ttl = days * DAY_MS
    const token = session.issue(record.username, Date.now(), ttl)
    return redirect(res, safeNext(form.next, next), {
      'set-cookie': session.cookieHeader(token, { secure, maxAge: Math.floor(ttl / 1000) }),
    }, 303)
  }

  // 密码错误：两个维度各记一次（同一个错误密码重复提交只算一次）
  const now = Date.now()
  const fingerprint = credentialFingerprint('form', username, password)
  const ipFail = throttle.fail(clientKey, now, fingerprint)
  const acctFail = throttle.fail(accountKey(username), now, fingerprint)
  if (ipFail.locked || acctFail.locked) {
    warnLog(state, clientKey, `登录失败次数过多（账号 ${username}），已锁定 ${state.policy.lockoutMinutes} 分钟`)
    return sendLoginPage(
      res,
      cfg,
      { next, error: `失败次数过多，已锁定 ${state.policy.lockoutMinutes} 分钟` },
      429,
      { 'retry-after': String(Math.max(ipFail.retryAfter, acctFail.retryAfter)) },
    )
  }

  const left = Math.min(ipFail.remaining, acctFail.remaining)
  return sendLoginPage(
    res,
    cfg,
    {
      next,
      error: `用户名或密码不正确${left <= 2 ? `（还剩 ${left} 次机会，超过会锁定 ${state.policy.lockoutMinutes} 分钟）` : ''}`,
    },
    401,
  )
}

// ---------------------------------------------------------------------------
// 管理后台
// ---------------------------------------------------------------------------

const ADMIN_ACTIONS = new Set([
  'create',
  'delete',
  'set-password',
  'set-admin',
  'set-member',
  'disable',
  'enable',
  'save-settings',
  'unlock',
  'unlock-key',
])

async function handleAdmin(req, res, cfg, state) {
  const { store, session } = state
  if (!isAuthEnabled(cfg)) return html(res, 200, adminDisabledPage(cfg))
  if (!store) return html(res, 200, adminDisabledPage(cfg))

  const user = authenticatedUser(req, cfg, state)
  if (!user) {
    if (session && wantsHTML(req)) return redirect(res, `/login?next=${encodeURIComponent(safeNext(req.url))}`)
    return text(res, 401, '401 unauthorized\n')
  }
  if (user.role !== 'admin') {
    return html(res, 403, adminForbiddenPage(cfg, user.username))
  }

  const seed = csrfSeed(req, session)
  const csrf = session ? session.csrf(seed) : ''

  if (req.method === 'GET' || req.method === 'HEAD') {
    return html(res, 200, adminPage(cfg, store, {
      actor: user.username,
      csrf,
      ok: queryParam(req, 'ok'),
      err: queryParam(req, 'err'),
      policy: state.policy,
      lockedCount: state.throttle.lockedCount(),
      locks: state.throttle.snapshot(),
    }), { 'cache-control': 'no-store' })
  }
  if (req.method !== 'POST') {
    return text(res, 405, '405 method not allowed\n', { allow: 'GET, POST' })
  }

  let form
  try {
    form = parseForm(await readBody(req, 8192))
  } catch {
    return redirect(res, '/admin?err=bad_request', {}, 303)
  }

  if (!session || !session.checkCsrf(seed, String(form.csrf || ''))) {
    return redirect(res, '/admin?err=csrf', {}, 303)
  }
  const action = String(form.action || '')
  const target = String(form.target || '')
  if (!ADMIN_ACTIONS.has(action)) return redirect(res, '/admin?err=bad_request', {}, 303)

  try {
    switch (action) {
      case 'create':
        await store.create({
          username: String(form.username || '').trim(),
          password: String(form.password || ''),
          role: String(form.role || 'member'),
        })
        return redirect(res, '/admin?ok=created', {}, 303)
      case 'delete':
        if (target === user.username) return redirect(res, '/admin?err=self_delete', {}, 303)
        await store.remove(target)
        state.throttle.unlock(accountKey(target)) // 账号都没了，锁定也没意义
        return redirect(res, '/admin?ok=deleted', {}, 303)
      case 'set-password':
        await store.setPassword(target, String(form.password || ''))
        // 密码换了，针对旧密码的失败记录/锁定自动失效
        state.throttle.unlock(accountKey(target))
        return redirect(res, '/admin?ok=password', {}, 303)
      case 'set-admin':
        await store.setRole(target, 'admin')
        return redirect(res, '/admin?ok=role', {}, 303)
      case 'set-member':
        await store.setRole(target, 'member')
        return redirect(res, '/admin?ok=role', {}, 303)
      case 'disable':
        await store.setDisabled(target, true)
        return redirect(res, '/admin?ok=disabled', {}, 303)
      case 'enable':
        await store.setDisabled(target, false)
        return redirect(res, '/admin?ok=enabled', {}, 303)
      case 'save-settings': {
        const saved = await store.saveSettings({
          accountMaxAttempts: form.account_max_attempts,
          ipMaxAttempts: form.ip_max_attempts,
          lockoutMinutes: form.lockout_minutes,
        })
        // 立即生效：同步限流器策略（会清空已有锁定）
        state.policy = {
          accountMaxAttempts: saved.accountMaxAttempts ?? state.policy.accountMaxAttempts,
          ipMaxAttempts: saved.ipMaxAttempts ?? state.policy.ipMaxAttempts,
          lockoutMinutes: saved.lockoutMinutes ?? state.policy.lockoutMinutes,
          source: 'admin',
        }
        state.throttle.setPolicy({
          accountMaxAttempts: state.policy.accountMaxAttempts,
          ipMaxAttempts: state.policy.ipMaxAttempts,
          lockoutMinutes: state.policy.lockoutMinutes,
        })
        return redirect(res, '/admin?ok=settings', {}, 303)
      }
      case 'unlock':
        state.throttle.clear()
        return redirect(res, '/admin?ok=unlocked', {}, 303)
      case 'unlock-key': {
        const key = String(form.key || '')
        if (!key) return redirect(res, '/admin?err=bad_request', {}, 303)
        const ok = state.throttle.unlock(key)
        return redirect(res, ok ? '/admin?ok=unlocked_one' : '/admin?err=not_locked', {}, 303)
      }
      default:
        return redirect(res, '/admin?err=bad_request', {}, 303)
    }
  } catch (err) {
    return redirect(res, `/admin?err=${encodeURIComponent(mapAdminError(err.message))}`, {}, 303)
  }
}

function mapAdminError(message) {
  if (/已存在/.test(message)) return 'exists'
  if (/用户名只能/.test(message)) return 'invalid_user'
  if (/密码至少/.test(message)) return 'invalid_password'
  if (/角色只能是/.test(message)) return 'invalid_role'
  if (/至少要保留/.test(message)) return 'last_admin'
  if (/不存在/.test(message)) return 'notfound'
  if (/连续失败次数|失败次数应为|锁定时长/.test(message)) return 'invalid_settings'
  return 'bad_request'
}

// ---------------------------------------------------------------------------
// 其它页面
// ---------------------------------------------------------------------------

function indexPage(cfg, access) {
  const mount = cfg.root ? (cfg.mount === '/' ? '/' : `${cfg.mount}/`) : null
  const files = mount
    ? `\n<li><code>GET ${mount}</code> — 浏览/下载绑定目录 <code>${escapeHTML(cfg.root)}</code></li>`
    : ''
  const admin =
    isAuthEnabled(cfg) && access.user?.role === 'admin'
      ? '\n<li><a href="/admin">账号管理</a> — 添加/删除账号、重置密码</li>'
      : ''
  const who = access.user ? `已登录为 <b>${escapeHTML(access.user.username)}</b>（${access.user.role === 'admin' ? '管理员' : '成员'}）` : `认证方式：<b>${escapeHTML(access.method)}</b>`
  const warn = !isAuthEnabled(cfg)
    ? '\n<p style="color:#c00"><b>注意：未启用认证</b>，任何能访问到该端口的人都可以浏览这些文件。用 <code>--user admin --pass &lt;密码&gt;</code> 开启。</p>'
    : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="wrap">
<h1>${escapeHTML(cfg.realm)}</h1>
<p>你的地址 <code>${escapeHTML(access.ip || 'unknown')}</code>，${who}。</p>${warn}
<ul>
<li><code>GET /healthz</code> — 公共健康检查</li>
<li><code>GET /whoami</code> — 查看来源 IP 与认证状态</li>
<li><code>POST /api/echo</code> — 回显请求</li>${files}${admin}
</ul>
${isAuthEnabled(cfg) && cfg.auth === 'form' ? '<p><a href="/logout">退出登录</a></p>' : ''}
</body></html>`
}

// ---------------------------------------------------------------------------
// 请求处理
// ---------------------------------------------------------------------------

/**
 * 构造符合 http.createServer 签名的请求处理函数。
 * @param {object} cfg loadConfig() 的结果（建议先过 withAuthState）
 * @param {{logger?: Function, store?: object}} [options]
 */
export function createHandler(cfg, { logger, store, policy, setupToken } = {}) {
  const serverStartedAt = Date.now()
  const useSession = cfg.auth === 'form' && isAuthEnabled(cfg)
  const session = useSession
    ? createSessionStore({
        secret: store?.sessionSecret,
        ttlMs: (cfg.sessionDays || 7) * DAY_MS,
      })
    : null
  const state = {
    session,
    store,
    logger,
    policy: policy || resolvePolicy(cfg, store),
    // 还没有账号时的初始化口令（公网来源创建管理员必须填）
    setupToken: setupToken ?? (store && store.count === 0 ? randomBytes(4).toString('hex') : null),
    throttle: null,
  }
  state.throttle = createLoginThrottle({
    accountMaxAttempts: state.policy.accountMaxAttempts,
    ipMaxAttempts: state.policy.ipMaxAttempts,
    lockMs: state.policy.lockoutMinutes * 60_000,
  })

  return async function handler(req, res) {
    const { ip } = clientIP(req, cfg)
    const clientKey = ip || 'unknown'

    // 已有会话的直接认；锁定只拦“认证尝试”，不拦已经登录的会话
    // （否则一遍输错密码会把同一出口下的已登录管理员也踢出去，连解锁都做不了）
    const sessionUser = userFromSession(req, cfg, state)
    const creds = sessionUser ? null : credentialsOf(req, state)

    const ipGate = state.throttle.check(clientKey)
    const acctGate = creds
      ? state.throttle.check(accountKey(creds.username))
      : { allowed: true, retryAfter: 0, remaining: 3 }
    const locked = !sessionUser && (!ipGate.allowed || !acctGate.allowed)
    const retryAfter = Math.max(ipGate.retryAfter, acctGate.retryAfter)

    const access = evaluateAccess(req, cfg, { ...state, skipCredentials: locked })
    const path = pathnameOf(req)
    const startedAt = process.hrtime.bigint()

    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')

    if (logger) {
      res.on('finish', () => {
        logger({
          time: new Date().toISOString(),
          ip: access.ip || 'unknown',
          peer: access.peer || null,
          viaProxy: access.viaProxy,
          method: access.method,
          user: access.user?.username || null,
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
          requestMethod: req.method,
          path,
        })
      })
    }

    if (!access.allowed) {
      // 已锁定：连密码都不看，直接 429
      if (locked) {
        const mins = Math.max(1, Math.ceil(retryAfter / 60))
        warnLog(state, clientKey, `已锁定，拒绝 ${req.method} ${path}（还剩约 ${mins} 分钟）`)
        if (wantsHTML(req)) {
          return html(res, 429, lockedPage(cfg, retryAfter, state.policy, creds?.username), {
            'retry-after': String(retryAfter),
            'cache-control': 'no-store',
          })
        }
        return text(res, 429, `429 too many failed attempts; retry in ${mins} min\n`, {
          'retry-after': String(retryAfter),
        })
      }

      // 带了 Basic 凭据但没通过：计入失败（curl 猜密码也逃不掉）
      if (creds) {
        const now = Date.now()
        const ipFail = state.throttle.fail(clientKey, now, creds.fingerprint)
        const acctFail = creds.exists
          ? state.throttle.fail(accountKey(creds.username), now, creds.fingerprint)
          : { locked: false }
        if (ipFail.locked || acctFail.locked) {
          warnLog(state, clientKey, `登录失败次数过多（Basic 凭据，账号 ${creds.username || '-'}），已锁定 ${state.policy.lockoutMinutes} 分钟`)
        }
      }

      if (session && wantsHTML(req)) {
        return redirect(res, `/login?next=${encodeURIComponent(safeNext(req.url))}`)
      }
      const headers = { 'content-type': 'text/plain; charset=utf-8' }
      if (cfg.auth === 'basic') {
        headers['www-authenticate'] = `Basic realm="${cfg.realm}", charset="UTF-8"`
      }
      const left = Math.min(ipGate.remaining ?? 3, acctGate.remaining ?? 3)
      const hint =
        creds && left <= 2
          ? `（还剩 ${left} 次机会，超过会锁定 ${state.policy.lockoutMinutes} 分钟）`
          : ''
      res.writeHead(401, headers)
      return res.end(`401 unauthorized: 需要有效凭据，或从内网访问${hint}\n`)
    }

    // 凭据登录成功：清掉失败计数
    if (access.user && access.method === 'password') {
      state.throttle.reset(clientKey)
      state.throttle.reset(accountKey(access.user.username))
    }

    try {
      if (session && (path === '/login' || path === '/logout')) {
        // 还没有账号：先引导创建管理员
        if (path === '/login' && state.store && state.store.count === 0) {
          return await handleSetup(req, res, cfg, state, access)
        }
        return await handleAuthRoute(req, res, cfg, state, access)
      }

      if (path === '/admin' || path.startsWith('/admin/')) {
        return await handleAdmin(req, res, cfg, state)
      }

      if (path === '/healthz') return text(res, 200, 'ok\n')

      if (path === '/whoami') {
        return json(res, 200, {
          ip: access.ip,
          peer: access.peer,
          via_proxy: access.viaProxy,
          trusted: Boolean(access.ip) && isTrusted(access.ip, cfg.trusted),
          authenticated: Boolean(access.user),
          authenticated_by: access.method,
          user: access.user?.username || null,
          role: access.user?.role || null,
          auth_enabled: isAuthEnabled(cfg),
          auth_mode: cfg.auth,
          server_time: new Date().toISOString(),
          uptime_seconds: Math.round((Date.now() - serverStartedAt) / 1000),
        })
      }

      if (path === '/api/echo') {
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
        const body = hasBody ? await readBody(req) : ''
        return json(res, 200, {
          method: req.method,
          path,
          query: (req.url || '').split('?')[1] || '',
          headers: req.headers,
          body,
        })
      }

      if (cfg.root) {
        const mount = cfg.mount === '/' ? '' : cfg.mount
        if (path === mount || path.startsWith(`${mount}/`)) {
          return await serveStatic(req, res, cfg, path)
        }
      }

      if (path === '/') {
        return html(res, 200, indexPage(cfg, access))
      }

      return text(res, 404, '404 not found\n')
    } catch (err) {
      logger?.({ level: 'error', path, error: String(err && err.message ? err.message : err) })
      if (!res.headersSent) text(res, 500, '500 internal error\n')
      else res.destroy()
    }
  }
}

/** 创建 http.Server（尚未 listen）。 */
export function createServer(cfg, options = {}) {
  const { store = createAccountStore({ file: cfg.usersFile ?? null, bootstrap: cfg.bootstrap ?? null }), ...rest } = options
  const effective = withAuthState(cfg, store)
  const policy = resolvePolicy(effective, store)
  const setupToken =
    needsSetup(effective, store) && !rest.setupToken ? randomBytes(4).toString('hex') : rest.setupToken
  const server = http.createServer(createHandler(effective, { ...rest, store, policy, setupToken }))
  server.headersTimeout = 10_000
  server.requestTimeout = 60_000
  server.keepAliveTimeout = 120_000
  server.ohmy = { cfg: effective, store, policy, setupToken }
  return server
}

/** listen 的 Promise 包装。 */
export function listen(server, cfg) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    server.once('error', onError)
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', onError)
      resolve(server)
    })
  })
}

/** 本机对外可达的 IPv4 地址，用于启动时提示。 */
export function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}
