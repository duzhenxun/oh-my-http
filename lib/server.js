import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { MIN_PASSWORD, createAccountStore, validPassword, validUsername } from './accounts.js'
import { adminDisabledPage, adminForbiddenPage, adminPage, bindingsPage } from './admin.js'
import { basicAuthCredentials, checkCredentials, verifyUserPass } from './auth.js'
import { createT, pickLang } from './i18n.js'
import { clientIP, isTrusted, matchPrefix } from './ip.js'
import { expandDir, matchBinding, normalizeBinding, normalizeBindings, verifyBindingAuth } from './mounts.js'
import {
  accountKey,
  createLoginThrottle,
  createSessionStore,
  credentialFingerprint,
  parseCookies,
  safeNext,
  serializeCookie,
} from './session.js'
import { serveStatic } from './static.js'
import { checkForUpdate, updateCacheFile } from './update.js'
import { createUpdateState } from './update-state.js'
import { VERSION } from './version.js'
import { sha256 } from './util.js'
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

/**
 * 是不是“纯本机”访问：回环地址，而且**没有经过任何代理**。
 *
 * 这一条很关键：隧道 / 反向代理（比如 cloudflared）也是从 127.0.0.1 转进来的，
 * 只看到端口来源就自动给管理员，等于门户大开。所以带 X-Forwarded-For 的请求一律不算本机。
 *
 * 另外 `--no-default-trusted`（连内网都要登录）也视为“本机要认账”。
 */
export function isLocalRequest(ip, cfg, viaProxy) {
  if (!cfg.localAdmin) return false
  if (viaProxy) return false
  if (!ip) return false
  const loopback = ip === '::1' || ip.startsWith('127.')
  if (!loopback) return false
  return isTrusted('127.0.0.1', cfg.trusted)
}

/** 本机自动登录要用的管理员账号：优先 --local-admin-user，其次任意一个可用管理员。 */
export function localAdminAccount(cfg, store) {
  if (!store || store.count === 0) return null
  const preferred = store.get(cfg.localAdminUser || 'admin')
  if (preferred && !preferred.disabled && preferred.role === 'admin') return preferred
  return store.list().find((u) => u.role === 'admin' && !u.disabled) || null
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
  const known = userFromSession(req, cfg, state) || userFromBasic(req, cfg, state)
  if (known) return known
  // 本机直连：自动以管理员身份进入（不用登录）
  const { ip, viaProxy } = clientIP(req, cfg)
  if (!isLocalRequest(ip, cfg, viaProxy)) return null
  const account = localAdminAccount(cfg, state.store)
  if (account) return { username: account.username, role: account.role, method: 'local' }
  if (!state.store || state.store.count === 0) {
    // 没有账号文件（或一个账号都没有）时退回配置里的用户名
    return { username: cfg.username || 'admin', role: 'admin', method: 'local' }
  }
  return null
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
 *            user: {username: string, role: string, method: string}|null}}
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

function loginPage(cfg, t, { error = '', next = '/', notice = '' } = {}) {
  const remember =
    cfg.rememberDays > 0
      ? `<label class="check"><input type="checkbox" name="remember" value="1" checked> ${escapeHTML(t('login.remember', { days: cfg.rememberDays }))}</label>`
      : ''
  return `<!doctype html><html lang="${t('common.admin') === 'admin' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(t('login.title', { realm: cfg.realm }))}</title>
${AUTH_STYLE}
<style>
label.check{display:flex;gap:.5rem;align-items:flex-start;margin:1.1rem 0 0;font-size:.85rem;color:#555}
label.check input{width:auto;margin:.2rem 0 0}
</style></head>
<body class="center">
<form class="card" method="post" action="/login">
  <h1>${escapeHTML(cfg.realm)}</h1>
  <p class="sub">${escapeHTML(t('login.sub'))}</p>
  ${error ? `<div class="err">${escapeHTML(error)}</div>` : ''}
  ${notice ? `<div class="info">${escapeHTML(notice)}</div>` : ''}
  <label for="username">${escapeHTML(t('login.username'))}</label>
  <input id="username" name="username" autocomplete="username" autofocus required>
  <label for="password">${escapeHTML(t('login.password'))}</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  ${remember}
  <input type="hidden" name="next" value="${escapeHTML(next)}">
  <button class="primary" type="submit">${escapeHTML(t('login.submit'))}</button>
  <div class="foot">${escapeHTML(t('login.foot', { days: cfg.sessionDays }))}</div>
</form>
</body></html>`
}

function setupPage(cfg, t, { error = '', next = '/', tokenRequired = false, username = 'admin' } = {}) {
  return `<!doctype html><html lang="${t('common.admin') === 'admin' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(t('setup.title'))} · ${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="center">
<form class="card" method="post" action="/login">
  <h1>${escapeHTML(t('setup.title'))}</h1>
  <p class="sub">${escapeHTML(t('setup.sub'))}</p>
  ${error ? `<div class="err">${escapeHTML(error)}</div>` : ''}
  <label for="username">${escapeHTML(t('setup.username'))}</label>
  <input id="username" name="username" value="${escapeHTML(username)}" autocomplete="username" autofocus required>
  <label for="password">${escapeHTML(t('setup.password'))}</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required>
  <label for="confirm">${escapeHTML(t('setup.confirm'))}</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" required>
  ${
    tokenRequired
      ? `<label for="token">${escapeHTML(t('setup.token'))}</label>
  <input id="token" name="token" placeholder="${escapeHTML(t('setup.tokenHint'))}" autocomplete="off" required>
  <div class="info">${escapeHTML(t('setup.tokenInfo'))}</div>`
      : ''
  }
  <input type="hidden" name="next" value="${escapeHTML(next)}">
  <button class="primary" type="submit">${escapeHTML(t('setup.submit'))}</button>
  <div class="foot">${escapeHTML(t('setup.foot'))}</div>
</form>
</body></html>`
}

function sendSetupPage(res, cfg, t, options, status = 200, extraHeaders = {}) {
  return html(res, status, setupPage(cfg, t, options), { 'cache-control': 'no-store', ...extraHeaders })
}

