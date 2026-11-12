import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAccountStore } from '../lib/accounts.js'
import { basicAuthHeader } from '../lib/auth.js'
import { loadConfig } from '../lib/config.js'
import { createServer, listen } from '../lib/server.js'

const AUTH = basicAuthHeader('admin', 'p')

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-reload-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const siteA = path.join(dir, 'a')
  const siteB = path.join(dir, 'b')
  await mkdir(siteA, { recursive: true })
  await mkdir(siteB, { recursive: true })
  await writeFile(path.join(siteA, 'file.txt'), 'from a')
  await writeFile(path.join(siteB, 'file.txt'), 'from b')
  const usersFile = path.join(dir, 'users.json')

  const cfg = loadConfig(['--pass', 'p', '--auth', 'basic', '--root', siteA, '--users-file', usersFile, '--no-default-trusted'], {})
  const server = createServer(cfg)
  await listen(server, { host: '127.0.0.1', port: 0 })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { dir, siteB, usersFile, cfg, server, base: `http://127.0.0.1:${server.address().port}` }
}

const get = (base, p, headers = {}) => fetch(`${base}${p}`, { headers: { authorization: AUTH, ...headers } })

test('reload：重新读取账号文件里的账号与目录绑定，不用重启', async (t) => {
  const { siteB, usersFile, server, base } = await setup(t)

  assert.equal(await (await get(base, '/file.txt')).text(), 'from a')
  assert.equal((await get(base, '/b/file.txt')).status, 404)

  // 外部改账号文件：加一条绑定 + 一个新账号
  const store = createAccountStore({ file: usersFile, bootstrap: null })
  await store.saveSettings({ mounts: [{ mount: '/b', root: siteB }] })
  await store.create({ username: 'bob', password: 'bobpass', role: 'member' })

  const result = server.ohmy.reload()
  assert.equal(result.ok, true)
  assert.equal(result.users, 2) // admin + bob
  assert.equal(result.bindings, 1)

  // 新绑定立即生效
  assert.equal(await (await get(base, '/b/file.txt')).text(), 'from b')
  // 新账号也能登录
  const bob = await get(base, '/whoami', { authorization: basicAuthHeader('bob', 'bobpass') })
  assert.equal(bob.status, 200)
  assert.equal((await bob.json()).user, 'bob')
  // 老账号还在
  assert.equal((await get(base, '/whoami')).status, 200)
})

test('reload：账号文件坏了就报错，且不影响正在运行的实例', async (t) => {
  const { usersFile, server, base } = await setup(t)
  await writeFile(usersFile, '{ this is not json')

  const result = server.ohmy.reload()
  assert.equal(result.ok, false)
  assert.match(result.error, /无法解析/)

  // 旧配置仍然可用
  assert.equal(await (await get(base, '/file.txt')).text(), 'from a')
})

test('listen 会挂 SIGHUP（reload），close 后摘掉', async (t) => {
  const before = process.listenerCount('SIGHUP')
  const { server } = await setup(t)
  assert.equal(process.listenerCount('SIGHUP'), before + 1)
  await new Promise((resolve) => server.close(resolve))
  assert.equal(process.listenerCount('SIGHUP'), before)
})
