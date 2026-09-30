import assert from 'node:assert/strict'
import test from 'node:test'
import { accountKey, createLoginThrottle, createSessionStore, parseCookies, safeNext, serializeCookie } from '../lib/session.js'

test('parseCookies / serializeCookie', () => {
  const jar = parseCookies('a=1; ohmy_session=abc%3Ddef; empty=')
  assert.equal(jar.a, '1')
  assert.equal(jar.ohmy_session, 'abc=def')
  assert.equal(jar.empty, '')
  assert.deepEqual(parseCookies(''), {})
  assert.deepEqual(parseCookies(undefined), {})

  const c = serializeCookie('s', 'v', { maxAge: 60, secure: true })
  assert.match(c, /^s=v; Path=\/; Max-Age=60; HttpOnly; SameSite=Lax; Secure$/)
  assert.match(serializeCookie('s', '', { maxAge: 0 }), /Max-Age=0/)
})

test('会话 token 可签发可校验，且能识别篡改与过期', () => {
  const store = createSessionStore({ secret: Buffer.alloc(32, 7), ttlMs: 1000 })
  const now = 1_700_000_000_000

  const token = store.issue('admin', now)
  assert.equal(store.verify(token, now).username, 'admin')
  assert.equal(store.verify(token, now + 999).username, 'admin')
  assert.equal(store.verify(token, now + 1000), null) // 过期
  assert.equal(store.verify('garbage', now), null)
  assert.equal(store.verify('', now), null)
  assert.equal(store.verify(undefined, now), null)

  // 篡改 payload 后签名对不上
  const [, mac] = token.split('.')
  const forged = `${Buffer.from(JSON.stringify({ u: 'admin', exp: now + 10_000 })).toString('base64url')}.${mac}`
  assert.equal(store.verify(forged, now), null)

  // 篡改签名
  const [body] = token.split('.')
  assert.equal(store.verify(`${body}.AAAA`, now), null)

  // 换一个密钥（模拟服务重启）旧 token 失效
  const other = createSessionStore({ secret: Buffer.alloc(32, 8), ttlMs: 1000 })
  assert.equal(other.verify(token, now), null)

  // 两次签发的 token 不同（含随机数）
  assert.notEqual(store.issue('admin', now), store.issue('admin', now))
})

test('默认只锁账号：同一个 IP 换用户名不会锁', () => {
  const throttle = createLoginThrottle({ lockMs: 3600_000 }) // 默认 accountMaxAttempts=3, ipMaxAttempts=0
  const t0 = 1_700_000_000_000
  assert.equal(throttle.accountMaxAttempts, 3)
  assert.equal(throttle.ipMaxAttempts, 0, '默认不按 IP 锁')

  // 同一个 IP 连续换 10 个用户名，都不应该锁（否则隧道/反代后面会误伤一整片人）
  for (let i = 0; i < 10; i++) {
    const ipHit = throttle.fail('1.2.3.4', t0, `fp-ip-${i}`)
    assert.equal(ipHit.locked, false, `第 ${i + 1} 次不该锁`)
  }
  assert.equal(throttle.check('1.2.3.4', t0).allowed, true)

  // 但同一个账号会被锁
  const a1 = throttle.fail(accountKey('admin'), t0, 'fp-a1')
  assert.equal(a1.remaining, 2)
  throttle.fail(accountKey('admin'), t0, 'fp-a2')
  const a3 = throttle.fail(accountKey('admin'), t0, 'fp-a3')
  assert.equal(a3.locked, true)
  assert.equal(a3.retryAfter, 3600)
  assert.equal(throttle.check(accountKey('admin'), t0 + 60_000).retryAfter, 3540)
  // 其它账号不受影响
  assert.equal(throttle.check(accountKey('bob'), t0).allowed, true)
  // 一小时后自动解锁，且重新给满次数
  const after = throttle.check(accountKey('admin'), t0 + 3600_000 + 1)
  assert.equal(after.allowed, true)
  assert.equal(after.remaining, 3)
})

test('同一个错误密码重复提交只算一次（防浏览器缓存凭据把自己锁死）', () => {
  const throttle = createLoginThrottle({ lockMs: 3600_000 })
  const t0 = 1_700_000_000_000
  const key = accountKey('admin')

  // 模拟一次页面加载里十几个请求都带着同一个错的 Basic 凭据
  let last
  for (let i = 0; i < 15; i++) last = throttle.fail(key, t0 + i, 'same-wrong-credential')
  assert.equal(last.duplicate, true)
  assert.equal(last.locked, false)
  assert.equal(last.remaining, 2, '只应该算 1 次失败')

  // 换一个错误密码才会累加
  assert.equal(throttle.fail(key, t0 + 20, 'other-credential').remaining, 1)
  assert.equal(throttle.fail(key, t0 + 30, 'third-credential').locked, true)
})