/** 首次创建管理员：建号 + 直接登录。 */
async function handleSetup(req, res, cfg, state, access, t) {
  const next = safeNext(queryParam(req, 'next'))
  const secure = isSecureRequest(req, cfg)
  // 非内网来源要带初始化口令，防止公网上有人抢注
  const tokenRequired = !access.ip || !isTrusted(access.ip, cfg.trusted)

  if (req.method === 'GET' || req.method === 'HEAD') {
    return sendSetupPage(res, cfg, t, { next, tokenRequired, username: cfg.username || 'admin' })
  }
  if (req.method !== 'POST') {
    return text(res, 405, '405 method not allowed\n', { allow: 'GET, POST' })
  }

  // 用账号维度的 key，这样猜初始化口令也会被限速（默认 3 次）
  const key = accountKey(`setup:${access.ip || 'unknown'}`)
  const gate = state.throttle.check(key)
  if (!gate.allowed) {
    const mins = Math.max(1, Math.ceil(gate.retryAfter / 60))
    return sendSetupPage(res, cfg, t, { next, tokenRequired, error: t('setup.error.throttle', { mins }) }, 429, {
      'retry-after': String(gate.retryAfter),
    })
  }

  let form
  try {
    form = parseForm(await readBody(req, 4096))
  } catch {
    return sendSetupPage(res, cfg, t, { next, tokenRequired, error: t('login.error.body') }, 400)
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
          t,
          { next, tokenRequired, error: t('setup.error.tokenLocked', { mins }) },
          429,
          { 'retry-after': String(hit.retryAfter) },
        )
      }
      return sendSetupPage(
        res,
        cfg,
        t,
        { next, tokenRequired, error: t('setup.error.tokenWrong') },
        401,
      )
    }
  }

  const username = String(form.username || '').trim()
  const password = String(form.password || '')
  const confirm = String(form.confirm || '')
  const again = (error) => sendSetupPage(res, cfg, t, { next, tokenRequired, username, error }, 400)

  if (!validUsername(username)) return again(t('setup.error.badUser'))
  if (!validPassword(password)) return again(t('setup.error.badPass', { min: MIN_PASSWORD }))
  if (password !== confirm) return again(t('setup.error.mismatch'))

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

function sendLoginPage(res, cfg, t, options, status = 200, extraHeaders = {}) {
  return html(res, status, loginPage(cfg, t, options), {
    'cache-control': 'no-store',
    ...extraHeaders,
  })
}

/** 被锁定时的页面。 */
function lockedPage(cfg, t, retryAfter, policy, username) {
  const mins = Math.max(1, Math.ceil(retryAfter / 60))
  return `<!doctype html><html lang="${t('common.admin') === 'admin' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(t('locked.title'))} · ${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="center"><div class="card">
<h1>${escapeHTML(t('locked.title'))}</h1>
<p class="sub">${t('locked.sub', { mins })}</p>
<div class="info">${t('locked.info', { user: escapeHTML(username || ''), attempts: policy.accountMaxAttempts, minutes: policy.lockoutMinutes })}</div>
</div></body></html>`
}

function parseForm(body) {
  const out = {}
  for (const [k, v] of new URLSearchParams(body)) out[k] = v
  return out
}

async function handleAuthRoute(req, res, cfg, state, access, t) {
  const { session, store, throttle } = state
  const path = pathnameOf(req)
  const secure = isSecureRequest(req, cfg)

  if (path === '/logout') {
    return redirect(res, '/login', { 'set-cookie': session.clearCookieHeader({ secure }) })
  }

  const next = safeNext(queryParam(req, 'next'))

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (userFromSession(req, cfg, state)) return redirect(res, next)
    return sendLoginPage(res, cfg, t, { next })
  }
  if (req.method !== 'POST') {
    return text(res, 405, '405 method not allowed\n', { allow: 'GET, POST' })
  }

  const clientKey = access.ip || 'unknown'

  let form
  try {
    form = parseForm(await readBody(req, 4096))
  } catch {
    return sendLoginPage(res, cfg, t, { next, error: t('login.error.body') }, 400)
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
      t,
      { next, error: t('login.error.locked', { mins }) },
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
      t,
      { next, error: t('login.error.lockedFor', { minutes: state.policy.lockoutMinutes }) },
      429,
      { 'retry-after': String(Math.max(ipFail.retryAfter, acctFail.retryAfter)) },
    )
  }

  const left = Math.min(ipFail.remaining, acctFail.remaining)
  const wrong = t('login.error.wrong')
  const remaining =
    left <= 2 ? t('login.error.remaining', { left, minutes: state.policy.lockoutMinutes }) : ''
  return sendLoginPage(res, cfg, t, { next, error: `${wrong}${remaining}` }, 401)
}

// ---------------------------------------------------------------------------
// 管理后台
// ---------------------------------------------------------------------------

/** 账号管理页（/admin）能做的动作。 */
const ACCOUNT_ACTIONS = new Set([
  'create',
  'delete',
  'set-password',
  'set-admin',
  'set-member',
  'disable',
  'enable',
  'save-settings',
  'set-lang',
  'check-update',
  'unlock',
  'unlock-key',
])

/** 目录绑定页（/admin/bindings）能做的动作。 */
const BINDING_ACTIONS = new Set([
  'add-binding',
  'delete-binding',
  'save-default',
  'clear-default',
  'set-binding-auth',
  'clear-binding-auth',
  'share-binding',
  'set-lang',
  'check-update',
])

/** 后台「浏览这台电脑」弹窗最多列出的条目数。 */
const MAX_DIR_ENTRIES = 300

