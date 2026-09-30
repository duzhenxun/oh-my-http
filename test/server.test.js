import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { basicAuthHeader } from '../lib/auth.js'
import { loadConfig, normalizeMount } from '../lib/config.js'
import { createServer, explainAccess, listen } from '../lib/server.js'

async function start(t, argv, env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-acc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const argv2 = argv.includes('--users-file') ? argv : [...argv, '--users-file', path.join(dir, 'users.json')]
  const cfg = loadConfig(argv2, env)
  const server = createServer(cfg)
  await listen(server, { host: '127.0.0.1', port: 0 })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  return { cfg, server, base: `http://127.0.0.1:${port}` }
}

const AUTH = basicAuthHeader('admin', 'p')

// 单测不碰真实的账号文件
const load = (argv = [], env = {}) => loadConfig([...argv, '--users-file', 'none'], env)

test('不可信来源必须提供用户名密码', async (t) => {
  const { base } = await start(t, ['--pass', 'p', '--no-default-trusted', '--auth', 'basic'])

  const denied = await fetch(`${base}/whoami`)
  assert.equal(denied.status, 401)
  assert.match(denied.headers.get('www-authenticate') || '', /^Basic realm="oh-my-http"/)

  const wrong = await fetch(`${base}/whoami`, { headers: { authorization: basicAuthHeader('admin', 'nope') } })
  assert.equal(wrong.status, 401)

  const ok = await fetch(`${base}/whoami`, { headers: { authorization: AUTH } })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.authenticated, true)
  assert.equal(body.authenticated_by, 'password')
  assert.equal(body.trusted, false)
  assert.equal(body.ip, '127.0.0.1')
})

test('公共路径无需认证', async (t) => {
  const { base } = await start(t, ['--pass', 'p', '--no-default-trusted', '--public', '/healthz,/open.txt'])
  const health = await fetch(`${base}/healthz`)
  assert.equal(health.status, 200)
  assert.equal(await health.text(), 'ok\n')

  // 未列入 public 的路径依旧要认证
  assert.equal((await fetch(`${base}/open.txt`)).status, 404) // 404 而不是 401，说明已放行
  assert.equal((await fetch(`${base}/`)).status, 401)
})

test('内网来源自动免认证', async (t) => {
  const { base } = await start(t, ['--pass', 'p'])
  const res = await fetch(`${base}/whoami`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.trusted, true)
  assert.equal(body.authenticated_by, 'intranet-bypass')
  assert.equal((await fetch(`${base}/`)).status, 200)
})

test('外网伪造 X-Forwarded-For 无法绕过认证', async (t) => {
  const { base } = await start(t, ['--pass', 'p'])

  // 直连对端 127.0.0.1 可信，XFF 指向公网 => 判定为公网客户端 => 401
  const spoofed = await fetch(`${base}/whoami`, { headers: { 'x-forwarded-for': '8.8.8.8' } })
  assert.equal(spoofed.status, 401)

  // 同一个请求带上正确凭据后走「密码」通道，说明客户端确实被判定为公网地址
  const withCreds = await fetch(`${base}/whoami`, {
    headers: { 'x-forwarded-for': '8.8.8.8', authorization: AUTH },
  })
  assert.equal(withCreds.status, 200)
  assert.equal((await withCreds.json()).authenticated_by, 'password')

  // --no-xff 时忽略 XFF，直连对端可信即可免认证
  const { base: base2 } = await start(t, ['--pass', 'p', '--no-xff'])
  const noXff = await fetch(`${base2}/whoami`, { headers: { 'x-forwarded-for': '8.8.8.8' } })
  assert.equal(noXff.status, 200)
  assert.equal((await noXff.json()).authenticated_by, 'intranet-bypass')
})

test('自定义免认证网段生效', async (t) => {
  // 不信任 127.0.0.1，但显式信任 127.0.0.0/8 之外再说：这里反过来验证 --trusted 可放行
  const { base } = await start(t, ['--pass', 'p', '--no-default-trusted', '--trusted', '127.0.0.0/8'])
  assert.equal((await fetch(`${base}/whoami`)).status, 200)
})

