import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 默认去 npm 官方 registry 查最新版本。 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
/** 最多多久查一次（写进缓存，避免每次启动都联网）。 */
export const CHECK_INTERVAL_MS = 24 * 3600 * 1000

/** 解析 "1.2.3" / "v1.2.3" / "1.2.3-beta.1"；非法返回 null。 */
export function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null }
}

/**
 * 比较两个版本号。
 * @returns {number} a > b 返回 1，a < b 返回 -1，无法比较返回 0
 */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] > y[key] ? 1 : -1
  }
  // 1.0.0 比 1.0.0-beta 新
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre > y.pre ? 1 : -1
}

export const updateCacheFile = (stateDir) => path.join(stateDir, 'update-check.json')

export function readUpdateCache(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

export function writeUpdateCache(file, data) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 去 registry 查最新版本号。任何失败（离线 / 超时 / 404）都静默返回 null。
 */
export async function fetchLatestVersion({
  name,
  registry = DEFAULT_REGISTRY,
  timeoutMs = 3000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${String(registry).replace(/\/+$/, '')}/${encodeURIComponent(name)}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res || !res.ok) return null
    const data = await res.json()
    return typeof data?.version === 'string' && data.version ? data.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 带缓存的更新检查：默认 24 小时内只联网一次。
 *
 * @returns {Promise<{latest: string|null, newer: boolean, checkedAt: string|null, fromCache: boolean}>}
 */
export async function checkForUpdate({
  name,
  current,
  cacheFile,
  registry = DEFAULT_REGISTRY,
  timeoutMs = 3000,
  fetchImpl,
  now = Date.now(),
  force = false,
} = {}) {
  const cached = cacheFile && existsSync(cacheFile) ? readUpdateCache(cacheFile) : null
  const fresh = cached?.checkedAt && now - Date.parse(cached.checkedAt) < CHECK_INTERVAL_MS

  if (fresh && !force) {
    return {
      latest: cached.latest ?? null,
      newer: Boolean(cached.latest) && compareVersions(cached.latest, current) > 0,
      checkedAt: cached.checkedAt,
      fromCache: true,
    }
  }

  const latest = await fetchLatestVersion({ name, registry, timeoutMs, fetchImpl })
  const checkedAt = new Date(now).toISOString()
  if (cacheFile) writeUpdateCache(cacheFile, { checkedAt, latest, checkedBy: name, current })
  return {
    latest,
    newer: Boolean(latest) && compareVersions(latest, current) > 0,
    checkedAt,
    fromCache: false,
  }
}

/** 生成给用户看的升级提示（多行）。 */
export function upgradeHint({ name, current, latest, installCmd }) {
  const cmd = installCmd || `npm i -g ${name}`
  return [
    `有新版本可用：${current} → ${latest}`,
    `升级：${cmd}`,
  ]
}
