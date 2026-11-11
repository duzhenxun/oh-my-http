import { statSync } from 'node:fs'
import { CHECK_INTERVAL_MS, compareVersions, readUpdateCache, updateCacheFile } from './update.js'

/**
 * 服务端用的「有没有新版本」状态：**只读缓存，不联网**。
 *
 * 网络检查由 CLI 在启动时做（写完 update-check.json），这里只负责把结果给后台页面用。
 * 读取带 60 秒节流，避免每个请求都去 stat 文件。
 */
export function createUpdateState({
  current,
  stateDir,
  enabled = true,
  ttlMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const cacheFile = stateDir ? updateCacheFile(stateDir) : null
  let data = null
  let loadedAt = 0

  const load = (force = false) => {
    if (!enabled || !cacheFile) return null
    if (!force && data && now() - loadedAt < ttlMs) return data
    let mtime = 0
    try {
      mtime = statSync(cacheFile).mtimeMs
    } catch {
      data = null
      loadedAt = now()
      return null
    }
    // 文件没变就不重复解析
    if (!force && data && data.mtime === mtime) {
      loadedAt = now()
      return data
    }
    const cached = readUpdateCache(cacheFile)
    data = cached ? { ...cached, mtime } : null
    loadedAt = now()
    return data
  }

  return {
    /** 当前快照（同步，只看缓存）。 */
    get() {
      if (!enabled) return { current, latest: null, checkedAt: null, newer: false, enabled: false }
      const cached = load()
      const latest = cached?.latest || null
      return {
        current,
        latest,
        checkedAt: cached?.checkedAt || null,
        newer: Boolean(latest) && compareVersions(latest, current) > 0,
        enabled: true,
        /** 没检查过，或缓存里的检查时间已过 24 小时（后台可据此自动重查） */
        stale: !cached?.checkedAt || now() - Date.parse(cached.checkedAt) > CHECK_INTERVAL_MS,
      }
    },
    /** 丢弃内存里的一份，下次 get() 重新读文件（CLI 刷新缓存后可立刻生效）。 */
    invalidate() {
      data = null
      loadedAt = 0
    },
  }
}