/** 文件类型标签（尽量贴近 Finder 的 Kind 列）。 */
function fileKind(name, isDir, t) {
  if (isDir) return t('dir.folder')
  const ext = path.extname(name).toLowerCase().slice(1)
  const groups = [
    [['txt', 'md', 'log', 'csv', 'json', 'yml', 'yaml', 'xml', 'ini', 'conf'], 'kind.text'],
    [['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'sh', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h'], 'kind.code'],
    [['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'heic', 'tiff'], 'kind.image'],
    [['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'], 'kind.video'],
    [['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'], 'kind.audio'],
    [['zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'dmg', 'pkg'], 'kind.archive'],
    [['pdf'], 'kind.pdf'],
    [['xlsx', 'xls', 'numbers'], 'kind.sheet'],
    [['doc', 'docx', 'pages'], 'kind.doc'],
    [['ppt', 'pptx', 'key'], 'kind.slides'],
  ]
  for (const [exts, key] of groups) if (exts.includes(ext)) return t(key)
  return ext ? `${ext.toUpperCase()} ${t('kind.file')}` : t('kind.file')
}

/** 弹窗左侧栏：个人收藏 / 位置 / 已绑定目录。 */
function dirRoots(bindings = [], t = createT('zh')) {
  const roots = []
  const add = (kind, name, p) => {
    if (!p) return
    if (roots.some((r) => r.path === p)) return
    try {
      if (!statSync(p).isDirectory()) return
    } catch {
      return
    }
    roots.push({ kind, name, path: p })
  }
  const home = os.homedir()
  add('favorite', t('dir.home'), home)
  add('favorite', t('dir.desktop'), path.join(home, 'Desktop'))
  add('favorite', t('dir.downloads'), path.join(home, 'Downloads'))
  add('favorite', t('dir.documents'), path.join(home, 'Documents'))
  add('favorite', t('dir.applications'), '/Applications')
  add('favorite', t('dir.music'), path.join(home, 'Music'))
  add('favorite', t('dir.movies'), path.join(home, 'Movies'))
  add('favorite', t('dir.pictures'), path.join(home, 'Pictures'))
  add('location', t('dir.cwd'), process.cwd())
  for (const b of bindings) add('binding', t('dir.bound', { mount: b.mount }), b.root)
  if (process.platform === 'win32') {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') add('location', `${letter}:\\`, `${letter}:\\`)
  } else {
    add('location', t('dir.root'), '/')
  }
  return roots
}

/**
 * 后台「浏览电脑」弹窗的数据源：列出某个目录下的子目录与文件（含大小/类型/时间）。
 * 只读、只给管理员，路径出问题就返回 error 字段而不是报错。
 */
async function listDirs(target, bindings, t = createT('zh')) {
  const start = expandDir(target || os.homedir())
  const roots = dirRoots(bindings, t)
  const parent = path.dirname(start)
  try {
    const info = await stat(start)
    if (!info.isDirectory()) {
      return { path: start, parent: null, entries: [], roots, error: t('dir.notDir') }
    }
    const dirents = await readdir(start, { withFileTypes: true })
    const all = await Promise.all(
      dirents
        // 以 . 开头的默认不列（跟 Finder 一致），避免把 .git/.ssh 之类塞进列表
        .filter((d) => !d.name.startsWith('.'))
        .map(async (d) => {
          const full = path.join(start, d.name)
          const isDir = d.isDirectory()
          let size = null
          let mtime = null
          try {
            const st = await stat(full)
            mtime = st.mtime.toISOString()
            if (!isDir) size = st.size
          } catch {
            /* 权限不足或坏掉的符号链接：仍然列出，只是没有大小/时间 */
          }
          return {
            name: d.name,
            path: full,
            dir: isDir,
            size,
            mtime,
            kind: fileKind(d.name, isDir, t),
          }
        }),
    )
    // 目录在前，同类按名字排（Finder 的默认观感）
    all.sort(
      (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }),
    )
    const entries = all.slice(0, MAX_DIR_ENTRIES)
    return {
      path: start,
      parent: parent === start ? null : parent,
      entries,
      roots,
      truncated: all.length > entries.length,
      error: null,
    }
  } catch {
    return {
      path: start,
      parent: parent === start ? null : parent,
      entries: [],
      roots,
      error: t('dir.noAccess'),
    }
  }
}

async function handleAdmin(req, res, cfg, state, t, lang) {
  const { store, session } = state
  if (!isAuthEnabled(cfg)) return html(res, 200, adminDisabledPage(cfg, t))
  if (!store) return html(res, 200, adminDisabledPage(cfg, t))

  const user = authenticatedUser(req, cfg, state)
  if (!user) {
    if (session && wantsHTML(req)) return redirect(res, `/login?next=${encodeURIComponent(safeNext(req.url))}`)
    return text(res, 401, '401 unauthorized\n')
  }
  if (user.role !== 'admin') {
    return html(res, 403, adminForbiddenPage(cfg, t, user.username))
  }

  const seed = csrfSeed(req, session)
  const csrf = session ? session.csrf(seed) : ''
  const adminPath = pathnameOf(req)
  // 目录绑定是独立的一页（/admin/bindings），跟账号管理分开
  const isBindings = adminPath === '/admin/bindings' || adminPath.startsWith('/admin/bindings/')
  /** 这页的「回到本页」跳转（带 ok / err / 路径参数）。 */
  const go = (res, query) =>
    redirect(res, `${isBindings ? '/admin/bindings' : '/admin'}?${query}`, {}, 303)

  // 「浏览这台电脑」弹窗的数据接口（只读，管理员才能看）
  if (adminPath === '/admin/api/dirs') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return text(res, 405, '405 method not allowed\n', { allow: 'GET, HEAD' })
    }
    return json(res, 200, await listDirs(queryParam(req, 'path'), state.bindings, t))
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    // 缓存过期（或从没查过）就顺手在后台查一次：10 分钟内不重复尝试，失败也不打扰
    const snapshot = state.update.get()
    if (
      snapshot.enabled &&
      snapshot.stale &&
      Date.now() - state.updateAttemptAt > 10 * 60_000
    ) {
      state.updateAttemptAt = Date.now()
      void checkForUpdate({
        name: 'oh-my-http',
        current: VERSION,
        cacheFile: updateCacheFile(cfg.stateDir),
        registry: cfg.registry,
        force: true,
      })
        .then(() => state.update.invalidate())
        .catch(() => {})
    }

    const common = {
      actor: user.username,
      actorMethod: user.method,
      csrf,
      ok: queryParam(req, 'ok'),
      err: queryParam(req, 'err'),
    }
    if (isBindings) {
      return html(res, 200, bindingsPage(cfg, store, {
        t,
        lang,
        update: state.update.get(),
        ...common,
        bindings: state.bindings,
        // 分享链接（签名令牌，带有效期；密码本身不会出现在链接里）
        share: queryParam(req, 'share'),
        shareMount: queryParam(req, 'mount'),
        shareDays: queryParam(req, 'days'),
        shareExp: (() => {
          const token = queryParam(req, 'share')
          const payload = token ? state.bindSessions.verify(token) : null
          return payload ? new Date(payload.expiresAt).toISOString() : ''
        })(),
        origin: requestOrigin(req, cfg),
      }), { 'cache-control': 'no-store' })
    }
    return html(res, 200, adminPage(cfg, store, {
      ...common,
      t,
      lang,
      update: state.update.get(),
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
    return go(res, 'err=bad_request')
  }

  if (!session || !session.checkCsrf(seed, String(form.csrf || ''))) {
    return go(res, 'err=csrf')
  }
  const action = String(form.action || '')
  const target = String(form.target || '')
  const allowedActions = isBindings ? BINDING_ACTIONS : ACCOUNT_ACTIONS
  if (!allowedActions.has(action)) return go(res, 'err=bad_request')

  try {
    switch (action) {
      case 'create':
        await store.create({
          username: String(form.username || '').trim(),
          password: String(form.password || ''),
          role: String(form.role || 'member'),
        })
        return go(res, 'ok=created')
      case 'delete':
        if (target === user.username) return go(res, 'err=self_delete')
        await store.remove(target)
        state.throttle.unlock(accountKey(target)) // 账号都没了，锁定也没意义
        return go(res, 'ok=deleted')
      case 'set-password':
        await store.setPassword(target, String(form.password || ''))
        // 密码换了，针对旧密码的失败记录/锁定自动失效
        state.throttle.unlock(accountKey(target))
        return go(res, 'ok=password')
      case 'set-admin':
        await store.setRole(target, 'admin')
        return go(res, 'ok=role')
      case 'set-member':
        await store.setRole(target, 'member')
        return go(res, 'ok=role')
      case 'disable':
        await store.setDisabled(target, true)
        return go(res, 'ok=disabled')
      case 'enable':
        await store.setDisabled(target, false)
        return go(res, 'ok=enabled')
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
        return go(res, 'ok=settings')
      }
      // 手动检查新版本（唯一会联网的地方，管理员点按钮才触发）
      case 'check-update': {
        try {
          await checkForUpdate({
            name: 'oh-my-http',
            current: VERSION,
            cacheFile: updateCacheFile(cfg.stateDir),
            registry: cfg.registry,
            force: true,
          })
          state.update.invalidate()
          return go(res, 'ok=update_checked')
        } catch {
          return go(res, 'err=update_failed')
        }
      }
      // 界面语言：zh / en / auto（立即生效，登录页也跟着变）
      case 'set-lang': {
        await store.saveSettings({ lang: String(form.lang || '') })
        return go(res, 'ok=lang')
      }
      case 'unlock':
        state.throttle.clear()
        return go(res, 'ok=unlocked')
      case 'add-binding': {
        let binding
        let auth = null
        try {
          // 表单默认勾选“自动生成口令”：不用手填密码
          const auto = String(form.auto_auth || '') !== ''
          auth = readBindingAuth(form)
          if (!auth && auto) auth = { username: '', password: generatePassword() }
          binding = normalizeBinding({
            mount: form.bind_path,
            root: form.bind_dir,
            auth,
          })
        } catch (err) {
          return go(res, `err=${encodeURIComponent(mapBindingError(err.message))}`)
        }
        if (state.bindings.some((b) => b.mount === binding.mount)) {
          return go(res, 'err=bind_exists')
        }
        // 立即生效：先换内存里的绑定表（请求按它路由），再落盘
        const next = normalizeBindings([...state.bindings, binding])
        state.bindings = next
        await store.saveSettings({ mounts: next })
        let token = ''
        if (binding.auth) {
          binding = withShareInfo(state.bindSessions, binding, DEFAULT_SHARE_DAYS)
          token = binding.share.token
          // 记了分享信息后再落盘一次（绑定表里已有这条）
          const withShare = state.bindings.map((b) => (b.mount === binding.mount ? binding : b))
          state.bindings = normalizeBindings(withShare)
          await store.saveSettings({ mounts: state.bindings })
        }
        const share = token
          ? `&share=${encodeURIComponent(token)}&days=${DEFAULT_SHARE_DAYS}`
          : ''
        // 口令不展示：需要分享就用行内的「分享链接」重新生成
        const pwParam = ''
        return go(res, `ok=bound&mount=${encodeURIComponent(binding.mount)}${pwParam}${share}`)
      }
      case 'delete-binding': {
        const mount = String(form.bind_path || form.target || '')
        const next = state.bindings.filter((b) => b.mount !== mount)
        if (next.length === state.bindings.length) {
          return go(res, 'err=notfound')
        }
        state.bindings = next
        await store.saveSettings({ mounts: next })
        return go(res, 'ok=unbound')
      }
      // 默认目录：挂在 / 的那条绑定，没写命令行也能用
      case 'save-default': {
        let binding
        try {
          binding = normalizeBinding({ mount: '/', root: form.default_dir }, { allowRoot: true })
        } catch (err) {
          return go(res, `err=${encodeURIComponent(mapBindingError(err.message))}`)
        }
        const next = normalizeBindings([...state.bindings.filter((b) => b.mount !== '/'), binding])
        state.bindings = next
        await store.saveSettings({ mounts: next })
        return go(res, 'ok=default_bound')
      }
      case 'set-binding-auth': {
        const mount = String(form.bind_path || form.target || '')
        const idx = state.bindings.findIndex((b) => b.mount === mount)
        if (idx === -1) return go(res, 'err=notfound')
        let updated
        try {
          const auth = readBindingAuth({ bind_user: form.bind_user, bind_pass: form.bind_pass })
          if (!auth) throw new Error('要设独立账号，用户名和密码都要填')
          updated = normalizeBinding({ ...state.bindings[idx], auth }, { verifyDir: false })
        } catch (err) {
          return go(res, `err=${encodeURIComponent(mapBindingError(err.message))}`)
        }
        const next = state.bindings.slice()
        next[idx] = updated
        state.bindings = normalizeBindings(next)
        await store.saveSettings({ mounts: state.bindings })
        // 口令换了，旧密码的失败记录/锁定自动失效
        state.throttle.unlock(bindingKey(mount))
        const token = issueShareToken(state.bindSessions, updated)
        return go(
          res,
          `ok=binding_auth&mount=${encodeURIComponent(mount)}&share=${encodeURIComponent(token)}&days=${DEFAULT_SHARE_DAYS}`,
        )
      }
      // 「分享链接」= 自动生成/轮换口令 + 签发带有效期的令牌
      // （不提供手动设密码：想换密码就重新生成一次分享地址，旧链接立即失效）
      case 'share-binding': {
        const mount = String(form.bind_path || form.target || '')
        const idx = state.bindings.findIndex((b) => b.mount === mount)
        if (idx === -1) return go(res, 'err=notfound')
        const days = shareDays(form.share_days)
        if (!days) return go(res, 'err=bind_share_days')
        let updated
        try {
          updated = normalizeBinding(
            { ...state.bindings[idx], auth: { username: '', password: generatePassword() } },
            { verifyDir: false },
          )
        } catch (err) {
          return go(res, `err=${encodeURIComponent(mapBindingError(err.message))}`)
        }
        updated = withShareInfo(state.bindSessions, updated, days)
        const next = state.bindings.slice()
        next[idx] = updated
        state.bindings = normalizeBindings(next)
        await store.saveSettings({ mounts: state.bindings })
        state.throttle.unlock(bindingKey(mount))
        const token = updated.share.token
        return go(
          res,
          `ok=share&mount=${encodeURIComponent(mount)}&share=${encodeURIComponent(token)}&days=${days}`,
        )
      }
      case 'clear-binding-auth': {
        const mount = String(form.bind_path || form.target || '')
        const idx = state.bindings.findIndex((b) => b.mount === mount)
        if (idx === -1) return go(res, 'err=notfound')
        if (!state.bindings[idx].auth) return go(res, 'err=notfound')
        const { auth: _removed, ...rest } = state.bindings[idx]
        const next = state.bindings.slice()
        next[idx] = rest
        state.bindings = normalizeBindings(next)
        await store.saveSettings({ mounts: state.bindings })
        state.throttle.unlock(bindingKey(mount))
        return go(res, 'ok=binding_public')
      }
      case 'clear-default': {
        const next = state.bindings.filter((b) => b.mount !== '/')
        if (next.length === state.bindings.length) {
          return go(res, 'err=notfound')
        }
        state.bindings = next
        await store.saveSettings({ mounts: next })
        return go(res, 'ok=default_cleared')
      }
      case 'unlock-key': {
        const key = String(form.key || '')
        if (!key) return go(res, 'err=bad_request')
        const ok = state.throttle.unlock(key)
        return redirect(res, ok ? '/admin?ok=unlocked_one' : '/admin?err=not_locked', {}, 303)
      }
      default:
        return go(res, 'err=bad_request')
    }
  } catch (err) {
    return go(res, `err=${encodeURIComponent(mapAdminError(err.message))}`)
  }
}

function mapAdminError(message) {
  if (/已存在/.test(message)) return 'exists'
  if (/是内置接口/.test(message)) return 'bind_reserved'
  if (/不存在或不是目录/.test(message)) return 'bind_missing'
  if (/绑定路径/.test(message)) return 'bind_invalid'
  if (/用户名只能/.test(message)) return 'invalid_user'
  if (/密码至少/.test(message)) return 'invalid_password'
  if (/角色只能是/.test(message)) return 'invalid_role'
  if (/至少要保留/.test(message)) return 'last_admin'
  if (/不存在/.test(message)) return 'notfound'
  if (/连续失败次数|失败次数应为|锁定时长/.test(message)) return 'invalid_settings'
  return 'bad_request'
}

/** 从表单里读出独立账号：两个都空=不启用；只填一个=报错。 */
function readBindingAuth(form) {
  const username = String(form.bind_user || '').trim()
  const password = String(form.bind_pass || '')
  if (!username && !password) return null
  // 用户名可选（只给密码也能用），密码不能空
  if (!password) throw new Error('要设独立口令，密码不能为空')
  return { username, password }
}

/** 自动生成口令用的字符集（去掉 0/O、1/l/I 这类容易看错的）。 */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 自动生成一个访问口令（默认 12 位）。 */
function generatePassword(length = 12) {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length]
  return out
}

/** 分享链接默认有效期（天）。 */
const DEFAULT_SHARE_DAYS = 3
/** 分享链接最长有效期（天）。 */
const MAX_SHARE_DAYS = 365

/** 当前口令哈希的前缀：轮换口令后，旧的分享令牌与 Cookie 都会自动失效。 */
const bindingAuthTag = (binding) => String(binding?.auth?.hash || '').slice(0, 16)

/** 分享令牌的签名主体（带路径与口令哈希，换路径/轮换口令即失效）。 */
const shareSubject = (binding) => `share:${binding.mount}:${bindingAuthTag(binding)}`

/** 规范化分享有效期（天）。 */
function shareDays(raw, fallback = DEFAULT_SHARE_DAYS) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_SHARE_DAYS) return null
  return n
}