test('/api/echo 回显请求，/unknown 返回 404', async (t) => {
  const { base } = await start(t, ['--pass', 'p'])
  const res = await fetch(`${base}/api/echo?x=1`, { method: 'POST', body: 'hello 世界' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.method, 'POST')
  assert.equal(body.path, '/api/echo')
  assert.equal(body.query, 'x=1')
  assert.equal(body.body, 'hello 世界')
  assert.equal(body.headers.authorization, undefined)

  assert.equal((await fetch(`${base}/nope`)).status, 404)
})

test('静态目录：文件下载、目录列表与穿越防护', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'sub'), { recursive: true })
  await writeFile(path.join(dir, 'hello.txt'), 'hi there')
  await writeFile(path.join(dir, 'sub', 'nested.txt'), 'nested')
  await writeFile(path.join(dir, '.env'), 'SECRET=1')
  const { base } = await start(t, ['--pass', 'p', '--root', dir])

  // 默认直接挂在根路径，不需要 /files 前缀
  const file = await fetch(`${base}/hello.txt`)
  assert.equal(file.status, 200)
  assert.equal(file.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(await file.text(), 'hi there')
  assert.equal((await fetch(`${base}/files/hello.txt`)).status, 404)

  // 目录浏览：根路径就是目录列表
  const index = await fetch(base)
  assert.equal(index.status, 200)
  assert.equal(index.headers.get('cache-control'), 'no-cache')
  const listing = await index.text()
  assert.match(listing, /hello\.txt/)
  assert.match(listing, /href="\/sub\/"/)
  assert.match(listing, /修改时间/)
  assert.match(listing, /8 B/)
  // 默认不列出也不允许访问隐藏文件
  assert.doesNotMatch(listing, /\.env/)
  assert.equal((await fetch(`${base}/.env`)).status, 404)

  // 子目录可逐级浏览，含 .. 返回上一级
  const sub = await (await fetch(`${base}/sub/`)).text()
  assert.match(sub, /nested\.txt/)
  assert.match(sub, /href="\/">\.\.<\/a>/)

  // 目录下的 index.html 优先于目录列表
  await writeFile(path.join(dir, 'sub', 'index.html'), '<h1>sub index</h1>')
  assert.match(await (await fetch(`${base}/sub/`)).text(), /sub index/)

  // 目录穿越必须被挡住
  for (const attack of ['/..%2f..%2fetc/hosts', '/%2e%2e%2f%2e%2e%2fetc%2fhosts', '/sub/..%2f..%2fetc/hosts']) {
    const escaped = await fetch(`${base}${attack}`)
    assert.ok([403, 404].includes(escaped.status), `${attack} 期望 403/404，实际 ${escaped.status}`)
  }

  // --hidden 可放开隐藏文件
  const shown = await start(t, ['--pass', 'p', '--root', dir, '--hidden'])
  assert.equal((await fetch(`${shown.base}/.env`)).status, 200)
  assert.match(await (await fetch(shown.base)).text(), /\.env/)

  // --mount /files 可以恢复前缀式访问
  const prefixed = await start(t, ['--pass', 'p', '--root', dir, '--mount', '/files'])
  assert.equal((await fetch(`${prefixed.base}/files/hello.txt`)).status, 200)
  assert.equal((await fetch(`${prefixed.base}/hello.txt`)).status, 404)

  // 未绑定目录时不暴露任何文件
  const { base: plain } = await start(t, ['--pass', 'p', '--no-files'])
  assert.equal((await fetch(`${plain}/hello.txt`)).status, 404)
})

test('不配置密码时可直接访问，且不会弹出无效的认证框', async (t) => {
  const { base } = await start(t, ['--no-default-trusted', '--no-files'])
  const res = await fetch(`${base}/whoami`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('www-authenticate'), null)
  assert.equal((await res.json()).authenticated_by, 'anonymous')
  assert.match(await (await fetch(`${base}/`)).text(), /未启用认证/)
})

test('目录位置参数与 --mount 组合', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-pos-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'hello.txt'), 'positional')

  const { base } = await start(t, ['--pass', 'p', dir, '--mount', '/'])
  assert.equal(await (await fetch(`${base}/hello.txt`)).text(), 'positional')
})

test('日志回调记录来源与判定结果', async (t) => {
  const cfg = load(['--pass', 'p', '--no-default-trusted'])
  const entries = []
  const server = createServer(cfg, { logger: (e) => entries.push(e) })
  await listen(server, { host: '127.0.0.1', port: 0 })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()

  await fetch(`http://127.0.0.1:${port}/whoami`)
  await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { authorization: AUTH } })

  assert.equal(entries.length, 2)
  assert.equal(entries[0].status, 401)
  assert.equal(entries[0].method, 'none')
  assert.equal(entries[0].ip, '127.0.0.1')
  assert.equal(entries[1].status, 200)
  assert.equal(entries[1].method, 'password')
  assert.ok(entries[1].durationMs >= 0)
})

