import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { sha256 } from './util.js'

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

/** 用 scrypt 加盐哈希一个密码（账号、子路径绑定的独立口令都用它）。 */
export function hashScrypt(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  })
  return { algo: 'scrypt', salt: salt.toString('hex'), hash: hash.toString('hex') }
}

/**
 * 校验密码与哈希记录是否匹配。
 * 兼容两种格式：scrypt（正常）与 sha256（早期 --pass-sha256 引导出来的账号）。
 *
 * @param {{algo?: string, salt?: string, hash: string}} record
 * @param {string} password
 */
export function verifyHashed(record, password) {
  if (!record || typeof record.hash !== 'string') return false
  const given = Buffer.from(String(password), 'utf8')
  if (record.algo === 'scrypt') {
    let expected
    try {
      expected = Buffer.from(record.hash, 'hex')
    } catch {
      return false
    }
    const derived = scryptSync(given, Buffer.from(String(record.salt || ''), 'hex'), expected.length, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
    })
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  }
  // 兼容 --pass-sha256 引导出来的账号
  const got = sha256(given.toString('utf8'))
  let expected
  try {
    expected = Buffer.from(record.hash, 'hex')
  } catch {
    return false
  }
  return got.length === expected.length && timingSafeEqual(got, expected)
}
