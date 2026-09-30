import { createHash } from 'node:crypto'

/** sha256 摘要（Buffer）。 */
export function sha256(input) {
  return createHash('sha256').update(String(input), 'utf8').digest()
}

/** 返回第一个非空字符串。 */
export function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

/** 把多个 "a,b" / ["a", "b"] 展开成去空的字符串数组。 */
export function splitList(values) {
  const out = []
  for (const v of values || []) {
    if (v === undefined || v === null) continue
    for (const part of String(v).split(',')) {
      const s = part.trim()
      if (s) out.push(s)
    }
  }
  return out
}

/** 从 "host:port" / "[::1]:port" 中取出主机部分。 */
export function splitHostPort(addr) {
  if (typeof addr !== 'string') return { host: null, port: null }
  const m = /^\[(.+)\]:(\d+)$/.exec(addr)
  if (m) return { host: m[1], port: Number(m[2]) }
  const idx = addr.lastIndexOf(':')
  if (idx === -1) return { host: addr, port: null }
  return { host: addr.slice(0, idx), port: Number(addr.slice(idx + 1)) || null }
}