test('--mount 可把绑定目录挂到任意路径甚至根路径', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-mount-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'report.txt'), 'quarterly')

  // 自定义挂载点
  const { base } = await start(t, ['--pass', 'p', '--root', dir, '--mount', '/share'])
  assert.equal(await (await fetch(`${base}/share/report.txt`)).text(), 'quarterly')
  assert.equal((await fetch(`${base}/files/report.txt`)).status, 404)
  assert.match(await (await fetch(`${base}/share/`)).text(), /report\.txt/)
  assert.match(await (await fetch(`${base}/`)).text(), /GET \/share\//)

  // 挂到根路径：整站变成文件浏览器，内置路由仍然优先
  const mounted = await start(t, ['--pass', 'p', '--root', dir, '--mount', '/'])
  assert.equal(await (await fetch(`${mounted.base}/report.txt`)).text(), 'quarterly')
  assert.equal((await fetch(`${mounted.base}/healthz`)).status, 200)
  assert.equal((await fetch(`${mounted.base}/whoami`)).status, 200)
  assert.equal((await fetch(`${mounted.base}/nope.txt`)).status, 404)
})

test('mount 配置校验', () => {
  assert.throws(() => load(['--pass', 'p', '--mount', 'files']), /必须以 \//)
  assert.throws(() => load(['--pass', 'p', '--mount', '/a/../b']), /不能包含/)
  assert.equal(normalizeMount('/files/'), '/files')
  assert.equal(normalizeMount('/'), '/')
  assert.equal(normalizeMount('//'), '/')
  // 默认挂在根路径；绑定目录后也可以单独指定 --mount
  assert.equal(load(['--pass', 'p']).mount, '/')
  assert.equal(load(['--pass', 'p', '--mount', '/share']).mount, '/share')
})

test('explainAccess 是纯函数，能解释某个 IP 会遇到什么', () => {
  const cfg = loadConfig(
    ['--pass', 'p', '--trusted', '203.0.113.0/24', '--public', '/healthz,/open'],
    {},
  )

  // 公共路径永远放行
  const pub = explainAccess('8.8.8.8', '/healthz', cfg)
  assert.equal(pub.allowed, true)
  assert.equal(pub.method, 'public')
  assert.equal(pub.requiresPassword, false)

  // 默认内网段免认证，并指出命中的是哪一条
  const lan = explainAccess('192.168.1.9', '/', cfg)
  assert.equal(lan.allowed, true)
  assert.equal(lan.method, 'intranet-bypass')
  assert.equal(lan.matched.text, '192.168.0.0/16')

  // 追加的网段同样生效
  const extra = explainAccess('203.0.113.9', '/', cfg)
  assert.equal(extra.method, 'intranet-bypass')
  assert.equal(extra.matched.text, '203.0.113.0/24')

  // 公网 IP 需要密码（allowed=false 表示没凭据时会被拦）
  const pub2 = explainAccess('8.8.8.8', '/', cfg)
  assert.equal(pub2.allowed, false)
  assert.equal(pub2.requiresPassword, true)
  assert.equal(pub2.method, 'password')
  assert.equal(pub2.matched, null)
  assert.match(pub2.reason, /需要登录/)

  // 未配置密码 => 全放行
  const anon = explainAccess('8.8.8.8', '/', load(['--pass', ''], { OHMY_PASS: undefined }))
  assert.equal(anon.method, 'anonymous')
  assert.equal(anon.allowed, true)
})

const cookieOf = (res) => {
  const raw = res.headers.getSetCookie?.() ?? []
  const first = raw[0] || res.headers.get('set-cookie') || ''
  return first.split(';')[0]
}

test('默认 form 模式：不弹窗口，跳登录页，登录后发 Cookie', async (t) => {
  const { base } = await start(t, ['--pass', 'p', '--no-default-trusted', '--root', '.'])

  // 浏览器式的请求被跳到登录页，而不是弹 Basic 认证框
  const denied = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  assert.equal(denied.status, 302)
  assert.equal(denied.headers.get('location'), '/login?next=%2F')
  assert.equal(denied.headers.get('www-authenticate'), null)

  // 非浏览器请求（curl / API）拿到 401，也不带 Basic 挑战
  const api = await fetch(`${base}/whoami`)
  assert.equal(api.status, 401)
  assert.equal(api.headers.get('www-authenticate'), null)

  // 登录页本身可访问
  const page = await fetch(`${base}/login`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /<form class="card" method="post" action="\/login">/)
  assert.match(html, /name="username"/)
  assert.match(html, /name="password"/)
  assert.equal(page.headers.get('cache-control'), 'no-store')

  // 密码错误
  const bad = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=nope',
  })
  assert.equal(bad.status, 401)
  assert.match(await bad.text(), /用户名或密码不正确/)

  // 密码正确 -> 303 + 会话 Cookie
  const ok = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=p&next=%2Fwhoami',
    redirect: 'manual',
  })
  assert.equal(ok.status, 303)
  assert.equal(ok.headers.get('location'), '/whoami')
  const setCookie = ok.headers.get('set-cookie')
  assert.match(setCookie, /^ohmy_session=/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  const cookie = cookieOf(ok)

  // 带 Cookie 就能访问，且记为 session
  const authed = await fetch(`${base}/whoami`, { headers: { cookie } })
  assert.equal(authed.status, 200)
  const body = await authed.json()
  assert.equal(body.authenticated_by, 'session')
  assert.equal(body.authenticated, true) // 会话已登录
  assert.equal(body.user, 'admin')
  assert.equal(body.role, 'admin')

  // 伪造 Cookie 无效
  assert.equal((await fetch(`${base}/whoami`, { headers: { cookie: 'ohmy_session=forged.x' } })).status, 401)

  // form 模式下 curl -u 依然可用
  const basic = await fetch(`${base}/whoami`, { headers: { authorization: AUTH } })
  assert.equal(basic.status, 200)
  assert.equal((await basic.json()).authenticated_by, 'password')

  // 退出登录清掉 Cookie
  const out = await fetch(`${base}/logout`, { redirect: 'manual', headers: { cookie } })
  assert.equal(out.status, 302)
  assert.equal(out.headers.get('location'), '/login')
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/)
})