/** 签发一条带有效期的分享令牌（签名里带过期时间，不需要存库）。 */
function issueShareToken(bindSessions, binding, days = DEFAULT_SHARE_DAYS) {
  return bindSessions.issue(shareSubject(binding), Date.now(), Math.round(days * DAY_MS))
}

/** 生成分享链接并记到绑定上（后台列表要显示有效期与结束时间）。 */
function withShareInfo(bindSessions, binding, days = DEFAULT_SHARE_DAYS) {
  const token = issueShareToken(bindSessions, binding, days)
  const expiresAt = Date.now() + Math.round(days * DAY_MS)
  return { ...binding, share: { days, expiresAt, token } }
}

/** 子路径独立口令的失败计数键（跟主站账号的锁定互不影响）。 */
const bindingKey = (mount) => accountKey(`bind:${mount}`)

/** URL 里带口令的参数名：`toke` 是约定名，其余几个是兼容别名。 */
const BINDING_TOKEN_PARAMS = ['toke', 'token', 'pwd', 'key']

/** 分享链接验证通过后种的 Cookie 名（按路径区分，不同绑定互不串用）。 */
const bindingCookieName = (mount) => `ohmy_bind_${sha256(mount).toString('hex').slice(0, 10)}`
/**
 * Cookie 里记的主体：路径 + 当前口令哈希的前缀。
 * 这样不同绑定之间不能串用，改密码后旧 Cookie 也会自动失效。
 */