test('可选：打开 IP 维度后按 IP 锁', () => {
  const throttle = createLoginThrottle({ ipMaxAttempts: 2, accountMaxAttempts: 0, lockMs: 1000 })
  const t0 = 1000
  assert.equal(throttle.ipMaxAttempts, 2)
  assert.equal(throttle.fail('1.2.3.4', t0, 'a').locked, false)
  const hit = throttle.fail('1.2.3.4', t0, 'b')
  assert.equal(hit.locked, true)
  assert.equal(throttle.check('1.2.3.4', t0).allowed, false)
  assert.equal(throttle.check('5.6.7.8', t0).allowed, true)
})

test('可以关掉锁定', () => {
  const throttle = createLoginThrottle({ accountMaxAttempts: 0, ipMaxAttempts: 0, lockMs: 0 })
  assert.equal(throttle.disabled, true)
  for (let i = 0; i < 10; i++) assert.equal(throttle.fail(accountKey('admin'), 1000, `f${i}`).locked, false)
  assert.equal(throttle.check(accountKey('admin'), 1000).allowed, true)
})

test('锁定快照与解锁（后台要能看到“什么时候自动解锁”）', () => {
  const throttle = createLoginThrottle({ lockMs: 3600_000 })
  const t0 = 1_700_000_000_000

  // 一个账号被锁
  for (const fp of ['a', 'b', 'c']) throttle.fail(accountKey('admin'), t0, fp)
  // 另一个账号失败但没锁
  throttle.fail(accountKey('bob'), t0, 'x')

  const snap = throttle.snapshot(t0 + 60_000)
  const adminRow = snap.find((r) => r.target === 'admin')
  assert.equal(adminRow.locked, true)
  assert.equal(adminRow.kind, 'account')
  assert.equal(adminRow.retryAfter, 3540)
  assert.equal(adminRow.lockedUntil, new Date(t0 + 3600_000).toISOString())
  const bobRow = snap.find((r) => r.target === 'bob')
  assert.equal(bobRow.locked, false)
  assert.equal(bobRow.failures, 1)

  // 单独解锁一个 key
  assert.equal(throttle.unlock(accountKey('admin')), true)
  assert.equal(throttle.check(accountKey('admin'), t0).allowed, true)
  assert.equal(throttle.unlock(accountKey('nobody')), false)
  assert.equal(throttle.lockedCount(t0), 0)

  // 全部清空
  for (const fp of ['a', 'b', 'c']) throttle.fail(accountKey('admin'), t0, fp)
  assert.equal(throttle.clear(), 2) // admin + bob
  assert.deepEqual(throttle.snapshot(t0), [])
})

test('safeNext 只放行站内相对路径', () => {
  assert.equal(safeNext('/files/a.txt'), '/files/a.txt')
  assert.equal(safeNext('/a?b=1'), '/a?b=1')
  assert.equal(safeNext('//evil.com/x'), '/')
  assert.equal(safeNext('https://evil.com'), '/')
  assert.equal(safeNext('\\\\evil.com'), '/')
  assert.equal(safeNext('/a\r\nSet-Cookie: x=1'), '/')
  assert.equal(safeNext('', '/fallback'), '/fallback')
  assert.equal(safeNext(null, '/fallback'), '/fallback')
})

test('策略可以在运行时改（管理后台保存后立即生效）', () => {
  const throttle = createLoginThrottle({ accountMaxAttempts: 3, lockMs: 3600_000 })
  const t0 = 1_000
  assert.deepEqual(throttle.policy, { accountMaxAttempts: 3, ipMaxAttempts: 0, lockMs: 3600_000 })

  // 收紧到 1 次即锁、锁 5 分钟
  throttle.setPolicy({ accountMaxAttempts: 1, lockoutMinutes: 5 })
  assert.equal(throttle.accountMaxAttempts, 1)
  assert.equal(throttle.lockoutMinutes, 5)
  assert.equal(throttle.fail(accountKey('admin'), t0, 'fp1').locked, true)
  assert.equal(throttle.check(accountKey('admin'), t0).retryAfter, 300)

  // 改策略会清掉旧锁，避免旧策略的锁残留
  throttle.setPolicy({ accountMaxAttempts: 3, lockoutMinutes: 60 })
  assert.equal(throttle.check(accountKey('admin'), t0).allowed, true)

  // 两个维度都关掉
  throttle.setPolicy({ accountMaxAttempts: 0, ipMaxAttempts: 0 })
  assert.equal(throttle.disabled, true)
  for (let i = 0; i < 5; i++) assert.equal(throttle.fail(accountKey('admin'), t0, `f${i}`).locked, false)

  // 手动解锁
  throttle.setPolicy({ accountMaxAttempts: 2, lockoutMinutes: 10 })
  throttle.fail(accountKey('admin'), t0, 'a')
  throttle.fail(accountKey('admin'), t0, 'b')
  assert.equal(throttle.lockedCount(t0), 1)
  assert.equal(throttle.clear(), 1)
  assert.equal(throttle.lockedCount(t0), 0)
})