test('form 模式：开放重定向被拦住，连续输错会被锁账号', async (t) => {
  const { base } = await start(t, ['--pass', 'p', '--no-default-trusted'])

  const evil = await fetch(`${base}/login`, {
    method: 'POST',
    headers: FORM,
    body: form({ username: 'admin', password: 'p', next: 'https://evil.com' }),
    redirect: 'manual',
  })
  assert.equal(evil.status, 303)
  assert.equal(evil.headers.get('location'), '/')

  // 同一个错误密码重复提交只算一次
  for (let i = 0; i < 5; i++) {
    const dup = await loginAs(base, 'admin', 'samewrong')
    assert.equal(dup.status, 401, '重复同一个错误密码不应该锁定')
  }

  // 换着密码猜 → 第 3 个不同密码时锁定（重复那个已经算了 1 次）
  assert.equal((await loginAs(base, 'admin', 'wrong-1')).status, 401, '第 2 个不同密码')
  const locked = await loginAs(base, 'admin', 'wrong-2')
  assert.equal(locked.status, 429)
  assert.ok(Number(locked.headers.get('retry-after')) > 3600 - 60)
  assert.match(await locked.text(), /失败次数过多/)

  // 锁定期内即使密码正确也进不去
  assert.equal((await loginAs(base, 'admin', 'p')).status, 429)
})

test('--auth basic 保留传统弹窗行为', async (t) => {
  const { base } = await start(t, ['--pass', 'p', '--no-default-trusted', '--auth', 'basic'])
  const res = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  assert.equal(res.status, 401)
  assert.match(res.headers.get('www-authenticate') || '', /^Basic realm=/)
  // basic 模式下没有登录页（Cookie 也不参与判定）
  assert.equal((await fetch(`${base}/login`)).status, 401)
  assert.equal((await fetch(`${base}/login`, { headers: { authorization: AUTH } })).status, 404)
  assert.equal((await fetch(`${base}/`, { headers: { authorization: AUTH } })).status, 200)
})

const form = (o) => new URLSearchParams(o).toString()
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }
const loginAs = (base, username, password, extra = {}) =>
  fetch(`${base}/login`, { method: 'POST', headers: FORM, body: form({ username, password, ...extra }), redirect: 'manual' })

