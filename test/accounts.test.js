import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAccountStore } from '../lib/accounts.js'
import { sha256 } from '../lib/util.js'

const tmpFile = async (t, name = 'users.json') => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-acc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return path.join(dir, name)
}

test('账号存储：创建、校验、列表', async (t) => {
  const file = await tmpFile(t)
  const store = createAccountStore({ file })

  assert.equal(store.count, 0)
  await store.create({ username: 'alice', password: 'secret1', role: 'member' })
  await store.create({ username: 'admin', password: 'secret2', role: 'admin' })

  assert.equal(store.count, 2)
  assert.deepEqual(
    store.list().map((u) => u.username),
    ['admin', 'alice'],
  )
  assert.equal(store.roleOf('admin'), 'admin')
  assert.equal(store.verify('alice', 'secret1'), true)
  assert.equal(store.verify('alice', 'wrong'), false)
  assert.equal(store.verify('nobody', 'secret1'), false)
  assert.equal(store.verify('alice', ''), false)

  // 密码不落盘明文，落盘是 scrypt 哈希
  const raw = await readFile(file, 'utf8')
  assert.doesNotMatch(raw, /secret1/)
  const parsed = JSON.parse(raw)
  assert.equal(parsed.users.find((u) => u.username === 'alice').algo, 'scrypt')
  assert.match(parsed.sessionSecret, /^[0-9a-f]{64}$/)
  // 文件权限 0600
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('账号存储：用户名与密码规则', async (t) => {
  const store = createAccountStore({ file: await tmpFile(t) })
  await assert.rejects(() => store.create({ username: 'a b', password: 'secret1' }), /用户名只能/)
  await assert.rejects(() => store.create({ username: '', password: 'secret1' }), /用户名只能/)
  await assert.rejects(() => store.create({ username: 'a'.repeat(33), password: 'secret1' }), /用户名只能/)
  await assert.rejects(() => store.create({ username: 'ok', password: 'short' }), /密码至少/)
  await assert.rejects(() => store.create({ username: 'ok', password: 'secret1', role: 'root' }), /角色只能是/)
  await store.create({ username: 'ok', password: 'secret1' })
  await assert.rejects(() => store.create({ username: 'ok', password: 'secret1' }), /已存在/)
})

test('账号存储：改密码 / 角色 / 禁用，且至少留一个管理员', async (t) => {
  const store = createAccountStore({ file: await tmpFile(t) })
  await store.create({ username: 'admin', password: 'secret1', role: 'admin' })
  await store.create({ username: 'bob', password: 'secret2' })

  await store.setPassword('bob', 'newsecret')
  assert.equal(store.verify('bob', 'newsecret'), true)
  assert.equal(store.verify('bob', 'secret2'), false)

  await store.setRole('bob', 'admin')
  assert.equal(store.roleOf('bob'), 'admin')
  await store.setRole('bob', 'member')

  // 唯一的管理员不能被降级 / 禁用 / 删除
  await assert.rejects(() => store.setRole('admin', 'member'), /至少要保留/)
  await assert.rejects(() => store.setDisabled('admin', true), /至少要保留/)
  await assert.rejects(() => store.remove('admin'), /至少要保留/)

  await store.setDisabled('bob', true)
  assert.equal(store.verify('bob', 'newsecret'), false) // 禁用后不能登录
  const record = store.get('bob')
  assert.equal(record.disabled, true)
  assert.equal(record.hash.length > 0, true) // 密码哈希保留

  await store.setDisabled('bob', false)
  assert.equal(store.verify('bob', 'newsecret'), true)

  // 有第二个管理员后就可以动了
  await store.create({ username: 'carol', password: 'secret3', role: 'admin' })
  await store.remove('admin')
  assert.equal(store.get('admin'), null)
  await assert.rejects(() => store.remove('ghost'), /不存在/)
})

test('账号存储：重启后账号与会话密钥都还在', async (t) => {
  const file = await tmpFile(t)
  const first = createAccountStore({ file, bootstrap: { username: 'admin', password: 'secret1' } })
  assert.equal(first.count, 1)
  assert.equal(first.verify('admin', 'secret1'), true)
  const secret = first.sessionSecret.toString('hex')
  await first.create({ username: 'bob', password: 'secret2' })

  const second = createAccountStore({ file })
  assert.equal(second.count, 2)
  assert.equal(second.verify('bob', 'secret2'), true)
  assert.equal(second.sessionSecret.toString('hex'), secret, '会话密钥必须持久化，否则重启后所有人掉线')
})

test('账号存储：--pass-sha256 引导的旧哈希也能登录，但标记为待升级', async (t) => {
  const file = await tmpFile(t)
  const store = createAccountStore({ file, bootstrap: { username: 'admin', passHash: sha256('legacy1') } })
  assert.equal(store.verify('admin', 'legacy1'), true)
  assert.equal(store.verify('admin', 'nope'), false)
  assert.equal(store.needsUpgrade('admin'), true)

  await store.setPassword('admin', 'fresh12')
  assert.equal(store.needsUpgrade('admin'), false)
  assert.equal(store.verify('admin', 'fresh12'), true)
  assert.equal(store.verify('admin', 'legacy1'), false)
})

test('账号存储：文件损坏时报错而不是清空账号', async (t) => {
  const file = await tmpFile(t)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, '{ this is not json')
  const store = createAccountStore({ file })
  assert.ok(store.loadError)
  assert.match(store.loadError.message, /无法解析/)
  assert.equal(store.count, 0)
})

test('账号存储：不指定文件时只在内存里', async (t) => {
  const store = createAccountStore({ file: null, bootstrap: { username: 'admin', password: 'secret1' } })
  assert.equal(store.count, 1)
  assert.equal(store.verify('admin', 'secret1'), true)
  await store.create({ username: 'bob', password: 'secret2' })
  assert.equal(store.count, 2) // persist() 是 no-op，不报错
})

test('后台可保存的设置：会持久化、会校验', async (t) => {
  const file = await tmpFile(t)
  const a = createAccountStore({ file })
  assert.equal(a.settings, null, '没保存过就是 null（用命令行/默认值）')

  await a.saveSettings({ accountMaxAttempts: 5, ipMaxAttempts: 20, lockoutMinutes: 30 })
  assert.deepEqual(a.settings, { accountMaxAttempts: 5, ipMaxAttempts: 20, lockoutMinutes: 30 })

  // 重启后还在
  const b = createAccountStore({ file })
  assert.deepEqual(b.settings, { accountMaxAttempts: 5, ipMaxAttempts: 20, lockoutMinutes: 30 })

  // 部分更新会合并
  await a.saveSettings({ accountMaxAttempts: 0 })
  assert.deepEqual(a.settings, { accountMaxAttempts: 0, ipMaxAttempts: 20, lockoutMinutes: 30 })

  // 非法值拒绝
  await assert.rejects(() => a.saveSettings({ accountMaxAttempts: 999 }), /失败次数应为/)
  await assert.rejects(() => a.saveSettings({ ipMaxAttempts: 1.5 }), /失败次数应为/)
  await assert.rejects(() => a.saveSettings({ lockoutMinutes: -1 }), /锁定时长/)
  assert.deepEqual(a.settings, { accountMaxAttempts: 0, ipMaxAttempts: 20, lockoutMinutes: 30 }, '失败不应改坏已保存的设置')
})
