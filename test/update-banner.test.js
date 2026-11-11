import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../lib/config.js'
import { createServer, listen } from '../lib/server.js'
import { createUpdateState } from '../lib/update-state.js'
import { updateCacheFile } from '../lib/update.js'

const FORM = { 'content-type': 'application/x-www-form-urlencoded' }
const form = (o) => new URLSearchParams(o).toString()

async function start(t, argv = [], env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-upd-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cfg = loadConfig(['--pass', 'p', '--root', '.', '--users-file', path.join(dir, 'u.json'), ...argv], env)
  const server = createServer(cfg)
  await listen(server, { host: '127.0.0.1', port: 0 })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: FORM,
    body: form({ username: 'admin', password: 'p' }),
    redirect: 'manual',
  })
  const cookie = (login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie') || '').split(';')[0]
  const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]
  return { base, cookie, csrf, dir }
}

test('createUpdateState：只读缓存、判断新旧、失效与 stale', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-upds-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const empty = createUpdateState({ current: '0.4.0', stateDir: dir })
  assert.equal(empty.get().newer, false)
  assert.equal(empty.get().latest, null)

  await writeFile(updateCacheFile(dir), JSON.stringify({ checkedAt: new Date().toISOString(), latest: '0.5.0' }))
  const state = createUpdateState({ current: '0.4.0', stateDir: dir })
  assert.equal(state.get().latest, '0.5.0')
  assert.equal(state.get().newer, true)

  // 更旧的缓存：不提示
  await writeFile(updateCacheFile(dir), JSON.stringify({ checkedAt: new Date().toISOString(), latest: '0.3.9' }))
  const older = createUpdateState({ current: '0.4.0', stateDir: dir })
  assert.equal(older.get().newer, false)

  // 超过 24 小时 → stale（页面会给出「立即检查」入口）
  const longAgo = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
  await writeFile(updateCacheFile(dir), JSON.stringify({ checkedAt: longAgo, latest: '0.4.0' }))
  const stale = createUpdateState({ current: '0.4.0', stateDir: dir })
  assert.equal(stale.get().stale, true)
  assert.equal(stale.get().newer, false)

  // 关闭时永远不提示
  const off = createUpdateState({ current: '0.4.0', stateDir: dir, enabled: false })
  assert.equal(off.get().enabled, false)
  assert.equal(off.get().newer, false)
})

test('后台页面显示升级横幅（中英文都有）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-updc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(dir, { recursive: true })
  await writeFile(updateCacheFile(dir), JSON.stringify({ checkedAt: new Date().toISOString(), latest: '99.0.0' }))
  const cfg = loadConfig(['--pass', 'p', '--root', '.', '--users-file', path.join(dir, 'u.json'), '--state-dir', dir], {})
  const server = createServer(cfg)
  await listen(server, { host: '127.0.0.1', port: 0 })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const b2 = `http://127.0.0.1:${server.address().port}`
  const login = await fetch(`${b2}/login`, {
    method: 'POST',
    headers: FORM,
    body: form({ username: 'admin', password: 'p' }),
    redirect: 'manual',
  })
  const c2 = (login.headers.getSetCookie?.()[0] || '').split(';')[0]
  const html = await (await fetch(`${b2}/admin`, { headers: { cookie: c2 } })).text()
  assert.match(html, /有新版本 99\.0\.0/)
  assert.match(html, /npm i -g oh-my-http@latest/)
  assert.match(html, /立即检查更新/)
  assert.match(html, /releases/)

  const bindings = await (await fetch(`${b2}/admin/bindings`, { headers: { cookie: c2 } })).text()
  assert.match(bindings, /有新版本 99\.0\.0/, '绑定页也要显示')

  // 英文界面下横幅是英文
  const page = await (await fetch(`${b2}/admin`, { headers: { cookie: c2 } })).text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]
  await fetch(`${b2}/admin/users`, {
    method: 'POST',
    headers: { cookie: c2, ...FORM },
    body: form({ csrf, action: 'set-lang', lang: 'en' }),
    redirect: 'manual',
  })
  const en = await (await fetch(`${b2}/admin`, { headers: { cookie: c2 } })).text()
  assert.match(en, /Version 99\.0\.0 is available/)
  assert.match(en, /Check for updates/)
})

test('点「立即检查更新」会去查 registry 并刷新横幅', async (t) => {
  const registry = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: '99.9.9' }))
  })
  await new Promise((r) => registry.listen(0, '127.0.0.1', r))
  t.after(() => registry.close())
  const regUrl = `http://127.0.0.1:${registry.address().port}`

  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-updd-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cfg = loadConfig(
    ['--pass', 'p', '--root', '.', '--users-file', path.join(dir, 'u.json'), '--state-dir', dir],
    { OHMY_REGISTRY: regUrl },
  )
  const server = createServer(cfg)
  await listen(server, { host: '127.0.0.1', port: 0 })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: FORM,
    body: form({ username: 'admin', password: 'p' }),
    redirect: 'manual',
  })
  const cookie = (login.headers.getSetCookie?.()[0] || '').split(';')[0]

  const before = await (await fetch(`${base}/admin`, { headers: { cookie } })).text()
  assert.doesNotMatch(before, /有新版本/, '还没检查过就不该提示')
  const csrf = /name="csrf" value="([^"]+)"/.exec(before)[1]

  const run = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie, ...FORM },
    body: form({ csrf, action: 'check-update' }),
    redirect: 'manual',
  })
  assert.equal(run.headers.get('location'), '/admin?ok=update_checked')

  const after = await (await fetch(`${base}/admin`, { headers: { cookie } })).text()
  assert.match(after, /有新版本 99\.9\.9/)

  // 缓存写进了状态目录
  const { readFile } = await import('node:fs/promises')
  const cached = JSON.parse(await readFile(updateCacheFile(dir), 'utf8'))
  assert.equal(cached.latest, '99.9.9')
})

test('缓存缺失/过期时，打开后台会自动查一次（无需手动点）', async (t) => {
  const registry = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: '88.0.0' }))
  })
  await new Promise((r) => registry.listen(0, '127.0.0.1', r))
  t.after(() => registry.close())

  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-upde-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cfg = loadConfig(
    ['--pass', 'p', '--root', '.', '--users-file', path.join(dir, 'u.json'), '--state-dir', dir],
    { OHMY_REGISTRY: `http://127.0.0.1:${registry.address().port}` },
  )
  const server = createServer(cfg)
  await listen(server, { host: '127.0.0.1', port: 0 })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: FORM,
    body: form({ username: 'admin', password: 'p' }),
    redirect: 'manual',
  })
  const cookie = (login.headers.getSetCookie?.()[0] || '').split(';')[0]

  // 第一次打开后台：渲染时还没有缓存，同时触发后台检查
  const first = await (await fetch(`${base}/admin`, { headers: { cookie } })).text()
  assert.doesNotMatch(first, /有新版本/, '第一次访问时检查还没回来')

  // 等后台检查写入缓存，再打开一次就能看到横幅
  let html = ''
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50))
    html = await (await fetch(`${base}/admin`, { headers: { cookie } })).text()
    if (/有新版本 88\.0\.0/.test(html)) break
  }
  assert.match(html, /有新版本 88\.0\.0/, '自动检查后应出现横幅')
})