test('管理员界面：创建账号、成员只能看文件、CSRF 防护', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-adm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'file.txt'), 'hello')
  const { base } = await start(t, ['--pass', 'p', '--no-default-trusted', '--root', dir])

  // 未登录访问后台 -> 跳登录页
  const anon = await fetch(`${base}/admin`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  assert.equal(anon.status, 302)
  assert.equal(anon.headers.get('location'), '/login?next=%2Fadmin')

  // admin 登录（由 --pass 引导）
  const adminCookie = cookieOf(await loginAs(base, 'admin', 'p'))
  const page = await fetch(`${base}/admin`, { headers: { cookie: adminCookie } })
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /账号管理/)
  assert.match(html, /添加账号/)
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1]
  assert.ok(csrf.length > 10)

  // 没有 CSRF token 的 POST 被拒
  const noCsrf = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie: adminCookie, ...FORM },
    body: form({ action: 'create', username: 'evil', password: 'evilpass' }),
    redirect: 'manual',
  })
  assert.equal(noCsrf.status, 303)
  assert.equal(noCsrf.headers.get('location'), '/admin?err=csrf')

  // 创建成员账号
  const created = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie: adminCookie, ...FORM },
    body: form({ csrf, action: 'create', username: 'bob', password: 'bobpass', role: 'member' }),
    redirect: 'manual',
  })
  assert.equal(created.headers.get('location'), '/admin?ok=created')
  assert.match(await (await fetch(`${base}/admin`, { headers: { cookie: adminCookie } })).text(), /bob/)

  // 重复创建 -> 提示已存在
  const dup = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie: adminCookie, ...FORM },
    body: form({ csrf, action: 'create', username: 'bob', password: 'bobpass' }),
    redirect: 'manual',
  })
  assert.equal(dup.headers.get('location'), '/admin?err=exists')

  // 弱密码被拒
  const weak = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie: adminCookie, ...FORM },
    body: form({ csrf, action: 'create', username: 'weak', password: '123' }),
    redirect: 'manual',
  })
  assert.equal(weak.headers.get('location'), '/admin?err=invalid_password')

  // 成员登录：能看文件，进不了后台
  const memberCookie = cookieOf(await loginAs(base, 'bob', 'bobpass'))
  assert.equal((await fetch(`${base}/file.txt`, { headers: { cookie: memberCookie } })).status, 200)
  const forbidden = await fetch(`${base}/admin`, { headers: { cookie: memberCookie } })
  assert.equal(forbidden.status, 403)
  assert.match(await forbidden.text(), /不是管理员/)

  // 成员也改了不账号（没权限，连 POST 都进不去）
  const memberPost = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie: memberCookie, ...FORM },
    body: form({ csrf, action: 'create', username: 'x1', password: 'x1pass' }),
    redirect: 'manual',
  })
  assert.equal(memberPost.status, 403)

  // 管理员重置 bob 的密码后，旧密码失效
  const reset = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie: adminCookie, ...FORM },
    body: form({ csrf, action: 'set-password', target: 'bob', password: 'newbobpw' }),
    redirect: 'manual',
  })
  assert.equal(reset.headers.get('location'), '/admin?ok=password')
  assert.equal((await loginAs(base, 'bob', 'bobpass', {})).status, 401)
  assert.equal((await loginAs(base, 'bob', 'newbobpw')).status, 303)

  // 不能删自己
  const selfDel = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie: adminCookie, ...FORM },
    body: form({ csrf, action: 'delete', target: 'admin' }),
    redirect: 'manual',
  })
  assert.equal(selfDel.headers.get('location'), '/admin?err=self_delete')

  // 禁用 bob 后无法登录
  await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie: adminCookie, ...FORM },
    body: form({ csrf, action: 'disable', target: 'bob' }),
    redirect: 'manual',
  })
  assert.equal((await loginAs(base, 'bob', 'newbobpw')).status, 401)

  // 管理员可以用 curl -u 直接调后台（Basic 也可以管理）
  const viaBasic = await fetch(`${base}/admin`, { headers: { authorization: AUTH } })
  assert.equal(viaBasic.status, 200)
})

test('“记住我” 决定 Cookie 保留时长', async (t) => {
  const { base } = await start(t, ['--pass', 'p', '--no-default-trusted'])

  const short = await loginAs(base, 'admin', 'p')
  const shortMax = Number(/Max-Age=(\d+)/.exec(short.headers.get('set-cookie'))[1])
  assert.equal(shortMax, 7 * 24 * 3600, '不勾选时用 --session-days')

  const long = await loginAs(base, 'admin', 'p', { remember: '1' })
  const longMax = Number(/Max-Age=(\d+)/.exec(long.headers.get('set-cookie'))[1])
  assert.equal(longMax, 365 * 24 * 3600, '勾选后用 --remember-days')
  assert.ok(longMax > shortMax)

  // 可自定义
  const { base: custom } = await start(t, ['--pass', 'p', '--no-default-trusted', '--session-days', '1', '--remember-days', '30'])
  const c1 = await loginAs(custom, 'admin', 'p')
  const c2 = await loginAs(custom, 'admin', 'p', { remember: '1' })
  assert.equal(Number(/Max-Age=(\d+)/.exec(c1.headers.get('set-cookie'))[1]), 24 * 3600)
  assert.equal(Number(/Max-Age=(\d+)/.exec(c2.headers.get('set-cookie'))[1]), 30 * 24 * 3600)

  // --remember-days 0 时登录页不提供选项
  const { base: off } = await start(t, ['--pass', 'p', '--no-default-trusted', '--remember-days', '0'])
  assert.doesNotMatch(await (await fetch(`${off}/login`)).text(), /记住我/)
})