const bindingSubject = (binding) => `bind:${binding.mount}:${bindingAuthTag(binding)}`

/** 从 URL 查询串里取口令（toke / token / pwd / key 都认）。 */
function bindingToken(req) {
  for (const name of BINDING_TOKEN_PARAMS) {
    const value = queryParam(req, name)
    if (value) return value
  }
  return ''
}

/** 当前请求的来源（给后台拼分享链接用）。 */
function requestOrigin(req, cfg) {
  const proto = isSecureRequest(req, cfg) ? 'https' : 'http'
  const host = req.headers?.host || `${cfg.host}:${cfg.port}`
  return `${proto}://${host}`
}

/**
 * 判断一次请求能不能进带独立口令的子路径。
 *
 * 认可四种凭证（任一通过即可）：
 *  1. 之前验证过的 Cookie（分享链接打开一次后，后续浏览都靠它）
 *  2. URL 里的口令，例如 `/gp?toke=123`（分享链接就长这样）
 *  3. Basic 认证头（浏览器弹框 / curl -u）
 *  4. 只密码模式下那个密码表单提交的 ohmy_pass
 */
async function readBindingAccess(req, cfg, state, binding, bindSessions) {
  const auth = binding.auth
  const cookieName = bindingCookieName(binding.mount)
  const token = parseCookies(req.headers?.cookie)[cookieName] || ''
  if (token && bindSessions.verify(token)?.username === bindingSubject(binding)) {
    return { ok: true, via: 'cookie' }
  }

  const urlToken = bindingToken(req)
  if (urlToken) {
    // 1) 带有效期的分享令牌（后台生成，签名里有过期时间与路径）
    const share = bindSessions.verify(urlToken)
    if (share && share.username === shareSubject(binding)) {
      return { ok: true, via: 'share', expiresAt: share.expiresAt }
    }
    // 2) 兼容直接把密码拼在 URL 里的写法（?user=xx&toke=口令 或只给口令）
    const user = queryParam(req, 'user') || auth.username || ''
    if (verifyBindingAuth(binding, user, urlToken)) {
      return { ok: true, via: 'token', fingerprint: credentialFingerprint('bind-url', urlToken) }
    }
    return { ok: false, wrong: true, fingerprint: credentialFingerprint('bind-url', urlToken) }
  }

  const creds = basicAuthCredentials(req)
  if (creds) {
    if (verifyBindingAuth(binding, creds.username, creds.password)) return { ok: true, via: 'basic' }
    return { ok: false, wrong: true, fingerprint: credentialFingerprint('bind', creds.username, creds.password) }
  }

  // 只密码模式：页面上的表单
  if (req.method === 'POST') {
    let given = ''
    try {
      given = String(parseForm(await readBody(req, 4096)).ohmy_pass || '')
    } catch {
      /* 读不出来就当没填 */
    }
    if (given && verifyBindingAuth(binding, auth.username || '', given)) {
      return { ok: true, via: 'form' }
    }
    if (given) {
      return { ok: false, wrong: true, fingerprint: credentialFingerprint('bind-form', given) }
    }
  }
  return { ok: false, wrong: false }
}

