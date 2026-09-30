import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_TRUSTED,
  clientIP,
  ipToNumber,
  isTrusted,
  matchPrefix,
  normalizeIP,
  parsePrefix,
  prefixContains,
} from '../lib/ip.js'

const trusted = DEFAULT_TRUSTED.map(parsePrefix)

test('normalizeIP 处理映射地址与 zone id', () => {
  assert.equal(normalizeIP('::ffff:127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeIP(' 10.0.0.1 '), '10.0.0.1')
  assert.equal(normalizeIP('fe80::1%en0'), 'fe80::1')
  assert.equal(normalizeIP(''), null)
  assert.equal(normalizeIP(undefined), null)
})

test('ipToNumber 支持 IPv4 / IPv6 / 内嵌 IPv4', () => {
  assert.deepEqual(ipToNumber('0.0.0.1').value, 1n)
  assert.deepEqual(ipToNumber('255.255.255.255').value, 2n ** 32n - 1n)
  assert.equal(ipToNumber('::1').value, 1n)
  assert.equal(ipToNumber('::ffff:192.168.1.1').value, ipToNumber('192.168.1.1').value)
  assert.equal(ipToNumber('2001:db8::1').family, 6)
  assert.equal(ipToNumber('not-an-ip'), null)
  assert.equal(ipToNumber('1.2.3.256'), null)
  assert.equal(ipToNumber('::gggg'), null)
})

test('parsePrefix 接受 CIDR 与裸 IP', () => {
  assert.deepEqual(
    { family: parsePrefix('10.0.0.0/8').family, prefixLen: parsePrefix('10.0.0.0/8').prefixLen },
    { family: 4, prefixLen: 8 },
  )
  assert.equal(parsePrefix('192.168.1.5').prefixLen, 32)
  assert.equal(parsePrefix('::1').prefixLen, 128)
  assert.equal(parsePrefix('10.0.0.0/33'), null)
  assert.equal(parsePrefix('10.0.0.0/-1'), null)
  assert.equal(parsePrefix('abc/8'), null)
})

test('prefixContains 按家族与网段匹配', () => {
  const lan = parsePrefix('192.168.0.0/16')
  assert.equal(prefixContains(lan, '192.168.31.7'), true)
  assert.equal(prefixContains(lan, '192.169.0.1'), false)
  assert.equal(prefixContains(lan, '::ffff:192.168.1.1'), true) // 映射地址先归一化
  assert.equal(prefixContains(lan, '::1'), false) // 家族不同
  assert.equal(prefixContains(parsePrefix('2001:db8::/32'), '2001:db8:1234::9'), true)
  assert.equal(prefixContains(parsePrefix('2001:db8::/32'), '2001:db9::1'), false)
})

test('isTrusted 覆盖默认内网范围', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '172.31.255.254', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isTrusted(ip, trusted), true, `${ip} 应可信`)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1', '2001:db8::1', '2606:4700::1111']) {
    assert.equal(isTrusted(ip, trusted), false, `${ip} 不应可信`)
  }
  assert.equal(isTrusted('garbage', trusted), false)
})

test('matchPrefix 返回命中的网段，便于排查配置', () => {
  assert.equal(matchPrefix('10.1.2.3', trusted).text, '10.0.0.0/8')
  assert.equal(matchPrefix('192.168.5.5', trusted).text, '192.168.0.0/16')
  assert.equal(matchPrefix('8.8.8.8', trusted), null)
  assert.equal(matchPrefix('garbage', trusted), null)
  // 自定义网段优先级不受顺序影响，能正确命中
  const custom = [parsePrefix('203.0.113.0/24'), ...trusted]
  assert.equal(matchPrefix('203.0.113.9', custom).text, '203.0.113.0/24')
})

const makeReq = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })

test('clientIP 在直连对端可信时才采信 XFF', () => {
  // 可信代理 + XFF 指向公网 => 真实客户端是公网地址
  const viaProxy = clientIP(makeReq('127.0.0.1', { 'x-forwarded-for': '8.8.8.8' }), { trusted })
  assert.equal(viaProxy.ip, '8.8.8.8')
  assert.equal(viaProxy.viaProxy, true)

  // 不可信对端伪造 XFF 无效，仍按对端判定
  const spoofed = clientIP(makeReq('8.8.8.8', { 'x-forwarded-for': '127.0.0.1' }), { trusted })
  assert.equal(spoofed.ip, '8.8.8.8')
  assert.equal(spoofed.viaProxy, false)

  // 多级代理：从右往左跳过可信节点
  const chain = clientIP(
    makeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9, 10.0.0.5, 192.168.1.2' }),
    { trusted },
  )
  assert.equal(chain.ip, '203.0.113.9')

  // 关闭 XFF 后只看直连对端
  const off = clientIP(makeReq('127.0.0.1', { 'x-forwarded-for': '8.8.8.8' }), {
    trusted,
    honorXFF: false,
  })
  assert.equal(off.ip, '127.0.0.1')
  assert.equal(off.viaProxy, false)

  // 对端可信但没有转发头时，不应报 viaProxy
  const plain = clientIP(makeReq('127.0.0.1'), { trusted })
  assert.equal(plain.ip, '127.0.0.1')
  assert.equal(plain.viaProxy, false)

  // 头部存在但内容非法时同样不报 viaProxy
  const junk = clientIP(makeReq('127.0.0.1', { 'x-forwarded-for': 'unknown' }), { trusted })
  assert.equal(junk.ip, '127.0.0.1')
  assert.equal(junk.viaProxy, false)
})