test('会话在服务重启后仍然有效（密钥持久化）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-restart-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const usersFile = path.join(dir, 'users.json')

  const first = await start(t, ['--pass', 'p', '--no-default-trusted', '--users-file', usersFile])
  const cookie = cookieOf(await loginAs(first.base, 'admin', 'p', { remember: '1' }))
  assert.equal((await fetch(`${first.base}/whoami`, { headers: { cookie } })).status, 200)
  await new Promise((r) => first.server.close(r))

  // 同样的账号文件、新的进程
  const second = await start(t, ['--users-file', usersFile, '--no-default-trusted', '--host', '127.0.0.1'])
  const res = await fetch(`${second.base}/whoami`, { headers: { cookie } })
  assert.equal(res.status, 200, '重启后旧 Cookie 应该还能用')
  assert.equal((await res.json()).user, 'admin')
})

test('管理后台可改登录保护策略，保存后立即生效', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-set-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const usersFile = path.join(dir, 'users.json')
  const { base } = await start(t, ['--pass', 'p', '--no-default-trusted', '--root', dir, '--users-file', usersFile])

  const adminCookie = cookieOf(await loginAs(base, 'admin', 'p'))
  const html = await (await fetch(`${base}/admin`, { headers: { cookie: adminCookie } })).text()
  assert.match(html, /登录保护/)
  assert.match(html, /同一账号失败几次锁定/)
  assert.match(html, /同一 IP 失败几次锁定/)
  assert.match(html, /name="account_max_attempts"[^>]*value="3"/) // 默认只锁账号 3 次
  assert.match(html, /name="ip_max_attempts"[^>]*value="0"/) // 默认不锁 IP
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1]

  const post = (body) =>
    fetch(`${base}/admin/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, ...FORM },
      body: form({ csrf, action: 'save-settings', ...body }),
      redirect: 'manual',
    })

  // 收紧成：账号失败 1 次就锁 5 分钟
  const saved = await post({ account_max_attempts: '1', ip_max_attempts: '0', lockout_minutes: '5' })
  assert.equal(saved.headers.get('location'), '/admin?ok=settings')

  const first = await loginAs(base, 'admin', 'wrong')
  assert.equal(first.status, 429, '保存后立即生效')
  assert.equal(Number(first.headers.get('retry-after')), 300)

  // 页面上能看到锁定列表：对象、自动解锁时间、单独解锁按钮
  const after = await (await fetch(`${base}/admin`, { headers: { cookie: adminCookie } })).text()
  assert.match(after, /当前锁定 \/ 失败记录/)
  assert.match(after, /已锁定/)
  assert.match(after, /自动解锁/)
  assert.match(after, /立即解锁/)
  assert.match(after, /立即解除所有锁定/)

  // 一键解锁
  const unlocked = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie: adminCookie, ...FORM },
    body: form({ csrf, action: 'unlock' }),
    redirect: 'manual',
  })
  assert.equal(unlocked.headers.get('location'), '/admin?ok=unlocked')
  assert.equal((await loginAs(base, 'admin', 'p')).status, 303, '解锁后能正常登录')

  // 非法值被拒，且不会写坏原有设置
  const bad = await post({ account_max_attempts: '999', ip_max_attempts: '0', lockout_minutes: '5' })
  assert.equal(bad.headers.get('location'), '/admin?err=invalid_settings')
  assert.equal(Number((await loginAs(base, 'admin', 'wrong')).headers.get('retry-after')), 300, '仍然是 5 分钟')

  // 设置落盘：重启后仍然是刚才保存的值
  const restarted = await start(t, ['--no-default-trusted', '--root', dir, '--users-file', usersFile])
  const cookie2 = cookieOf(await loginAs(restarted.base, 'admin', 'p'))
  const html2 = await (await fetch(`${restarted.base}/admin`, { headers: { cookie: cookie2 } })).text()
  assert.match(html2, /name="account_max_attempts"[^>]*value="1"/)
  assert.match(html2, /name="lockout_minutes"[^>]*value="5"/)
})

test('命令行显式指定时优先于后台保存的设置', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-set2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const usersFile = path.join(dir, 'users.json')

  // 先在后台保存 5 分钟
  const first = await start(t, ['--pass', 'p', '--no-default-trusted', '--users-file', usersFile])
  const cookie = cookieOf(await loginAs(first.base, 'admin', 'p'))
  const html = await (await fetch(`${first.base}/admin`, { headers: { cookie } })).text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1]
  await fetch(`${first.base}/admin/users`, {
    method: 'POST',
    headers: { cookie, ...FORM },
    body: form({ csrf, action: 'save-settings', account_max_attempts: '1', ip_max_attempts: '0', lockout_minutes: '5' }),
    redirect: 'manual',
  })
  await new Promise((r) => first.server.close(r))

  // 再用命令行覆盖成账号 2 次 / 40 分钟
  const second = await start(t, [
    '--no-default-trusted',
    '--users-file', usersFile,
    '--account-max-attempts', '2',
    '--lockout-minutes', '40',
  ])
  const adminCookie = cookieOf(await loginAs(second.base, 'admin', 'p'))
  const page = await (await fetch(`${second.base}/admin`, { headers: { cookie: adminCookie } })).text()
  assert.match(page, /name="account_max_attempts"[^>]*value="2"/, '页面上显示的是命令行指定的值')
  assert.match(page, /name="lockout_minutes"[^>]*value="40"/)
  assert.match(page, /命令行参数/, '并提示被命令行覆盖')

  // 命令行策略生效：不同密码失败到第 2 次就锁 40 分钟
  assert.equal((await loginAs(second.base, 'admin', 'wrong-1')).status, 401)
  const lockedRes = await loginAs(second.base, 'admin', 'wrong-2')
  assert.equal(lockedRes.status, 429)
  assert.equal(Number(lockedRes.headers.get('retry-after')), 40 * 60)

  // 关键：已登录的会话不受锁定影响，否则连解锁都做不了
  const stillIn = await fetch(`${second.base}/admin`, { headers: { cookie: adminCookie } })
  assert.equal(stillIn.status, 200, '锁定期内已登录的管理员仍然能进后台')
  assert.match(await stillIn.text(), /立即解除所有锁定/)
})

test('锁定列表可见，重置密码 / 单独解锁都能解除锁定', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const usersFile = path.join(dir, 'users.json')
  const { base } = await start(t, ['--pass', 'p', '--no-default-trusted', '--users-file', usersFile])

  const adminCookie = cookieOf(await loginAs(base, 'admin', 'p'))
  const page = await (await fetch(`${base}/admin`, { headers: { cookie: adminCookie } })).text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]
  const post = (body) =>
    fetch(`${base}/admin/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, ...FORM },
      body: form({ csrf, ...body }),
      redirect: 'manual',
    })

  // 建一个成员 bob
  assert.equal((await post({ action: 'create', username: 'bob', password: 'bobpass', role: 'member' })).headers.get('location'), '/admin?ok=created')

  // bob 用 3 个不同密码失败 → 被锁
  for (const pw of ['bob-1', 'bob-2', 'bob-3']) await loginAs(base, 'bob', pw)
  assert.equal((await loginAs(base, 'bob', 'bobpass')).status, 429, '被锁了')

  // 后台能看到锁定列表：谁被锁、什么时候自动解锁
  const listed = await (await fetch(`${base}/admin`, { headers: { cookie: adminCookie } })).text()
  assert.match(listed, /当前锁定 \/ 失败记录/)
  assert.match(listed, /bob/)
  assert.match(listed, /已锁定/)
  assert.match(listed, /自动解锁/)
  assert.match(listed, /立即解锁/)
  assert.match(listed, /重置密码会自动解除该账号的锁定/)

  // 单独解锁这个 key
  const one = await post({ action: 'unlock-key', key: 'user:bob' })
  assert.equal(one.headers.get('location'), '/admin?ok=unlocked_one')
  assert.equal((await loginAs(base, 'bob', 'bobpass')).status, 303, '单独解锁后能登录')
  // 再点一次会提示已经不存在
  assert.equal((await post({ action: 'unlock-key', key: 'user:bob' })).headers.get('location'), '/admin?err=not_locked')

  // 再锁一次，然后用“重置密码”来解锁
  for (const pw of ['x-1', 'x-2', 'x-3']) await loginAs(base, 'bob', pw)
  assert.equal((await loginAs(base, 'bob', 'bobpass')).status, 429)
  const reset = await post({ action: 'set-password', target: 'bob', password: 'fresh-pw' })
  assert.equal(reset.headers.get('location'), '/admin?ok=password')
  assert.equal((await loginAs(base, 'bob', 'fresh-pw')).status, 303, '改完密码锁自动解除')
  const after = await (await fetch(`${base}/admin`, { headers: { cookie: adminCookie } })).text()
  assert.doesNotMatch(after, />已锁定</)

  // 默认只锁账号：同一个 IP 换不同用户名不会被锁
  const before = await (await fetch(`${base}/admin`, { headers: { cookie: adminCookie } })).text()
  for (let i = 0; i < 8; i++) {
    const res = await loginAs(base, `ghost${i}`, 'whatever')
    assert.equal(res.status, 401, '换个不存在的用户名不该锁（IP 维度默认关闭）')
  }
  const stillOk = await fetch(`${base}/admin`, { headers: { cookie: adminCookie } })
  assert.equal(stillOk.status, 200, '管理员不受影响')
  assert.match(await stillOk.text(), /账号管理/)
  void before
})