/** 只设了密码的绑定：给一个简单的密码页，而不是让浏览器弹基本框。 */
function bindingPasswordPage(cfg, t, binding, { error = '', path = '/' } = {}) {
  return `<!doctype html><html lang="${t('common.admin') === 'admin' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(t('pw.title'))} · ${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="center">
<form class="card" method="post" action="${escapeHTML(path)}">
  <h1>${escapeHTML(t('pw.title'))}</h1>
  <p class="sub">${t('pw.sub', { path: `<code>${escapeHTML(binding.mount)}</code>` })}</p>
  ${error ? `<div class="err">${escapeHTML(error)}</div>` : ''}
  <label for="pw">${escapeHTML(t('pw.label'))}</label>
  <input id="pw" name="ohmy_pass" type="password" autocomplete="current-password" autofocus required>
  <button class="primary" type="submit">${escapeHTML(t('pw.submit'))}</button>
  <div class="foot">${escapeHTML(t('pw.foot'))}</div>
</form>
</body></html>`
}

/** 子目录绑定的报错码（单独一层，便于后台给出具体原因）。 */
function mapBindingError(message) {
  if (/独立账号用户名/.test(message)) return 'bind_auth_user'
  if (/独立口令的密码至少|独立账号密码至少/.test(message)) return 'bind_auth_pass'
  if (/密码不能为空/.test(message)) return 'bind_auth_pass'
  if (/用户名和密码都要填|需要填密码|需要填用户名/.test(message)) return 'bind_auth_incomplete'
  if (/是内置接口/.test(message)) return 'bind_reserved'
  if (/不存在或不是目录/.test(message)) return 'bind_missing'
  if (/已存在/.test(message)) return 'bind_exists'
  if (/根路径/.test(message)) return 'bind_root'
  return 'bind_invalid'
}

// ---------------------------------------------------------------------------
// 其它页面
// ---------------------------------------------------------------------------

