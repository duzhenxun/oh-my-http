import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { sha256 } from './util.js'

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }
const USERNAME_RE = /^[A-Za-z0-9._-]{1,32}$/
const MIN_PASSWORD = 6
export const MAX_LOGIN_ATTEMPTS = 100
export const MAX_LOCKOUT_MINUTES = 10080

/** 规范化后台可改的设置。 */
export function normalizeSettings(raw = {}) {
  // 兼容早期版本存下来的键名（那时只有 IP 维度的阈值）
  if (raw.loginMaxAttempts !== undefined && raw.accountMaxAttempts === undefined) {
    raw = { ...raw, accountMaxAttempts: raw.loginMaxAttempts }
  }
  const out = {}
  for (const key of ['accountMaxAttempts', 'ipMaxAttempts']) {
    if (raw[key] === undefined) continue
    const n = Number(raw[key])
    if (!Number.isInteger(n) || n < 0 || n > MAX_LOGIN_ATTEMPTS) {
      throw new Error(`${key === 'ipMaxAttempts' ? 'IP 维度' : '账号维度'}失败次数应为 0-${MAX_LOGIN_ATTEMPTS} 的整数（0 表示不锁）`)
    }
    out[key] = n
  }
  if (raw.lockoutMinutes !== undefined) {
    const n = Number(raw.lockoutMinutes)
    if (!Number.isFinite(n) || n < 0 || n > MAX_LOCKOUT_MINUTES) {
      throw new Error(`锁定时长应为 0-${MAX_LOCKOUT_MINUTES} 分钟（0 表示关闭锁定）`)
    }
    out.lockoutMinutes = Math.round(n)
  }
  return out
}

export const ROLES = ['admin', 'member']

/** 用户名规则（供表单与 CLI 共用）。 */
export function validUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name)
}

/** 密码强度要求：至少 6 位。 */
export function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= MIN_PASSWORD
}

export { MIN_PASSWORD }

function hashScrypt(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return { algo: 'scrypt', salt: salt.toString('hex'), hash: hash.toString('hex') }
}

function verifyOne(record, password) {
  const given = Buffer.from(String(password), 'utf8')
  if (record.algo === 'scrypt') {
    let expected
    try {
      expected = Buffer.from(record.hash, 'hex')
    } catch {
      return false
    }
    const derived = scryptSync(given, Buffer.from(record.salt, 'hex'), expected.length, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
    })
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  }
  // 兼容 --pass-sha256 引导出来的账号
  const got = sha256(given.toString('utf8'))
  const expected = Buffer.from(record.hash, 'hex')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

/**
 * 账号存储：内存里保存全部账号，写盘时原子替换。
 * 只有变更类操作是 async；认证路径（verify/get/list）是同步的。
 *
 * @param {{file: string|null, bootstrap?: {username: string, password?: string, passHash?: Buffer} | null}} options
 */