test('--pass 只在第一次建号时生效，之后忽略（不会覆盖后台改过的密码）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-boot-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const usersFile = path.join(dir, 'users.json')

  // 第一次：用 --pass 建号
  const first = await start(t, ['--pass', 'first-pw', '--no-default-trusted', '--users-file', usersFile])
  assert.equal((await loginAs(first.base, 'admin', 'first-pw')).status, 303)

  // 在后台把密码改掉
  const cookie = cookieOf(await loginAs(first.base, 'admin', 'first-pw'))
  const page = await (await fetch(`${first.base}/admin`, { headers: { cookie } })).text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]
  await fetch(`${first.base}/admin/users`, {
    method: 'POST',
    headers: { cookie, ...FORM },
    body: form({ csrf, action: 'set-password', target: 'admin', password: 'changed-in-ui' }),
    redirect: 'manual',
  })
  assert.equal((await loginAs(first.base, 'admin', 'changed-in-ui')).status, 303)
  await new Promise((r) => first.server.close(r))

  // 再用 --pass 启动：应该被忽略，不会把后台改的密码覆盖掉
  const second = await start(t, ['--pass', 'first-pw', '--no-default-trusted', '--users-file', usersFile])
  assert.equal(second.server.ohmy.store.bootstrapResult, 'ignored')
  assert.equal((await loginAs(second.base, 'admin', 'changed-in-ui')).status, 303, '后台改的密码仍然有效')
  assert.equal((await loginAs(second.base, 'admin', 'first-pw')).status, 401, '命令行密码被忽略')
  await new Promise((r) => second.server.close(r))

  // 想强制改回来得显式加 --reset-pass
  const third = await start(t, ['--pass', 'first-pw', '--reset-pass', '--no-default-trusted', '--users-file', usersFile])
  assert.equal(third.server.ohmy.store.bootstrapResult, 'updated')
  assert.equal((await loginAs(third.base, 'admin', 'first-pw')).status, 303)
})