function indexPage(cfg, access, bindings, t) {
  const mount = cfg.root ? (cfg.mount === '/' ? '/' : `${cfg.mount}/`) : null
  const files = mount
    ? `\n<li><code>GET ${mount}</code> — ${escapeHTML(t('index.routeFiles'))} <code>${escapeHTML(cfg.root)}</code></li>`
    : ''
  const bound = bindings
    .map((b) => {
      const where = b.mount === '/' ? '/' : `${b.mount}/`
      const label = b.mount === '/' ? t('bindings.defaultDir') : t('index.routeBindings')
      return `\n<li><code>GET ${escapeHTML(where)}</code> — ${escapeHTML(label)} <code>${escapeHTML(b.root)}</code></li>`
    })
    .join('')
  const admin =
    isAuthEnabled(cfg) && access.user?.role === 'admin'
      ? `\n<li><a href="/admin">${escapeHTML(t('nav.accounts'))}</a> — ${escapeHTML(t('index.routeAdminDesc'))}</li>`
      : ''
  const who = access.user
    ? t('index.loggedIn', {
        user: `<b>${escapeHTML(access.user.username)}</b>`,
        role: access.user.role === 'admin' ? t('common.admin') : t('common.member'),
      })
    : t('index.authMethod', { method: `<b>${escapeHTML(access.method)}</b>` })
  const warn = !isAuthEnabled(cfg)
    ? `\n<p style="color:#c00">${escapeHTML(t('index.warn'))}</p>`
    : ''
  return `<!doctype html><html lang="${t('common.admin') === 'admin' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(cfg.realm)}</title>
${AUTH_STYLE}</head>
<body class="wrap">
<h1>${escapeHTML(cfg.realm)}</h1>
<p>${t('index.youAre', { ip: `<code>${escapeHTML(access.ip || 'unknown')}</code>`, who })}</p>${warn}
<ul>
<li><code>GET /healthz</code> — ${escapeHTML(t('index.routeHealthz'))}</li>
<li><code>GET /whoami</code> — ${escapeHTML(t('index.routeWhoami'))}</li>
<li><code>POST /api/echo</code> — ${escapeHTML(t('index.routeEcho'))}</li>${files}${bound}${admin}
</ul>
${isAuthEnabled(cfg) && cfg.auth === 'form' ? `<p><a href="/logout">${escapeHTML(t('nav.logout'))}</a></p>` : ''}
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
/**
 * 从账号文件重新加载：账号、界面语言、锁定策略、目录绑定。
 * 不重启进程、不断开现有连接（`oh-my-http reload` / SIGHUP 走这里）。
 */
export function reloadFromDisk(cfg, state, logger) {
  if (!cfg.usersFile) return { ok: false, error: '没有使用账号文件（--users-file none），无可加载内容' }
  const store = createAccountStore({ file: cfg.usersFile, bootstrap: null })
  if (store.loadError) return { ok: false, error: store.loadError.message }

  state.store = store
  // isAuthEnabled() 依赖 cfg.userCount，跟着更新
  cfg.userCount = store.count
  state.bindings = normalizeBindings(store.settings?.mounts)
  state.policy = resolvePolicy(withAuthState(cfg, store), store)
  state.throttle.setPolicy({
    accountMaxAttempts: state.policy.accountMaxAttempts,
    ipMaxAttempts: state.policy.ipMaxAttempts,
    lockoutMinutes: state.policy.lockoutMinutes,
  })
  state.update.invalidate()

  const summary = { ok: true, users: store.count, bindings: state.bindings.length }
  // 直接打到 stdout（daemon 会进日志文件），不复用访问日志格式
  console.log(
    `oh-my-http: 已重新加载账号 / 设置：${summary.users} 个账号，${summary.bindings} 条目录绑定`,
  )
  return summary
}

export function createHandler(cfg, { logger, store, policy, setupToken } = {}) {
  const serverStartedAt = Date.now()
  const useSession = cfg.auth === 'form' && isAuthEnabled(cfg)
  const session = useSession
    ? createSessionStore({
        secret: store?.sessionSecret,
        ttlMs: (cfg.sessionDays || 7) * DAY_MS,
      })
    : null
  // 子路径绑定的独立口令也用签名 Cookie（跟主站登录态完全分开，互不影响）
  const bindSessions = createSessionStore({
    secret: store?.sessionSecret,
    ttlMs: (cfg.sessionDays || 7) * DAY_MS,
  })
  const state = {
    session,
    bindSessions,
    // 新版本状态：读 CLI 写的缓存；管理员打开后台时若缓存过期会后台悄悄重查
    update: createUpdateState({ current: VERSION, stateDir: cfg.stateDir, enabled: !cfg.noUpdateCheck }),
    updateAttemptAt: 0,
    store,
    logger,
    policy: policy || resolvePolicy(cfg, store),
    // 后台加的子目录绑定：存在账号文件的 settings.mounts 里，每个请求现查 → 改完立即生效
    bindings: normalizeBindings(store?.settings?.mounts),
    // 还没有账号时的初始化口令（公网来源创建管理员必须填）
    setupToken: setupToken ?? (store && store.count === 0 ? randomBytes(4).toString('hex') : null),
    throttle: null,
  }
  state.throttle = createLoginThrottle({
    accountMaxAttempts: state.policy.accountMaxAttempts,
    ipMaxAttempts: state.policy.ipMaxAttempts,
    lockMs: state.policy.lockoutMinutes * 60_000,
  })

  const handler = async function handler(req, res) {
    const { ip } = clientIP(req, cfg)
    const clientKey = ip || 'unknown'
    const path = pathnameOf(req)
    // 界面语言：后台设置优先，auto 时看浏览器的 Accept-Language
    const lang = pickLang(state.store?.settings?.lang, req.headers?.['accept-language'])
    const t = createT(lang)

    // 子路径绑定自带的独立口令：命中后只认这套凭据（跟主站账号、内网免认证都无关）
    const binding = matchBinding(path, state.bindings)
    const bindingAuth = binding?.auth || null
    const bindAccess = bindingAuth
      ? await readBindingAccess(req, cfg, state, binding, bindSessions)
      : null

    // 已有会话的直接认；锁定只拦“认证尝试”，不拦已经登录的会话
    // （否则一遍输错密码会把同一出口下的已登录管理员也踢出去，连解锁都做不了）
    const sessionUser = userFromSession(req, cfg, state)
    const creds = sessionUser ? null : credentialsOf(req, state)

    const ipGate = state.throttle.check(clientKey)
    const acctGate = creds
      ? state.throttle.check(accountKey(creds.username))
      : { allowed: true, retryAfter: 0, remaining: 3 }
    // 带独立口令的路径用自己的一套锁，不受主站锁定影响
    const locked = !bindingAuth && !sessionUser && (!ipGate.allowed || !acctGate.allowed)
    const retryAfter = Math.max(ipGate.retryAfter, acctGate.retryAfter)

    let access = evaluateAccess(req, cfg, { ...state, skipCredentials: locked })
    if (bindingAuth) {
      access = bindAccess.ok
        ? {
            ...access,
            allowed: true,
            method: 'binding',
            requiresPassword: false,
            user: {
              username: bindingAuth.username || binding.mount,
              role: 'binding',
              method: bindAccess.via,
            },
          }
        : { ...access, allowed: false, method: 'binding', requiresPassword: true, user: null }
    }
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
      // 子路径自带的独立口令：账号+密码模式让浏览器弹 Basic，只密码模式给密码页
      if (bindingAuth) {
        const key = bindingKey(binding.mount)
        const gate = state.throttle.check(key)
        if (!gate.allowed) {
          const mins = Math.max(1, Math.ceil(gate.retryAfter / 60))
          warnLog(state, clientKey, `子路径 ${binding.mount} 口令连错过多，已锁定 ${mins} 分钟`)
          return text(res, 429, `429 too many failed attempts; retry in ${mins} min\n`, {
            'retry-after': String(gate.retryAfter),
            'cache-control': 'no-store',
          })
        }
        if (bindAccess.wrong) {
          const hit = state.throttle.fail(key, Date.now(), bindAccess.fingerprint)
          if (hit.locked) {
            warnLog(
              state,
              clientKey,
              `子路径 ${binding.mount} 口令连错 ${hit.limit} 次，已锁定 ${state.policy.lockoutMinutes} 分钟`,
            )
          }
        }
        const error = bindAccess.wrong ? t('pw.wrong') : ''
        if (!bindingAuth.username) {
          // 只要密码：给个表单页（带 Basic 挑战只会让浏览器弹一个没有用户名的框）
          return html(res, 401, bindingPasswordPage(cfg, t, binding, { error, path }), {
            'cache-control': 'no-store',
          })
        }
        res.writeHead(401, {
          'content-type': 'text/plain; charset=utf-8',
          'www-authenticate': `Basic realm="${cfg.realm} ${binding.mount}", charset="UTF-8"`,
          'cache-control': 'no-store',
        })
        return res.end(`401 unauthorized: ${t('auth.needBindingPassword')}\n`)
      }

      // 已锁定：连密码都不看，直接 429
      if (locked) {
        const mins = Math.max(1, Math.ceil(retryAfter / 60))
        warnLog(state, clientKey, `已锁定，拒绝 ${req.method} ${path}（还剩约 ${mins} 分钟）`)
        if (wantsHTML(req)) {
          return html(res, 429, lockedPage(cfg, t, retryAfter, state.policy, creds?.username), {
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
          ? t('auth.remaining', { left, minutes: state.policy.lockoutMinutes })
          : ''
      res.writeHead(401, headers)
      return res.end(`401 unauthorized: ${t('auth.needCredentials')}${hint}\n`)
    }

    // 凭据登录成功：清掉失败计数（本机自动登录不算）
    if (access.user && access.method === 'password') {
      state.throttle.reset(clientKey)
      state.throttle.reset(accountKey(access.user.username))
    }
    if (bindingAuth && bindAccess.ok) {
      state.throttle.reset(bindingKey(binding.mount))
      const secure = isSecureRequest(req, cfg)
      if (bindAccess.via !== 'cookie') {
        const fallbackTtl = (cfg.sessionDays || 7) * DAY_MS
        // 分享链接：Cookie 只活到链接过期为止
        const ttl =
          bindAccess.via === 'share'
            ? Math.max(1000, bindAccess.expiresAt - Date.now())
            : fallbackTtl
        const token = bindSessions.issue(bindingSubject(binding), Date.now(), ttl)
        res.setHeader(
          'set-cookie',
          serializeCookie(bindingCookieName(binding.mount), token, {
            path: binding.mount,
            secure,
            maxAge: Math.floor(ttl / 1000),
          }),
        )
      }
      // 口令是从 URL / 表单来的：换完 Cookie 就跳到干净的地址，别把密码留在地址栏和历史里
      if (bindAccess.via === 'token' || bindAccess.via === 'form' || bindAccess.via === 'share') {
        return redirect(res, path, { 'cache-control': 'no-store' }, 303)
      }
    }

    try {
      if (session && (path === '/login' || path === '/logout')) {
        // 还没有账号：先引导创建管理员
        if (path === '/login' && state.store && state.store.count === 0) {
          return await handleSetup(req, res, cfg, state, access, t)
        }
        return await handleAuthRoute(req, res, cfg, state, access, t)
      }

      if (path === '/admin' || path.startsWith('/admin/')) {
        return await handleAdmin(req, res, cfg, state, t, lang)
      }

      if (path === '/healthz') return text(res, 200, 'ok\n')

      if (path === '/whoami') {
        return json(res, 200, {
          ip: access.ip,
          peer: access.peer,
          via_proxy: access.viaProxy,
          trusted: Boolean(access.ip) && isTrusted(access.ip, cfg.trusted),
          authenticated: Boolean(access.user),
          // 这次请求是“怎么放行的”：public / intranet-bypass / session / password / local
          authenticated_by: access.method,
          // 身份是怎么来的：local（本机免登录）/ session（Cookie）/ password（Basic）
          identity: access.user?.method || null,
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

      // 子目录绑定优先于命令行绑定的目录：默认根挂 / 时，/abc 才不会整个被它吃掉
      if (binding) return await serveStatic(req, res, cfg, path, binding, lang)

      if (cfg.root) {
        const mount = cfg.mount === '/' ? '' : cfg.mount
        if (path === mount || path.startsWith(`${mount}/`)) {
          return await serveStatic(req, res, cfg, path, null, lang)
        }
      }

      if (path === '/') {
        return html(res, 200, indexPage(cfg, access, state.bindings, t))
      }

      return text(res, 404, '404 not found\n')
    } catch (err) {
      logger?.({ level: 'error', path, error: String(err && err.message ? err.message : err) })
      if (!res.headersSent) text(res, 500, '500 internal error\n')
      else res.destroy()
    }
  }

  // 给 createServer / listen 用（SIGHUP → reload）
  handler.ohmy = { state, reload: () => reloadFromDisk(cfg, state, logger) }
  return handler
}

/** 创建 http.Server（尚未 listen）。 */
export function createServer(cfg, options = {}) {
  const { store = createAccountStore({ file: cfg.usersFile ?? null, bootstrap: cfg.bootstrap ?? null }), ...rest } = options
  const effective = withAuthState(cfg, store)
  const policy = resolvePolicy(effective, store)
  const setupToken =
    needsSetup(effective, store) && !rest.setupToken ? randomBytes(4).toString('hex') : rest.setupToken
  const handler = createHandler(effective, { ...rest, store, policy, setupToken })
  const server = http.createServer(handler)
  server.headersTimeout = 10_000
  server.requestTimeout = 60_000
  server.keepAliveTimeout = 120_000
  server.ohmy = { cfg: effective, store, policy, setupToken, reload: handler.ohmy.reload }
  return server
}

/** listen 的 Promise 包装。 */
export function listen(server, cfg) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    // SIGHUP = 重新加载配置（daemon 没有控制终端，不会因为终端挂断被杀）
    const onHup = () => {
      const result = server.ohmy?.reload?.()
      if (result && !result.ok) {
        server.ohmy?.cfg && console.error(`oh-my-http: 重新加载失败: ${result.error}`)
      }
    }
    process.on('SIGHUP', onHup)
    server.once('close', () => process.off('SIGHUP', onHup))
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