export function createAccountStore({ file = null, bootstrap = null } = {}) {
  /** @type {Map<string, object>} */
  const users = new Map()
  let loadError = null
  /** 会话签名密钥，随账号文件一起持久化，这样重启后登录状态仍然有效 */
  let sessionSecret = randomBytes(32)
  let secretPersisted = false
  /** 可在管理后台修改的设置（登录保护策略等） */
  let settings = null

  if (file && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const u of raw.users || []) {
        if (u && typeof u.username === 'string') users.set(u.username, u)
      }
      if (typeof raw.sessionSecret === 'string' && /^[0-9a-f]{64}$/i.test(raw.sessionSecret)) {
        sessionSecret = Buffer.from(raw.sessionSecret, 'hex')
        secretPersisted = true
      }
      if (raw.settings && typeof raw.settings === 'object') settings = normalizeSettings(raw.settings)
    } catch (err) {
      loadError = new Error(`账号文件无法解析: ${file} (${err.message})`)
    }
  }

  const store = {
    file,

    get sessionSecret() {
      return sessionSecret
    },

    get bootstrapResult() {
      return bootstrapResult
    },

    get loadError() {
      return loadError
    },

    /** 后台里保存过的设置；没保存过则为 null（用命令行 / 默认值）。 */
    get settings() {
      return settings ? { ...settings } : null
    },

    /** 保存设置（登录保护策略等）。 */
    async saveSettings(next) {
      const merged = normalizeSettings({ ...(settings || {}), ...next })
      settings = merged
      await store.persist()
      return { ...merged }
    },

    get count() {
      return users.size
    },

    list() {
      return [...users.values()].sort((a, b) => a.username.localeCompare(b.username))
    },

    get(username) {
      return users.get(username) || null
    },

    roleOf(username) {
      return users.get(username)?.role || null
    },

    /** 校验用户名密码。 */
    verify(username, password) {
      const record = users.get(username)
      if (!record || record.disabled) return false
      if (!verifyOne(record, password)) return false
      record.lastLoginAt = new Date().toISOString()
      void store.persist()
      return true
    },

    /** 是否是明文密码无法还原的老格式（sha256），提示用管理员界面重置。 */
    needsUpgrade(username) {
      return users.get(username)?.algo === 'sha256'
    },

    adminCount() {
      let n = 0
      for (const u of users.values()) if (u.role === 'admin' && !u.disabled) n++
      return n
    },

    async create({ username, password, role = 'member' }) {
      if (!validUsername(username)) throw new Error('用户名只能包含字母、数字、. _ -，长度 1-32')
      if (users.has(username)) throw new Error(`用户 ${username} 已存在`)
      if (!validPassword(password)) throw new Error(`密码至少 ${MIN_PASSWORD} 位`)
      if (!ROLES.includes(role)) throw new Error(`角色只能是 ${ROLES.join(' / ')}`)
      const now = new Date().toISOString()
      users.set(username, { username, role, disabled: false, createdAt: now, updatedAt: now, ...hashScrypt(password) })
      await store.persist()
      return users.get(username)
    },

    async remove(username) {
      const record = users.get(username)
      if (!record) throw new Error(`用户 ${username} 不存在`)
      if (record.role === 'admin' && store.adminCount() <= 1) {
        throw new Error('至少要保留一个管理员账号')
      }
      users.delete(username)
      await store.persist()
    },

    async setPassword(username, password) {
      const record = users.get(username)
      if (!record) throw new Error(`用户 ${username} 不存在`)
      if (!validPassword(password)) throw new Error(`密码至少 ${MIN_PASSWORD} 位`)
      Object.assign(record, hashScrypt(password), { updatedAt: new Date().toISOString() })
      await store.persist()
    },

    async setRole(username, role) {
      const record = users.get(username)
      if (!record) throw new Error(`用户 ${username} 不存在`)
      if (!ROLES.includes(role)) throw new Error(`角色只能是 ${ROLES.join(' / ')}`)
      if (record.role === 'admin' && role !== 'admin' && store.adminCount() <= 1) {
        throw new Error('至少要保留一个管理员账号')
      }
      record.role = role
      record.updatedAt = new Date().toISOString()
      await store.persist()
    },

    async setDisabled(username, disabled) {
      const record = users.get(username)
      if (!record) throw new Error(`用户 ${username} 不存在`)
      if (disabled && record.role === 'admin' && store.adminCount() <= 1) {
        throw new Error('至少要保留一个可用管理员账号')
      }
      record.disabled = Boolean(disabled)
      record.updatedAt = new Date().toISOString()
      await store.persist()
    },

    async persist() {
      if (!file) return
      const dir = path.dirname(file)
      mkdirSync(dir, { recursive: true })
      const payload = JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          sessionSecret: sessionSecret.toString('hex'),
          settings: settings || {},
          users: store.list(),
        },
        null,
        2,
      )
      const tmp = `${file}.${process.pid}.tmp`
      closeSync(openSync(tmp, 'w', 0o600))
      writeFileSync(tmp, `${payload}\n`, { mode: 0o600 })
      renameSync(tmp, file)
      secretPersisted = true
    },
  }

  /**
   * 用 --pass / --user 引导第一个管理员账号的结果：
   * 'created'（首次建号）| 'updated'（加了 --reset-pass 强制覆盖）
   * | 'ignored'（账号已存在，忽略 --pass，避免把后台改过的密码覆盖掉）| 'none'
   */
  let bootstrapResult = 'none'

  // 用 --pass / --user 引导出第一个管理员账号（没有账号文件时只存在内存里）
  if (bootstrap?.username) {
    const record = users.get(bootstrap.username)
    const material = bootstrap.password
      ? hashScrypt(bootstrap.password)
      : bootstrap.passHash
        ? { algo: 'sha256', hash: Buffer.from(bootstrap.passHash).toString('hex') }
        : null
    if (material && record && !bootstrap.overwrite) {
      // 账号已存在：默认不动它的密码（可能在后台改过了），只提示
      bootstrapResult = 'ignored'
    } else if (material) {
      const now = new Date().toISOString()
      users.set(bootstrap.username, {
        username: bootstrap.username,
        role: 'admin',
        disabled: false,
        createdAt: record?.createdAt || now,
        updatedAt: now,
        ...material,
      })
      bootstrapResult = record ? 'updated' : 'created'
      if (file) {
        const dir = path.dirname(file)
        mkdirSync(dir, { recursive: true })
        const tmp = `${file}.${process.pid}.init`
        writeFileSync(
          tmp,
          `${JSON.stringify(
            { version: 1, updatedAt: now, sessionSecret: sessionSecret.toString('hex'), users: store.list() },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        )
        renameSync(tmp, file)
        secretPersisted = true
      }
    }
  }

  // 已有账号但缺少会话密钥：补一个并落盘
  if (file && users.size > 0 && !secretPersisted) {
    void store.persist()
  }

  return store
}
