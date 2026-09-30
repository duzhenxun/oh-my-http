import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 解析 Cookie 头为普通对象。 */
export function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string' || header === '') return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    let value = part.slice(eq + 1).trim()
    try {
      value = decodeURIComponent(value)
    } catch {
      /* 保留原值 */
    }
    out[name] = value
  }
  return out
}

/** 生成 Set-Cookie / Cookie 头值。 */
export function serializeCookie(name, value, options = {}) {
  const {
    maxAge,
    path = '/',
    httpOnly = true,
    sameSite = 'Lax',
    secure = false,
  } = options
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`]
  if (maxAge !== undefined) {
    parts.push(maxAge <= 0 ? 'Max-Age=0' : `Max-Age=${Math.floor(maxAge)}`)
  }
  if (httpOnly) parts.push('HttpOnly')
  if (sameSite) parts.push(`SameSite=${sameSite}`)
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/**
 * 无状态会话：token = base64url(payload) + "." + base64url(hmac)。
 * 密钥在进程内随机生成，重启即失效（不需要额外的持久化）。
 *
 * @param {{secret?: Buffer, ttlMs?: number, cookieName?: string}} options
 */
export function createSessionStore({ secret, ttlMs = 7 * 24 * 3600 * 1000, cookieName = 'ohmy_session' } = {}) {
  const key = secret ?? randomBytes(32)

  const sign = (payload) => {
    const body = b64url(JSON.stringify(payload))
    const mac = b64url(createHmac('sha256', key).update(body).digest())
    return `${body}.${mac}`
  }

  const hmac = (label, value) =>
    b64url(createHmac('sha256', key).update(`${label}:${value}`).digest()).slice(0, 24)

  return {
    cookieName,
    ttlMs,

    /**
     * 为某个用户名签发 token。
     * @param {string} username
     * @param {number} [now]
     * @param {number} [ttl] 本次会话有效期，默认用 store 的 ttlMs（“记住我”会传更长）
     */
    issue(username, now = Date.now(), ttl = ttlMs) {
      return sign({ u: username, exp: now + ttl, n: b64url(randomBytes(8)) })
    },

    /** 校验 token，返回 { username } 或 null。 */
    verify(token, now = Date.now()) {
      if (typeof token !== 'string') return null
      const dot = token.lastIndexOf('.')
      if (dot <= 0) return null
      const body = token.slice(0, dot)
      const mac = token.slice(dot + 1)
      const expected = createHmac('sha256', key).update(body).digest()
      let given
      try {
        given = Buffer.from(mac, 'base64url')
      } catch {
        return null
      }
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
      let payload
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
      } catch {
        return null
      }
      if (!payload || typeof payload.u !== 'string') return null
      if (typeof payload.exp !== 'number' || payload.exp <= now) return null
      return { username: payload.u, expiresAt: payload.exp }
    },

    cookieHeader(token, { secure = false, maxAge } = {}) {
      return serializeCookie(cookieName, token, {
        maxAge: maxAge ?? Math.floor(ttlMs / 1000),
        secure,
      })
    },

    clearCookieHeader({ secure = false } = {}) {
      return serializeCookie(cookieName, '', { maxAge: 0, secure })
    },

    /**
     * 与会话绑定的 CSRF token。
     * 以“当前会话 token”或 Authorization 头为种子，攻击者无法跨站伪造。
     */
    csrf(seed) {
      return hmac('csrf', String(seed || ''))
    },

    checkCsrf(seed, value) {
      if (typeof value !== 'string' || value === '') return false
      const expected = Buffer.from(hmac('csrf', String(seed || '')))
      const given = Buffer.from(value)
      return given.length === expected.length && timingSafeEqual(given, expected)
    },
  }
}

/** 账号维度的 key 前缀，避免和 IP 撞名。 */
export const ACCOUNT_PREFIX = 'user:'
export const accountKey = (username) => `${ACCOUNT_PREFIX}${String(username || '').toLowerCase()}`

/**
 * 把一组凭据变成短指纹（不保存原始密码）。
 * 用途：区分“同一个错误密码重复提交”和“换着密码猜”。
 */
export function credentialFingerprint(...parts) {
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('hex').slice(0, 24)
}

/**
 * 登录失败锁定。
 *
 * 默认**只按账号锁**：同一个账号连续失败 3 次 → 锁 1 小时。
 * 来源 IP 维度默认关闭（ipMaxAttempts = 0），因为在隧道/反向代理/公司出口后面，
 * 所有人的来源 IP 都一样，按 IP 锁会误伤整片人。
 *
 * 两个维度都可以单独设阈值，0 表示该维度不锁。
 * 同一份错误凭据重复提交只算一次；锁定期内再试不会续期。
 *
 * @param {{ipMaxAttempts?: number, accountMaxAttempts?: number, lockMs?: number}} options
 */
export function createLoginThrottle({
  ipMaxAttempts = 0,
  accountMaxAttempts = 3,
  lockMs = 60 * 60 * 1000,
} = {}) {
  /** @type {Map<string, {count: number, firstAt: number, lockedUntil: number, seen: Map<string, number>}>} */
  const records = new Map()
  // 策略可在运行时修改（管理后台里改完立即生效）
  // accountMaxAttempts = 账号维度（默认只锁这个）；ipMaxAttempts = 来源 IP 维度（默认 0 = 不锁）
  let policy = { ipMaxAttempts, accountMaxAttempts, lockMs }

  const accountLimit = () => policy.accountMaxAttempts
  const limitFor = (key) => (key.startsWith(ACCOUNT_PREFIX) ? accountLimit() : policy.ipMaxAttempts)
  const isDisabled = (key) => policy.lockMs <= 0 || limitFor(key) <= 0

  const prune = (now) => {
    if (records.size < 1000) return
    for (const [key, rec] of records) {
      if (rec.lockedUntil > now) continue
      if (now - rec.firstAt > policy.lockMs) records.delete(key)
    }
  }

  /** 该维度的剩余次数；limit<=0（关闭该维度）时返回 Infinity，不参与提示。 */
  const remainingFor = (limit, used) => (limit <= 0 ? Infinity : Math.max(0, limit - used))

  const view = (key, now) => {
    const rec = records.get(key)
    const limit = limitFor(key)
    if (rec && rec.lockedUntil > now) {
      return {
        allowed: false,
        locked: true,
        retryAfter: Math.ceil((rec.lockedUntil - now) / 1000),
        remaining: 0,
        limit,
      }
    }
    const used = rec && now - rec.firstAt <= policy.lockMs ? rec.count : 0
    return { allowed: true, locked: false, retryAfter: 0, remaining: remainingFor(limit, used), limit }
  }

  return {
    /** 来源 IP 维度的阈值（0 = 不按 IP 锁，默认）。 */
    get ipMaxAttempts() {
      return policy.ipMaxAttempts
    },

    /** 账号维度的阈值（0 = 不按账号锁）。 */
    get accountMaxAttempts() {
      return accountLimit()
    },

    get lockMs() {
      return policy.lockMs
    },

    get lockoutMinutes() {
      return Math.round(policy.lockMs / 60000)
    },

    get policy() {
      return { ...policy }
    },

    /** 两个维度都关了（或锁定时间为 0）。 */
    get disabled() {
      return policy.lockMs <= 0 || (policy.ipMaxAttempts <= 0 && policy.accountMaxAttempts <= 0)
    },

    /** 改策略（管理后台保存时用）；会清空已有锁定，避免旧策略的锁残留。 */
    setPolicy({ ipMaxAttempts: ipMax, accountMaxAttempts: accountMax, lockMs: lock, lockoutMinutes: minutes } = {}) {
      const next = { ...policy }
      if (ipMax !== undefined) next.ipMaxAttempts = Math.trunc(ipMax)
      if (accountMax !== undefined) next.accountMaxAttempts = Math.trunc(accountMax)
      if (lock !== undefined) next.lockMs = lock
      if (minutes !== undefined) next.lockMs = Math.trunc(minutes) * 60_000
      policy = next
      records.clear()
      return { ...policy }
    },

    /** 手动解除所有锁定。 */
    clear() {
      const n = records.size
      records.clear()
      return n
    },

    /** 解除单个 key（账号 key 用 accountKey() 生成）。 */
    unlock(key) {
      return records.delete(key)
    },

    /**
     * 当前锁定 / 失败状态的快照，给管理后台展示用。
     * 包含两类：已锁定的（带自动解锁时间），以及累计了失败但还没锁的。
     */
    snapshot(now = Date.now()) {
      const out = []
      for (const [key, rec] of records) {
        const isAccount = key.startsWith(ACCOUNT_PREFIX)
        const base = {
          key,
          kind: isAccount ? 'account' : 'ip',
          target: isAccount ? key.slice(ACCOUNT_PREFIX.length) : key,
          limit: limitFor(key),
        }
        if (rec.lockedUntil > now) {
          out.push({
            ...base,
            locked: true,
            lockedUntil: new Date(rec.lockedUntil).toISOString(),
            retryAfter: Math.ceil((rec.lockedUntil - now) / 1000),
            failures: 0,
          })
        } else if (rec.count > 0 && now - rec.firstAt <= policy.lockMs) {
          out.push({ ...base, locked: false, lockedUntil: null, retryAfter: 0, failures: rec.count })
        }
      }
      return out.sort(
        (a, b) => Number(b.locked) - Number(a.locked) || a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target),
      )
    },

    /** 是否允许再试；不允许时 retryAfter 是剩余秒数。 */
    check(key, now = Date.now()) {
      if (isDisabled(key)) return { allowed: true, locked: false, retryAfter: 0, remaining: Infinity, limit: 0 }
      prune(now)
      return view(key, now)
    },

    /**
     * 记一次失败。
     *
     * fingerprint 是本次提交的凭据指纹：**同一个错误凭据在锁定时长内只计一次**。
     * 这样浏览器缓存了旧 Basic 凭据、或前端自动重试时，不会因为一次页面加载里的
     * 十几个请求就把自己锁死；而换着密码猜（每次指纹不同）依旧照常累加。
     *
     * @param {string} key
     * @param {number} now
     * @param {string|null} fingerprint
     * @returns {{locked: boolean, retryAfter: number, remaining: number, limit: number, duplicate?: boolean}}
     */
    fail(key, now = Date.now(), fingerprint = null) {
      const limit = limitFor(key)
      if (isDisabled(key)) return { locked: false, retryAfter: 0, remaining: Infinity, limit: 0 }
      let rec = records.get(key)
      if (!rec || now - rec.firstAt > policy.lockMs) {
        rec = { count: 0, firstAt: now, lockedUntil: 0, seen: new Map() }
      }

      // 已经在锁定期里：不累加、不续期，直接告诉对方还剩多久
      if (rec.lockedUntil > now) {
        records.set(key, rec)
        return { locked: true, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000), remaining: 0, limit }
      }

      if (fingerprint) {
        const seenAt = rec.seen.get(fingerprint)
        if (seenAt !== undefined && now - seenAt <= policy.lockMs) {
          // 重复提交同一个错误凭据：不算新的失败
          records.set(key, rec)
          return {
            locked: false,
            retryAfter: 0,
            remaining: remainingFor(limit, rec.count),
            limit,
            duplicate: true,
          }
        }
        rec.seen.set(fingerprint, now)
        if (rec.seen.size > 64) {
          // 只留最近的一半，避免内存无限增长
          rec.seen = new Map([...rec.seen.entries()].slice(-32))
        }
      }

      rec.count += 1
      if (rec.count >= limit) {
        rec.lockedUntil = now + policy.lockMs
        rec.count = 0
        rec.firstAt = now
        rec.seen = new Map()
        records.set(key, rec)
        return { locked: true, retryAfter: Math.ceil(policy.lockMs / 1000), remaining: 0, limit }
      }
      records.set(key, rec)
      return { locked: false, retryAfter: 0, remaining: limit - rec.count, limit }
    },

    /** 登录成功后清空该 key 的失败记录。 */
    reset(key) {
      records.delete(key)
    },

    /** 当前处于锁定状态的 key 数量（用于排查）。 */
    lockedCount(now = Date.now()) {
      let n = 0
      for (const rec of records.values()) if (rec.lockedUntil > now) n++
      return n
    },

    get size() {
      return records.size
    },
  }
}

/** 只允许站内相对路径，防开放重定向。 */
export function safeNext(next, fallback = '/') {
  if (typeof next !== 'string' || next === '') return fallback
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback
  if (next.includes('\n') || next.includes('\r')) return fallback
  return next
}
