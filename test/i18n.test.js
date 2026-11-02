import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../lib/config.js'
import { createT, pickLang } from '../lib/i18n.js'
import { createServer, listen } from '../lib/server.js'

const FORM = { 'content-type': 'application/x-www-form-urlencoded' }
const form = (o) => new URLSearchParams(o).toString()

async function start(t, argv) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-i18n-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const usersFile = path.join(dir, 'users.json')
  const cfg = loadConfig([...argv, '--users-file', usersFile], {})
  const server = createServer(cfg)
  await listen(server, { host: '127.0.0.1', port: 0 })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { base: `http://127.0.0.1:${server.address().port}`, usersFile, dir }
}

test('语言选择：显式设置优先，auto 看 Accept-Language，兜底中文', () => {
  assert.equal(pickLang(undefined, undefined), 'zh')
  assert.equal(pickLang('auto', 'en-US,en;q=0.9'), 'en')
  assert.equal(pickLang('auto', 'zh-CN,zh;q=0.9'), 'zh')
  assert.equal(pickLang('auto', 'fr-FR'), 'zh')
  assert.equal(pickLang('en', 'zh-CN'), 'en')
  assert.equal(pickLang('zh', 'en-US'), 'zh')
  // 词典：同一个 key 两种语言都有
  assert.equal(createT('zh')('nav.accounts'), '账号管理')
  assert.equal(createT('en')('nav.accounts'), 'Accounts')
  // 占位符
  assert.equal(createT('en')('common.days', { n: 3 }), '3 days')
  assert.equal(createT('zh')('common.days', { n: 3 }), '3 天')
})

test('Accept-Language 决定登录页 / 目录列表的语言', async (t) => {
  const site = path.join(await mkdtemp(path.join(os.tmpdir(), 'ohmy-i18n-site-')), 'site')
  await writeFile(path.join(os.tmpdir(), 'noop'), '')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(site, { recursive: true })
  await writeFile(path.join(site, 'a.txt'), 'hi')

  const { base } = await start(t, ['--pass', 'p', '--root', site])

  // 默认（没有 Accept-Language）→ 中文
  const zh = await (await fetch(`${base}/login`)).text()
  assert.match(zh, /请输入用户名和密码/)

  const en = await (await fetch(`${base}/login`, { headers: { 'accept-language': 'en-US,en;q=0.9' } })).text()
  assert.match(en, /Enter your username and password/)
  assert.match(en, /Username/)
  assert.doesNotMatch(en, /请输入用户名和密码/)

  // 目录列表也跟着变
  const zhList = await (await fetch(`${base}/`)).text()
  assert.match(zhList, /修改时间/)
  const enList = await (await fetch(`${base}/`, { headers: { 'accept-language': 'en' } })).text()
  assert.match(enList, /Modified/)
  assert.match(enList, /Name/)
})

test('后台设置里切换语言：立即生效、登录页也跟着变、会持久化', async (t) => {
  const { base, usersFile } = await start(t, ['--pass', 'p', '--root', '.'])

  // 登录成管理员
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: FORM,
    body: form({ username: 'admin', password: 'p' }),
    redirect: 'manual',
  })
  const cookie = (login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie') || '').split(';')[0]
  const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text()
  assert.match(page, /账号管理/)
  assert.match(page, /switch|中文/) // 语言切换入口存在
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]

  // 切到英文
  const switched = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie, ...FORM },
    body: form({ csrf, action: 'set-lang', lang: 'en' }),
    redirect: 'manual',
  })
  assert.equal(switched.status, 303)

  const enAdmin = await (await fetch(`${base}/admin`, { headers: { cookie } })).text()
  assert.match(enAdmin, /Add an account/)
  assert.match(enAdmin, /Login protection/)
  assert.doesNotMatch(enAdmin, /添加账号/)

  const enBindings = await (await fetch(`${base}/admin/bindings`, { headers: { cookie } })).text()
  assert.match(enBindings, /Directory bindings/)
  assert.match(enBindings, /Default directory/)
  assert.match(enBindings, /Validity/)

  // 登录页（未登录）也是英文
  const enLogin = await (await fetch(`${base}/login`)).text()
  assert.match(enLogin, /Enter your username and password/)
  assert.match(enLogin, />Sign in</)

  // 落盘
  const saved = JSON.parse(await readFile(usersFile, 'utf8'))
  assert.equal(saved.settings.lang, 'en')

  // 再切回中文
  const csrf2 = /name="csrf" value="([^"]+)"/.exec(enAdmin)[1]
  await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie, ...FORM },
    body: form({ csrf: csrf2, action: 'set-lang', lang: 'zh' }),
    redirect: 'manual',
  })
  assert.match(await (await fetch(`${base}/login`)).text(), /请输入用户名和密码/)
})

test('语言设置非法的取值会被拒绝', async (t) => {
  const { base } = await start(t, ['--pass', 'p', '--root', '.'])
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: FORM,
    body: form({ username: 'admin', password: 'p' }),
    redirect: 'manual',
  })
  const cookie = (login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie') || '').split(';')[0]
  const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]

  const bad = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie, ...FORM },
    body: form({ csrf, action: 'set-lang', lang: 'fr' }),
    redirect: 'manual',
  })
  assert.equal(bad.status, 303)
  assert.equal(bad.headers.get('location'), '/admin?err=bad_request')
})
