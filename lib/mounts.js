import { statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hashScrypt, verifyHashed } from './hash.js'

/**
 * 子目录绑定：把某个 URL 前缀（比如 /abc）指向本机某个目录。
 *
 * 绑定表存在账号文件的 settings.mounts 里（后台每次改动都会落盘），
 * 请求处理时按最长前缀现查，所以加/删绑定**不需要重启**。
 */

/** 内置路由占用的前缀，绑上去只会被内置路由挡住，干脆提前拒绝。 */
const RESERVED = ['/admin', '/login', '/logout', '/healthz', '/whoami', '/api']

/** 展开 ~ / ~/xxx，相对路径按 cwd 解析。 */
export function expandDir(input, cwd = process.cwd()) {
  let dir = String(input ?? '').trim()
  if (dir === '~') dir = os.homedir() || '.'
  else if (dir.startsWith('~/')) dir = path.join(os.homedir() || '.', dir.slice(2))
  return path.resolve(cwd, dir)
}

/** 规范化绑定路径：必须 / 开头，去掉尾部斜杠，禁止 . / .. / 空格。
 *  allowRoot=true 时允许 '/'（后台的「默认目录」，等价于命令行 --root + --mount /）。 */
export function normalizeBindPath(input, { allowRoot = false } = {}) {
  let p = String(input ?? '').trim()
  if (!p) throw new Error('绑定路径不能为空，例如 /abc')
  if (!p.startsWith('/')) throw new Error('绑定路径必须以 / 开头，例如 /abc')
  if (p.includes('?') || p.includes('#')) throw new Error('绑定路径不能包含 ? 或 #')
  p = p.replace(/\/+$/, '')
  if (p === '') {
    if (allowRoot) return '/'
    throw new Error('根路径 / 请在上面的「默认目录」里设置（或命令行 --root / --mount）')
  }
  if (p.split('/').some((s) => s === '.' || s === '..')) throw new Error('绑定路径不能包含 . 或 ..')
  if (/\s/.test(p)) throw new Error('绑定路径不能包含空格')
  return p
}

/** 这个路径是不是内置接口在用。 */
export function isReservedMount(mount) {
  return RESERVED.some((r) => mount === r || mount.startsWith(`${r}/`))
}

/** 独立账号的用户名规则（跟主站账号一致）。 */
const BIND_USER_RE = /^[A-Za-z0-9._-]{1,32}$/
/** 独立账号的密码最少位数（跟主站账号一致）。 */
export const MIN_BIND_PASSWORD = 6

/**
 * 规范化子路径绑定的独立凭据。
 *
 * 两种输入都接受：
 *  - `{username, password}`：后台表单里的明文，进来就地 scrypt 哈希（只存哈希，不存明文）
 *  - `{username, algo, salt, hash}`：账号文件里存的记录，只校验格式
 *
 * @returns {{username: string, algo: string, salt?: string, hash: string}|null}
 */
export function normalizeBindingAuth(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') throw new Error('独立口令格式不正确')
  // 用户名可选：不填就是「只要密码」
  const username = String(raw.username ?? '').trim()
  if (username && !BIND_USER_RE.test(username)) {
    throw new Error('独立账号用户名只能是字母、数字、. _ -，1-32 位')
  }
  if (raw.password !== undefined) {
    if (String(raw.password).length < MIN_BIND_PASSWORD) {
      throw new Error(`独立口令的密码至少 ${MIN_BIND_PASSWORD} 位`)
    }
    // 没给用户名时也存空串，表示“只校验密码”
    return { username, ...hashScrypt(String(raw.password)) }
  }
  // 账号文件里的记录：只认 scrypt / sha256 两种哈希
  if (raw.algo !== 'scrypt' && raw.algo !== 'sha256') throw new Error('独立口令的密码哈希无法识别')
  if (typeof raw.hash !== 'string' || !/^[0-9a-f]+$/i.test(raw.hash)) throw new Error('独立口令的密码哈希无法识别')
  if (raw.algo === 'scrypt' && (typeof raw.salt !== 'string' || !/^[0-9a-f]+$/i.test(raw.salt))) {
    throw new Error('独立口令的密码哈希无法识别')
  }
  return { username, algo: raw.algo, salt: raw.salt, hash: raw.hash }
}