test('--require-auth：没有账号时引导创建第一个管理员', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-setup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const usersFile = path.join(dir, 'users.json')

  // 本机是内网来源（默认信任 127.0.0.0/8），所以不用初始化口令
  const { base, server } = await start(t, ['--require-auth', '--users-file', usersFile])
  assert.equal(server.ohmy.cfg.authEnabled, true, '--require-auth 就算没账号也启用认证')
  assert.ok(server.ohmy.setupToken, '会生成一个初始化口令')

  const page = await (await fetch(`${base}/login`)).text()
  assert.match(page, /创建管理员/)
  assert.match(page, /还没有任何账号/)
  assert.doesNotMatch(page, /name="token"/, '内网来源不需要口令')

  const submit = (body) =>
    fetch(`${base}/login`, { method: 'POST', headers: FORM, body: form({ username: 'admin', ...body }), redirect: 'manual' })

  assert.equal((await submit({ password: 'short', confirm: 'short' })).status, 400, '密码太短')
  assert.equal((await submit({ password: 'first123', confirm: 'other12' })).status, 400, '两次不一致')

  const created = await submit({ password: 'first123', confirm: 'first123' })
  assert.equal(created.status, 303)
  const cookie = cookieOf(created)
  const who = await (await fetch(`${base}/whoami`, { headers: { cookie } })).json()
  assert.equal(who.user, 'admin', '会话被识别为用户 admin')
  assert.equal(who.role, 'admin')
  // 本机同时命中内网免认证，所以这里可能显示 intranet-bypass
  assert.ok(['session', 'intranet-bypass'].includes(who.authenticated_by))

  // 建完之后 /login 变回普通登录页，不能再走初始化
  const after = await (await fetch(`${base}/login`)).text()
  assert.doesNotMatch(after, /创建管理员/)
  assert.match(after, /请输入用户名和密码/)
  assert.equal((await submit({ password: 'x', confirm: 'x' })).status, 401, '此时只当普通登录处理')
})

test('--require-auth + 非内网来源：创建管理员必须带初始化口令', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-setup2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const usersFile = path.join(dir, 'users.json')
  const { base, server } = await start(t, ['--require-auth', '--no-default-trusted', '--users-file', usersFile])
  const token = server.ohmy.setupToken

  const page = await (await fetch(`${base}/login`)).text()
  assert.match(page, /name="token"/, '非内网来源要口令')

  const submit = (body) =>
    fetch(`${base}/login`, { method: 'POST', headers: FORM, body: form({ username: 'admin', password: 'first123', confirm: 'first123', ...body }), redirect: 'manual' })

  assert.equal((await submit({})).status, 401, '不带口令不能创建')
  assert.equal((await submit({ token: 'wrong-token' })).status, 401)
  assert.equal((await submit({ token })).status, 303, '带对口令才能创建')
  assert.equal(server.ohmy.store.count, 1)

  // 口令用完即失效
  assert.equal((await submit({ token, password: 'other123', confirm: 'other123' })).status, 401, '已经有账号了，不再是初始化流程')
})
