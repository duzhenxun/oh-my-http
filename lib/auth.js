import { timingSafeEqual } from 'node:crypto'
import { sha256 } from './util.js'

/**
 * 常数时间比对用户名与密码（表单和 Basic 共用）。
 * @param {string} username
 * @param {string} password
 * @param {{username: string, passHash: Buffer|null}} cfg
 */
export function verifyUserPass(username, password, cfg) {
  if (!cfg || !cfg.passHash) return false
  // 先哈希再比较，长度一致，避免 timingSafeEqual 抛错并防止长度信息泄露
  const userOK = timingSafeEqual(sha256(username), sha256(cfg.username))
  const passOK = timingSafeEqual(sha256(password), cfg.passHash)
  return userOK && passOK
}

/**
 * 从 Basic 头里取出用户名与密码。
 * @returns {{username: string, password: string}|null}
 */
export function basicAuthCredentials(req) {
  const header = req?.headers?.authorization || ''
  if (typeof header !== 'string' || !/^basic /i.test(header)) return null
  let decoded
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
  } catch {
    return null
  }
  const sep = decoded.indexOf(':')
  if (sep === -1) return null
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) }
}

/**
 * 常数时间校验 Basic 认证凭据。
 * @param {import('node:http').IncomingMessage} req
 * @param {{username: string, passHash: Buffer|null}} cfg passHash 为 null 表示匿名模式
 * @returns {boolean}
 */
export function checkCredentials(req, cfg) {
  if (!cfg || !cfg.passHash) return false
  const creds = basicAuthCredentials(req)
  if (!creds) return false
  return verifyUserPass(creds.username, creds.password, cfg)
}

/** 把用户名密码编码成 Authorization 头值（方便客户端/测试使用）。 */
export function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}