/**
 * 校验子路径绑定的独立口令。
 * 设了用户名就要对上；只设了密码（用户名为空）时忽略提交的用户名，只校验密码。
 */
export function verifyBindingAuth(binding, username, password) {
  const auth = binding?.auth
  if (!auth) return false
  if (auth.username && String(username ?? '') !== auth.username) return false
  return verifyHashed(auth, password)
}

/** 这个绑定是不是要求「账号 + 密码」（而不是只要密码）。 */
export function bindingNeedsUsername(binding) {
  return Boolean(binding?.auth?.username)
}

/**
 * 最近一次签发的分享链接信息（用来在后台显示有效期与结束时间，也方便再复制一次）。
 * 坏数据直接丢掉，不影响绑定本身。
 */
export function normalizeBindingShare(raw) {
  if (raw === undefined || raw === null || typeof raw !== 'object') return null
  const days = Number(raw.days)
  const expiresAt = Number(raw.expiresAt)
  const token = String(raw.token || '')
  if (!Number.isInteger(days) || days < 1 || days > 3650) return null
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null
  if (!token || token.length > 4096) return null
  return { days, expiresAt, token }
}

/**
 * 校验并规范化一条绑定。
 * @param {{mount?: string, root?: string, path?: string, dir?: string}} raw
 * @param {{cwd?: string, verifyDir?: boolean, allowRoot?: boolean}} [options]
 *   verifyDir=false 时只做结构校验（读旧配置用）；allowRoot=true 时允许绑定到 /
 * @returns {{mount: string, root: string}}
 */
export function normalizeBinding(raw, { cwd = process.cwd(), verifyDir = true, allowRoot = false } = {}) {
  const mount = normalizeBindPath(raw?.mount ?? raw?.path, { allowRoot })
  const root = expandDir(raw?.root ?? raw?.dir, cwd)
  if (isReservedMount(mount)) {
    throw new Error(`路径 ${mount} 是内置接口（/admin、/login、/api…），不能绑定目录`)
  }
  if (!root) throw new Error('目录不能为空')
  if (verifyDir) {
    let ok = false
    try {
      ok = statSync(root).isDirectory()
    } catch {
      ok = false
    }
    if (!ok) throw new Error(`目录不存在或不是目录: ${root}`)
  }
  // 独立账号：没有就给 null（跟主站共用一套认证）
  const auth = normalizeBindingAuth(raw.auth)
  const share = normalizeBindingShare(raw.share)
  const out = { mount, root }
  if (auth) out.auth = auth
  if (share) out.share = share
  return out
}

/**
 * 容错版：坏条目直接丢掉（账号文件被手改坏也不该让后台起不来），同路径只留第一条。
 * 目录此刻不存在也保留——外挂盘没挂上时应该先 404，而不是把绑定悄悄删掉。
 */
export function normalizeBindings(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const item of list) {
    let binding
    try {
      // 允许 '/'：后台可以设一个「默认目录」，不写命令行也能用
      binding = normalizeBinding(item, { verifyDir: false, allowRoot: true })
    } catch {
      continue
    }
    if (seen.has(binding.mount)) continue
    seen.add(binding.mount)
    out.push(binding)
  }
  return out
}

/** 按最长前缀匹配绑定；没有命中返回 null。'/' 是兜底绑定，长度最短，所以子路径总能赢过它。 */
export function matchBinding(urlPath, bindings) {
  if (!urlPath || !Array.isArray(bindings) || bindings.length === 0) return null
  let best = null
  for (const b of bindings) {
    if (!b?.mount) continue
    if (b.mount === '/' || urlPath === b.mount || urlPath.startsWith(`${b.mount}/`)) {
      if (!best || b.mount.length > best.mount.length) best = b
    }
  }
  return best
}

/** 绑定表里的默认目录（挂在 / 的那条）。 */
export function defaultBinding(bindings) {
  return (Array.isArray(bindings) ? bindings : []).find((b) => b?.mount === '/') || null
}
