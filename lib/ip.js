import net from 'node:net'

/**
 * 默认免认证的网络：回环 / RFC1918 私网 / 链路本地 / IPv6 ULA / CGNAT。
 * 可用 --trusted 追加，或用 --no-default-trusted 清空。
 */
export const DEFAULT_TRUSTED = [
  '127.0.0.0/8', // IPv4 回环
  '::1/128', // IPv6 回环
  '10.0.0.0/8', // RFC1918
  '172.16.0.0/12', // RFC1918
  '192.168.0.0/16', // RFC1918
  '169.254.0.0/16', // IPv4 链路本地
  'fe80::/10', // IPv6 链路本地
  'fc00::/7', // IPv6 ULA
  '100.64.0.0/10', // RFC6598，k8s / CGNAT 常用
]

/** 去掉 zone id 与 IPv4-mapped IPv6 前缀，返回规范字符串；非法输入返回 null。 */
export function normalizeIP(ip) {
  if (typeof ip !== 'string') return null
  let s = ip.trim()
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7)
  return s || null
}

function ipv4ToBigInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out = (out << 8n) | BigInt(n)
  }
  return out
}

function ipv6ToBigInt(ip) {
  const halves = ip.split('::')
  if (halves.length > 2) return null

  const expand = (chunk) => {
    if (chunk === '') return []
    const groups = chunk.split(':')
    const out = []
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]
      if (g.includes('.')) {
        // 内嵌 IPv4，只允许出现在最后一组
        if (i !== groups.length - 1) return null
        const v4 = ipv4ToBigInt(g)
        if (v4 === null) return null
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn))
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }

  const head = expand(halves[0])
  if (head === null) return null
  let groups
  if (halves.length === 1) {
    groups = head
  } else {
    const tail = expand(halves[1])
    if (tail === null) return null
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    groups = [...head, ...new Array(fill).fill(0), ...tail]
  }
  if (groups.length !== 8) return null

  let out = 0n
  for (const g of groups) out = (out << 16n) | BigInt(g)
  return out
}

/** IP -> { value: BigInt, family: 4|6, bits: 32|128 }；非法返回 null。 */
export function ipToNumber(ip) {
  const s = normalizeIP(ip)
  if (!s) return null
  if (net.isIPv4(s)) {
    const value = ipv4ToBigInt(s)
    return value === null ? null : { value, family: 4, bits: 32, text: s }
  }
  if (net.isIPv6(s)) {
    const value = ipv6ToBigInt(s)
    return value === null ? null : { value, family: 6, bits: 128, text: s }
  }
  return null
}

/** 解析 "10.0.0.0/8" 或裸 "10.1.2.3"，返回带上限掩码的 prefix；非法返回 null。 */
export function parsePrefix(input) {
  const raw = String(input).trim()
  const slash = raw.indexOf('/')
  const ipPart = slash === -1 ? raw : raw.slice(0, slash)
  const parsed = ipToNumber(ipPart)
  if (!parsed) return null

  let prefixLen = parsed.bits
  if (slash !== -1) {
    const n = Number(raw.slice(slash + 1))
    if (!Number.isInteger(n) || n < 0 || n > parsed.bits) return null
    prefixLen = n
  }
  const hostBits = BigInt(parsed.bits - prefixLen)
  const value = (parsed.value >> hostBits) << hostBits
  return { value, prefixLen, family: parsed.family, bits: parsed.bits, text: raw }
}

/** ip 是否落在 prefix 内。 */
export function prefixContains(prefix, ip) {
  const parsed = ipToNumber(ip)
  if (!parsed || parsed.family !== prefix.family) return false
  const hostBits = BigInt(parsed.bits - prefix.prefixLen)
  return (parsed.value >> hostBits) << hostBits === prefix.value
}

/** ip 是否属于任一段可信网络。 */
export function isTrusted(ip, prefixes) {
  return matchPrefix(ip, prefixes) !== null
}

/** 返回第一个命中的可信网段，没命中返回 null（用于排查配置）。 */
export function matchPrefix(ip, prefixes) {
  for (const p of prefixes || []) {
    if (prefixContains(p, ip)) return p
  }
  return null
}

/** 取直连对端 IP。 */
export function peerIP(req) {
  const raw = req?.socket?.remoteAddress || req?.connection?.remoteAddress || ''
  return normalizeIP(raw)
}

/**
 * 解析真实客户端 IP。
 *
 * X-Forwarded-For 只在「直连对端本身可信」时才被采信，因此外网客户端无法通过
 * 伪造头部混进免认证通道。链路上从右向左找第一个不可信地址作为客户端。
 *
 * @returns {{ip: string|null, peer: string|null, viaProxy: boolean}}
 */
export function clientIP(req, { trusted = [], honorXFF = true } = {}) {
  const peer = peerIP(req)
  if (!honorXFF || !peer || !isTrusted(peer, trusted)) {
    return { ip: peer, peer, viaProxy: false }
  }

  const chain = []
  const raw = req.headers?.['x-forwarded-for']
  const values = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const v of values) {
    for (const part of String(v).split(',')) {
      const ip = normalizeIP(part)
      if (ip && net.isIP(ip)) chain.push(ip)
    }
  }
  // 没有可用的转发信息时，仍然按直连对端处理
  if (chain.length === 0) {
    return { ip: peer, peer, viaProxy: false }
  }
  chain.push(peer)

  let client = peer
  for (let i = chain.length - 1; i >= 0; i--) {
    client = chain[i]
    if (!isTrusted(client, trusted)) break
  }
  return { ip: client, peer, viaProxy: true }
}
