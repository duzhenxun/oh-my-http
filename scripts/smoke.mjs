#!/usr/bin/env node
/**
 * 端到端冒烟测试：真的把 bin 拉起来，用 http 请求逐项验证。
 *
 *   npm run smoke
 *
 * 与 npm test（单元测试）互补：这里验证的是「装完之后跑起来是什么行为」。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isAlive } from '../lib/runtime.js'

const bin = fileURLToPath(new URL('../bin/oh-my-http.js', import.meta.url))
const workdir = path.join(os.tmpdir(), 'oh-my-http-smoke')
const USERS_FILE = path.join(workdir, 'accounts.json')
const STATE_DIR = path.join(workdir, 'state')
const PASSWORD = 's3cret'
const AUTH = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }
const form = (o) => new URLSearchParams(o).toString()
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0]

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

let passed = 0
let failed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ${green('✓')} ${name}${detail ? dim(`  ${detail}`) : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ${red('✗')} ${name}${detail ? `  ${red(detail)}` : ''}`)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function startServer(args, env, cwd) {
  // 测试一律用临时账号文件，别碰真实的 ~/.oh-my-http/users.json
  const withArgs = withForeground(args)
  const full = withArgs.includes('--users-file') ? withArgs : [...withArgs, '--users-file', USERS_FILE]
  const child = spawn(process.execPath, [bin, ...full], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OHMY_STATE_DIR: STATE_DIR, ...(env || {}) },
    cwd,
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const port = args[args.indexOf('--port') + 1]
  const base = `http://127.0.0.1:${port}`

  const deadline = Date.now() + 5000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`服务提前退出:\n${out}`)
    try {
      const res = await fetch(`${base}/healthz`)
      if (res.ok) break
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`等待服务启动超时:\n${out}`)
    await new Promise((r) => setTimeout(r, 50))
  }
  return { child, base, stop: () => child.kill('SIGTERM') }
}

/** 测试里不希望它自己跑后台去（会变成孤儿进程），统一加前台参数。 */
function withForeground(args) {
  if (args.some((a) => a === '-d' || a === '--daemon' || a === '-f' || a === '--foreground')) return args
  return [...args, '--foreground']
}

async function run(args, env) {
  // 一律用临时账号文件 + 临时状态目录，别碰用户真实的家目录
  const base = withForeground(args)
  const full = base.includes('--users-file') ? base : [...base, '--users-file', USERS_FILE]
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...full], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OHMY_STATE_DIR: STATE_DIR, ...env },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 15_000)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
  return res
}

/** 跑 stop / status / restart 这类子命令（不注入 --users-file，命令解析是严格的）。 */
function runCmd(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OHMY_STATE_DIR: STATE_DIR, ...env },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

// ---------------------------------------------------------------------------

console.log('\n准备示例目录 ...')
await rm(workdir, { recursive: true, force: true })
await mkdir(path.join(workdir, 'docs', '2025'), { recursive: true })
await mkdir(path.join(workdir, '照片'), { recursive: true })
await writeFile(path.join(workdir, 'docs', 'report.txt'), 'quarterly result')
await writeFile(path.join(workdir, 'docs', '2025', 'summary.md'), '# summary')
await writeFile(path.join(workdir, '照片', 'index.html'), '<h1>photo index</h1>')
await writeFile(path.join(workdir, 'big.bin'), Buffer.alloc(256 * 1024, 3))
await writeFile(path.join(workdir, '.env'), 'SECRET=1')

// --- 1. CLI 本身 ---------------------------------------------------------
console.log('\n1. CLI 行为')
{
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const v = await run(['--version'])
  check('--version 输出包版本', v.stdout.trim() === `oh-my-http ${pkg.version}`, v.stdout.trim())

  const h = await run(['--help'])
  check('--help 显示默认端口 25250', h.stdout.includes('25250'))
  check('--help 包含 --root / --mount', h.stdout.includes('--root') && h.stdout.includes('--mount'))

  const requirePw = await run(['--require-password', '--users-file', 'none', '--port', '1'])
  check('--require-password 缺密码时拒绝启动（退出码 2）', requirePw.code === 2, `exit=${requirePw.code}`)
  check('--require-password 给出提示', requirePw.stderr.includes('--require-password'))

  const badMount = await run(['--pass', 'x', '--mount', 'files'])
  check('非法 --mount 被拒绝', badMount.code === 2 && badMount.stderr.includes('必须以 /'))

  const badDir = await run(['/definitely/not/here', '--pass', 'x'])
  check('不存在的目录被拒绝', badDir.code === 2 && badDir.stderr.includes('不存在或不是目录'))
}

// --- 1c. --check-ip 诊断 ------------------------------------------------
console.log('\n1c. --check-ip 诊断免认证规则')
{
  const pub = await run(['--pass', PASSWORD, '--check-ip', '8.8.8.8'])
  check('--check-ip 公网 IP => 需要登录', pub.stdout.includes('需要登录'), `exit=${pub.code}`)
  check('--check-ip 给出如何追加网段', pub.stdout.includes('--trusted 8.8.8.8/32'))
  check('--check-ip 不改任何东西（不监听）', pub.code === 0)

  const added = await run(['--pass', PASSWORD, '--trusted', '203.0.113.0/24', '--check-ip', '203.0.113.9'])
  check('追加网段后 => 免认证', added.stdout.includes('免认证'))
  check('并指出命中的是哪条网段', added.stdout.includes('命中免认证网段 203.0.113.0/24'))

  const lan = await run(['--pass', PASSWORD, '--check-ip', '192.168.1.77'])
  check('默认内网段 => 免认证', lan.stdout.includes('命中免认证网段 192.168.0.0/16'))

  const bad = await run(['--pass', PASSWORD, '--check-ip', 'not-an-ip'])
  check('非法 --check-ip 报错', bad.code === 2 && bad.stderr.includes('不是合法 IP'))
}

// --- 1b. 不配置密码（匿名模式） -----------------------------------------
console.log('\n1b. 不配置密码')
{
  const port = await freePort()
  const srv = await startServer(['--port', String(port), '--no-files', '--users-file', 'none'])
  try {
    const res = await fetch(`${srv.base}/whoami`)
    check('无密码也能启动并直接访问', res.status === 200, `status=${res.status}`)
    check('不弹认证框（无 WWW-Authenticate）', res.headers.get('www-authenticate') === null)
    check('认证方式记为 anonymous', (await res.json()).authenticated_by === 'anonymous')
    check('首页给出未启用认证警告', (await (await fetch(srv.base)).text()).includes('未启用认证'))
  } finally {
    srv.stop()
  }
}

// --- 2. 内网免认证 + 目录浏览 --------------------------------------------
console.log('\n2. 默认配置（内网免认证 + 绑定目录直接挂在根路径）')
{
  const port = await freePort()
  const srv = await startServer(['--pass', PASSWORD, '--root', workdir, '--port', String(port)])
  try {
    const who = await (await fetch(`${srv.base}/whoami`)).json()
    check('本机免认证', who.authenticated_by === 'intranet-bypass', JSON.stringify(who.authenticated_by))
    check('内网标记为可信', who.trusted === true)
    check('未走代理时 via_proxy=false', who.via_proxy === false)

    const listing = await (await fetch(srv.base)).text()
    check('根路径直接是目录列表', listing.includes('修改时间') && listing.includes('big.bin'))
    check('不需要 /files 前缀', (await fetch(`${srv.base}/files/`)).status === 404)
    check('目录页含子目录链接', listing.includes('href="/docs/"'))
    check('目录页含文件与大小', listing.includes('big.bin') && listing.includes('256 KB'))
    check('默认不列出隐藏文件', !listing.includes('.env'))

    const sub = await (await fetch(`${srv.base}/docs/`)).text()
    check('子目录含 .. 上级入口', sub.includes('href="/">..</a>'))
    check('子目录含面包屑，且当前目录不加链接', sub.includes('class="crumbs"') && sub.includes('>docs</b>'), sub.match(/class="crumbs">[^<]*(<[^>]*>[^<]*)*/)?.[0])

    const file = await fetch(`${srv.base}/docs/report.txt`)
    check('下载文本文件内容正确', (await file.text()) === 'quarterly result', `status=${file.status}`)
    check('文本文件 Content-Type 正确', file.headers.get('content-type') === 'text/plain; charset=utf-8')

    const big = await fetch(`${srv.base}/big.bin`)
    check('大文件字节数正确', Number(big.headers.get('content-length')) === 256 * 1024)
    check('未知类型用 octet-stream', big.headers.get('content-type') === 'application/octet-stream')

    check('隐藏文件不可直接访问', (await fetch(`${srv.base}/.env`)).status === 404)

    const index = await fetch(`${srv.base}/照片/`)
    check('目录下 index.html 优先于目录列表', (await index.text()).includes('photo index'))

    for (const attack of ['/..%2f..%2fetc/hosts', '/%2e%2e%2f%2e%2e%2fpackage.json']) {
      const res = await fetch(`${srv.base}${attack}`)
      check(`目录穿越被挡住 ${attack}`, [403, 404].includes(res.status), `status=${res.status}`)
    }

    const health = await fetch(`${srv.base}/healthz`)
    check('/healthz 无需认证（不被同名文件遮挡）', health.status === 200 && (await health.text()).trim() === 'ok')

    const echo = await (await fetch(`${srv.base}/api/echo?x=1`, { method: 'POST', body: 'hi' })).json()
    check('/api/echo 回显 body 与 query', echo.body === 'hi' && echo.query === 'x=1')

    check('未知路径返回 404', (await fetch(`${srv.base}/nope`)).status === 404)
  } finally {
    srv.stop()
  }
}

// --- 3. 必须输密码 -------------------------------------------------------
console.log('\n3. --no-default-trusted（本机也要登录）')
{
  const port = await freePort()
  const srv = await startServer([
    '--pass', PASSWORD,
    '--root', workdir,
    '--port', String(port),
    '--no-default-trusted',
  ])
  try {
    const anon = await fetch(`${srv.base}/`)
    check('无凭据返回 401', anon.status === 401, `status=${anon.status}`)
    check('form 模式不弹 Basic 框', anon.headers.get('www-authenticate') === null)

    const wrong = await fetch(`${srv.base}/`, { headers: { authorization: `Basic ${Buffer.from('admin:bad').toString('base64')}` } })
    check('错误密码返回 401', wrong.status === 401, `status=${wrong.status}`)

    const ok = await fetch(`${srv.base}/docs/report.txt`, { headers: { authorization: AUTH } })
    check('正确密码可访问', ok.status === 200, `status=${ok.status}`)

    const who = await (await fetch(`${srv.base}/whoami`, { headers: { authorization: AUTH } })).json()
    check('认证方式记为 password', who.authenticated_by === 'password')

    check('/healthz 仍然公开', (await fetch(`${srv.base}/healthz`)).status === 200)
  } finally {
    srv.stop()
  }
}

// --- 4. 代理头伪造 -------------------------------------------------------
console.log('\n4. X-Forwarded-For 处理')
{
  const port = await freePort()
  const srv = await startServer(['--pass', PASSWORD, '--root', workdir, '--port', String(port)])
  try {
    const spoof = await fetch(`${srv.base}/whoami`, { headers: { 'x-forwarded-for': '8.8.8.8' } })
    check('可信代理 + 公网 XFF => 401', spoof.status === 401, `status=${spoof.status}`)

    const spoofWithCreds = await fetch(`${srv.base}/whoami`, {
      headers: { 'x-forwarded-for': '8.8.8.8', authorization: AUTH },
    })
    const body = await spoofWithCreds.json()
    check('带凭据时走 password 通道', body.authenticated_by === 'password')
    check('识别出真实客户端 IP', body.ip === '8.8.8.8', `ip=${body.ip}`)
    check('标记 via_proxy', body.via_proxy === true)
  } finally {
    srv.stop()
  }
}

// --- 5. --mount 与目录位置参数 ------------------------------------------
console.log('\n5. 绑定目录：位置参数 / --mount')
{
  const port = await freePort()
  const srv = await startServer(['--pass', PASSWORD, '--root', workdir, '--port', String(port), '--mount', '/files'])
  try {
    check('--mount /files 恢复前缀式访问', (await fetch(`${srv.base}/files/docs/report.txt`)).status === 200)
    check('带前缀时根路径无文件列表', (await fetch(`${srv.base}/docs/report.txt`)).status === 404)
  } finally {
    srv.stop()
  }

  const port0 = await freePort()
  const share = await startServer(['--pass', PASSWORD, '--root', workdir, '--port', String(port0), '--mount', '/share'])
  try {
    check('自定义挂载点可访问', (await fetch(`${share.base}/share/docs/report.txt`)).status === 200)
    check('原根路径不再存在', (await fetch(`${share.base}/docs/report.txt`)).status === 404)
  } finally {
    share.stop()
  }

  const port2 = await freePort()
  const mounted = await startServer(['--pass', PASSWORD, '--root', workdir, '--port', String(port2), '--mount', '/'])
  try {
    check('--mount / 可直接浏览目录', (await (await fetch(mounted.base)).text()).includes('big.bin'))
    check('--mount / 下文件可下载', (await fetch(`${mounted.base}/docs/report.txt`)).status === 200)
    check('--mount / 下内置路由仍优先', (await fetch(`${mounted.base}/healthz`)).status === 200)
    check('--mount / 下 /whoami 仍可用', (await fetch(`${mounted.base}/whoami`)).status === 200)
    check('--mount / 下不存在文件 404', (await fetch(`${mounted.base}/nope.txt`)).status === 404)
  } finally {
    mounted.stop()
  }

  // 目录写成位置参数；. 表示当前目录
  const port3 = await freePort()
  const positional = await startServer(['--pass', PASSWORD, workdir, '--port', String(port3)])
  try {
    check('目录位置参数生效', (await fetch(`${positional.base}/docs/report.txt`)).status === 200)
  } finally {
    positional.stop()
  }

  const port4 = await freePort()
  const dot = await startServer(['--pass', PASSWORD, '.', '--port', String(port4)], undefined, process.cwd())
  try {
    check('. = 当前目录，能看到 package.json', (await fetch(`${dot.base}/package.json`)).status === 200)
  } finally {
    dot.stop()
  }
}

// --- 6. 环境变量 ---------------------------------------------------------
console.log('\n6. 环境变量配置')
{
  const port = await freePort()
  // 环境变量那份也要前台，否则子进程会自己去后台
  const envArgs = withForeground([])
  const child = spawn(process.execPath, [bin, ...envArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OHMY_PASS: PASSWORD, OHMY_ROOT: workdir, OHMY_PORT: String(port), OHMY_USER: 'alice', OHMY_USERS_FILE: USERS_FILE, OHMY_STATE_DIR: STATE_DIR },
  })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) break
    await new Promise((r) => setTimeout(r, 50))
  }
  try {
    check('OHMY_PORT / OHMY_ROOT 生效', (await fetch(`${base}/docs/report.txt`)).status === 200)
    const who = await (await fetch(`${base}/whoami`)).json()
    check('本机仍免认证', who.authenticated_by === 'intranet-bypass')
  } finally {
    child.kill('SIGTERM')
  }

  // 用户名也必须来自环境变量
  const port2 = await freePort()
  const locked = await startServer(['--no-default-trusted', '--port', String(port2)], {
    ...process.env,
    OHMY_PASS: PASSWORD,
    OHMY_USER: 'alice',
    OHMY_ROOT: workdir,
  })
  try {
    const asAlice = await fetch(`${locked.base}/whoami`, {
      headers: { authorization: `Basic ${Buffer.from('alice:s3cret').toString('base64')}` },
    })
    const asNobody = await fetch(`${locked.base}/whoami`, {
      headers: { authorization: `Basic ${Buffer.from('nobody:s3cret').toString('base64')}` },
    })
    check('OHMY_USER=alice 引导出的账号可登录', asAlice.status === 200, `status=${asAlice.status}`)
    check('不存在的账号被拒', asNobody.status === 401, `status=${asNobody.status}`)
    check('alice 也是管理员', (await asAlice.json()).role === 'admin')
  } finally {
    locked.stop()
  }
}

// --- 7. 登录页 / 会话 Cookie / 管理后台 ----------------------------------
console.log('\n7. 登录页 + 会话 Cookie')
{
  const port = await freePort()
  const srv = await startServer(['--pass', PASSWORD, '--root', workdir, '--port', String(port), '--no-default-trusted'])
  try {
    // 浏览器访问 -> 跳登录页，而不是弹框
    const jump = await fetch(`${srv.base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    check('浏览器被跳转到 /login', jump.status === 302 && jump.headers.get('location') === '/login?next=%2F', `${jump.status} ${jump.headers.get('location')}`)

    const page = await fetch(`${srv.base}/login`)
    const html = await page.text()
    check('登录页可访问', page.status === 200 && /name="password"/.test(html))
    check('登录页有“记住我”', /记住我/.test(html))
    check('登录页不回显密码', !/value="s3cret"/.test(html))

    const bad = await fetch(`${srv.base}/login`, { method: 'POST', headers: FORM, body: form({ username: 'admin', password: 'nope' }) })
    check('密码错误 401', bad.status === 401)
    check('错误提示可见', /用户名或密码不正确/.test(await bad.text()))

    const ok = await fetch(`${srv.base}/login`, { method: 'POST', headers: FORM, body: form({ username: 'admin', password: PASSWORD, remember: '1' }), redirect: 'manual' })
    check('登录成功 303', ok.status === 303)
    const setCookie = ok.headers.get('set-cookie') || ''
    check('下发 HttpOnly 会话 Cookie', /ohmy_session=.+HttpOnly/.test(setCookie))
    check('“记住我” 用长期 Max-Age', Number(/Max-Age=(\d+)/.exec(setCookie)[1]) === 365 * 24 * 3600)
    const cookie = cookieOf(ok)

    const who = await (await fetch(`${srv.base}/whoami`, { headers: { cookie } })).json()
    check('Cookie 可访问且记为 session', who.authenticated_by === 'session' && who.user === 'admin', JSON.stringify(who.authenticated_by))
    check('角色是管理员', who.role === 'admin')

    check('伪造 Cookie 无效', (await fetch(`${srv.base}/whoami`, { headers: { cookie: 'ohmy_session=x.y' } })).status === 401)

    const out = await fetch(`${srv.base}/logout`, { headers: { cookie }, redirect: 'manual' })
    check('退出登录清 Cookie', out.status === 302 && /Max-Age=0/.test(out.headers.get('set-cookie') || ''))
  } finally {
    srv.stop()
  }
}

console.log('\n8. 管理后台（admin 可加账号）')
{
  const port = await freePort()
  const srv = await startServer(['--pass', PASSWORD, '--root', workdir, '--port', String(port), '--no-default-trusted'])
  try {
    const adminCookie = cookieOf(await fetch(`${srv.base}/login`, { method: 'POST', headers: FORM, body: form({ username: 'admin', password: PASSWORD }), redirect: 'manual' }))

    const page = await fetch(`${srv.base}/admin`, { headers: { cookie: adminCookie } })
    const html = await page.text()
    check('管理员能打开后台', page.status === 200 && /账号管理/.test(html))
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1]

    const created = await fetch(`${srv.base}/admin/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, ...FORM },
      body: form({ csrf, action: 'create', username: 'bob', password: 'bobpass', role: 'member' }),
      redirect: 'manual',
    })
    check('创建成员账号', created.headers.get('location') === '/admin?ok=created', created.headers.get('location'))

    check('无 CSRF 的 POST 被拒', (await fetch(`${srv.base}/admin/users`, {
      method: 'POST', headers: { cookie: adminCookie, ...FORM }, body: form({ action: 'delete', target: 'admin' }), redirect: 'manual',
    })).headers.get('location') === '/admin?err=csrf')

    const memberCookie = cookieOf(await fetch(`${srv.base}/login`, { method: 'POST', headers: FORM, body: form({ username: 'bob', password: 'bobpass' }), redirect: 'manual' }))
    check('成员能看到文件', (await fetch(`${srv.base}/docs/report.txt`, { headers: { cookie: memberCookie } })).status === 200)
    check('成员进不了后台', (await fetch(`${srv.base}/admin`, { headers: { cookie: memberCookie } })).status === 403)

    const accounts = JSON.parse(await readFile(USERS_FILE, 'utf8'))
    check('账号已落盘', accounts.users.some((u) => u.username === 'bob'))
    check('密码不以明文落盘', !JSON.stringify(accounts).includes('bobpass'))
    check('落盘带持久化会话密钥', /^[0-9a-f]{64}$/.test(accounts.sessionSecret))
  } finally {
    srv.stop()
  }
}

console.log('\n9. --auth basic 传统模式仍然可用')
{
  const port = await freePort()
  const srv = await startServer(['--pass', PASSWORD, '--root', workdir, '--port', String(port), '--no-default-trusted', '--auth', 'basic'])
  try {
    const res = await fetch(`${srv.base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    check('basic 模式发 WWW-Authenticate', /^Basic realm=/.test(res.headers.get('www-authenticate') || ''))
    check('basic 模式 curl -u 可用', (await fetch(`${srv.base}/docs/report.txt`, { headers: { authorization: AUTH } })).status === 200)
  } finally {
    srv.stop()
  }
}

console.log('\n10. 已有账号文件时的行为')
{
  // 前面几节已经把账号写进 USERS_FILE 了
  const before = (await stat(USERS_FILE)).mtimeMs
  const withAccounts = await run(['--require-password', '--check-ip', '8.8.8.8', '--port', '1'])
  check('已有账号时 --require-password 正常放行', withAccounts.code === 0, `exit=${withAccounts.code}`)
  check('--check-ip 会读账号', withAccounts.stdout.includes('需要登录'))
  check('--check-ip 不改写账号文件', (await stat(USERS_FILE)).mtimeMs === before)

  // 不需要 --pass 也能用已有账号登录
  const port = await freePort()
  const srv = await startServer(['--root', workdir, '--port', String(port), '--no-default-trusted'])
  try {
    const login = await fetch(`${srv.base}/login`, { method: 'POST', headers: FORM, body: form({ username: 'bob', password: 'bobpass' }), redirect: 'manual' })
    check('不传 --pass 也能用文件里的账号登录', login.status === 303, `status=${login.status}`)
  } finally {
    srv.stop()
  }
}


console.log('\n11. stop / status / restart（后台运行 + 用上次的参数重启）')
{
  const port = await freePort()
  const stateFile = path.join(STATE_DIR, `state-${port}.json`)
  const args = ['--root', workdir, '--pass', PASSWORD, '--no-default-trusted', '--port', String(port)]
  const stopIt = () => runCmd(['stop', '--port', String(port)])

  try {
    const before = await runCmd(['status', '--port', String(port)])
    check('未启动时 status 提示找不到记录', before.code === 1 && /没有找到/.test(before.stdout + before.stderr))

    // 后台启动
    const started = await run(args.concat('-d'))
    check('后台启动成功', started.code === 0, `exit=${started.code}`)
    check('提示了停止/重启命令', /stop --port/.test(started.stdout) && /restart --port/.test(started.stdout))
    check('状态文件已写入', existsSync(stateFile))

    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    check('状态里记下了端口与目录', state.port === port && state.root === workdir, `port=${state.port}`)
    check('状态里标记为后台运行', state.daemon === true)
    check('状态里没有明文密码', !JSON.stringify(state).includes(PASSWORD), '密码必须被隐藏')
    check('状态里没有 --pass 占位符之外的秘密', state.hadSecret === true)
    check('后台服务确实在监听', (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200)

    // status
    const st = await runCmd(['status', '--port', String(port)])
    check('status 显示运行中', st.code === 0 && /运行中/.test(st.stdout))
    check('status 显示绑定的目录', st.stdout.includes(workdir))
    check('status 显示认证方式', /登录页 \/login/.test(st.stdout))

    // restart：用上次的参数（不含 --pass）拉起来
    const restarted = await runCmd(['restart', '--port', String(port)])
    check('restart 成功', restarted.code === 0, `exit=${restarted.code} ${restarted.stderr.trim()}`)
    check('restart 打印了新 pid', /已按上次的参数重启（pid=\d+）/.test(restarted.stdout))
    const state2 = JSON.parse(await readFile(stateFile, 'utf8'))
    check('重启后是新进程', state2.pid !== state.pid)
    check('重启后旧进程已退出', !isAlive(state.pid))
    check('重启后服务仍可用', (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200)
    check('重启保留了原来的目录参数', state2.root === workdir)

    // 重启后账号照旧（密码没落盘，靠账号文件）
    const login = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: FORM,
      body: form({ username: 'admin', password: PASSWORD }),
      redirect: 'manual',
    })
    check('重启后原有账号仍能登录', login.status === 303, `status=${login.status}`)

    // stop
    const stopped = await runCmd(['stop', '--port', String(port)])
    check('stop 成功', stopped.code === 0 && /已停止/.test(stopped.stdout))
    check('stop 后进程退出', !isAlive(state2.pid))
    check('stop 后状态文件被清理', !existsSync(stateFile))

    // 陈旧状态文件：进程被强杀后 stop 会清理记录
    await run(args.concat('-d'))
    const stale = JSON.parse(await readFile(stateFile, 'utf8'))
    process.kill(stale.pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 300))
    const staleStatus = await runCmd(['status', '--port', String(port)])
    check('陈旧实例被标为“进程已不在”', /进程已不在/.test(staleStatus.stdout))
    const cleanup = await runCmd(['stop', '--port', String(port)])
    check('stop 会清理陈旧记录', cleanup.code === 0 && !existsSync(stateFile))

    // --force 强杀忽略 SIGTERM 的实例（这里用一个不响应信号的假实例不现实，验证参数可用即可）
    const forced = await runCmd(['stop', '--port', String(port), '--force'])
    check('--force 参数被接受', forced.code !== 2, `exit=${forced.code}`)
  } finally {
    // 兜底清理，避免留下后台进程
    await stopIt()
  }
}


console.log('\n12. 登录失败锁定（默认只锁账号，不锁 IP）')
{
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const srv = await startServer(['--root', workdir, '--port', String(port), '--no-default-trusted', '--pass', PASSWORD])
  const login = (username, password) =>
    fetch(`${base}/login`, { method: 'POST', headers: FORM, body: form({ username, password }), redirect: 'manual' })
  try {
    // 不带凭据的浏览不该被计入失败
    for (let i = 0; i < 5; i++) await fetch(`${base}/`, { headers: { accept: 'text/html' } })
    check('无凭据浏览不会触发锁定', (await login('admin', PASSWORD)).status === 303)

    // 同一个错误密码重复提交只算一次（浏览器缓存凭据 / 自动重试不会再把自己锁死）
    for (let i = 0; i < 6; i++) {
      const dup = await login('admin', 'same-wrong')
      check(`同一个错误密码重复第 ${i + 1} 次仍不锁`, dup.status === 401, `status=${dup.status}`)
    }

    // 换着密码猜才会累加：第 2、3 个不同密码
    check('第 2 个不同的错误密码 → 401', (await login('admin', 'wrong-2')).status === 401)
    const third = await login('admin', 'wrong-3')
    check('第 3 个不同的错误密码 → 锁定 429', third.status === 429, `status=${third.status}`)
    const retry = Number(third.headers.get('retry-after'))
    check('默认锁 1 小时', retry > 3590 && retry <= 3600, `retry-after=${retry}`)

    // 锁定期内正确密码、curl -u 全部拒绝
    check('锁定期内正确密码也被拒', (await login('admin', PASSWORD)).status === 429)
    check('Basic 猜密码被拦（429）', (await fetch(`${base}/`, { headers: { authorization: `Basic ${Buffer.from('admin:guess').toString('base64')}` } })).status === 429)
    check('Basic 正确密码也被拦', (await fetch(`${base}/`, { headers: { authorization: AUTH } })).status === 429)
    check('公共路径 /healthz 不受影响', (await fetch(`${base}/healthz`)).status === 200)

    // 换用户名不受影响 —— 说明锁的是账号，不是 IP
    check('换别的用户名依然能登录（只锁该账号）', (await login('bob', 'bobpass')).status === 303, 'bob 用第 8 节建的密码')

    // 同一个 IP 狂试一堆不存在的用户名，不该被锁（IP 维度默认关闭）
    let ghostStatus = 0
    for (let i = 0; i < 10; i++) ghostStatus = (await login(`ghost${i}`, 'x')).status
    check('同一 IP 换 10 个用户名不会被锁', ghostStatus === 401, `最后一次 status=${ghostStatus}`)
  } finally {
    srv.stop()
  }

  // 可以关掉
  {
    const p3 = await freePort()
    const s3 = await startServer(['--root', workdir, '--port', String(p3), '--no-default-trusted', '--pass', PASSWORD, '--account-max-attempts', '0'])
    try {
      const codes = []
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`http://127.0.0.1:${p3}/login`, {
          method: 'POST',
          headers: FORM,
          body: form({ username: 'admin', password: `nope-${i}` }),
        })
        codes.push(res.status)
      }
      check('--account-max-attempts 0 关闭账号锁定', codes.every((c) => c === 401), codes.join(','))
    } finally {
      s3.stop()
    }
  }
}

console.log('\n13. 免认证开关')
{
  // 没有账号也没有密码：默认就能直接访问
  const port = await freePort()
  const srv = await startServer(['--root', workdir, '--port', String(port), '--no-default-trusted', '--users-file', 'none'])
  try {
    check('无账号时默认免密码直接访问', (await fetch(`${srv.base}/`)).status === 200)
    check('whoami 显示未启用认证', (await (await fetch(`${srv.base}/whoami`)).json()).auth_enabled === false)
  } finally {
    srv.stop()
  }

  // 已经有账号：默认仍然要登录，--allow-anonymous 可强制放开
  const p2 = await freePort()
  const locked = await startServer(['--root', workdir, '--port', String(p2), '--no-default-trusted'])
  try {
    check('已有账号时默认要登录', (await fetch(`${locked.base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })).status === 302)
  } finally {
    locked.stop()
  }

  const p3 = await freePort()
  const forced = await startServer(['--root', workdir, '--port', String(p3), '--no-default-trusted', '--allow-anonymous'])
  try {
    const res = await fetch(`${forced.base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    check('--allow-anonymous 强制放开', res.status === 200, `status=${res.status}`)
  } finally {
    forced.stop()
  }
}


console.log('\n14. 默认后台启动（不用加 -d）')
{
  const port = await freePort()
  const stateFile = path.join(STATE_DIR, `state-${port}.json`)
  const args = ['--root', workdir, '--pass', PASSWORD, '--no-default-trusted', '--port', String(port), '--users-file', USERS_FILE]

  // 注意：这里故意不加 --foreground / -d，验证默认行为
  const started = await runCmd(args)
  check('不带任何后台参数也能后台启动', started.code === 0, `exit=${started.code} ${started.stderr.trim()}`)
  check('提示已在后台启动并给出 PID', /已在后台启动（pid=\d+）/.test(started.stdout))
  check('提示了 stop / restart / status', /stop/.test(started.stdout) && /restart/.test(started.stdout))
  check('状态文件已写入', existsSync(stateFile))

  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  check('状态里标记为后台运行', state.daemon === true)
  check('状态里依然没有明文密码', !JSON.stringify(state).includes(PASSWORD))
  check('后台服务在监听', (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200)

  // 前台模式：命令不返回，直到被停掉
  const port2 = await freePort()
  const fg = spawn(process.execPath, [bin, ...args.slice(0, -4), '--port', String(port2), '--foreground', '--users-file', USERS_FILE], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OHMY_STATE_DIR: STATE_DIR },
  })
  let fgOut = ''
  fg.stdout.on('data', (d) => (fgOut += d))
  let fgExited = false
  fg.on('exit', () => (fgExited = true))
  const deadline = Date.now() + 5000
  while (!fgOut.includes('listening') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  check('--foreground 时进程自己不会退出', !fgExited)
  check('--foreground 时日志直接打在终端上', fgOut.includes('listening'))
  fg.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 400))
  check('--foreground 收到 SIGTERM 会退出', fgExited)

  await runCmd(['stop', '--port', String(port)])
  check('stop 收尾干净', !existsSync(stateFile))
}

console.log('\n15. 后台管理页：登录保护设置 + 锁定列表 + 改密码解锁')
{
  const port = await freePort()
  const srv = await startServer(['--root', workdir, '--port', String(port), '--no-default-trusted', '--pass', PASSWORD])
  const post = (cookie, csrf, body) =>
    fetch(`${srv.base}/admin/users`, { method: 'POST', headers: { cookie, ...FORM }, body: form({ csrf, ...body }), redirect: 'manual' })
  const login = (username, password) =>
    fetch(`${srv.base}/login`, { method: 'POST', headers: FORM, body: form({ username, password }), redirect: 'manual' })
  try {
    const cookie = cookieOf(await login('admin', PASSWORD))
    const page = await (await fetch(`${srv.base}/admin`, { headers: { cookie } })).text()
    check('后台有“登录保护”区', /登录保护/.test(page))
    check('默认只锁账号 3 次', /name="account_max_attempts"[^>]*value="3"/.test(page))
    check('默认不锁 IP（0）', /name="ip_max_attempts"[^>]*value="0"/.test(page))
    check('说明了为什么默认不锁 IP', /按 IP 锁定已关闭/.test(page))
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]

    // 建一个成员 bob 用来演示锁定
    await post(cookie, csrf, { action: 'create', username: 'bob2', password: 'bob2pass', role: 'member' })
    for (const pw of ['z-1', 'z-2', 'z-3']) await login('bob2', pw)
    check('bob2 已被锁', (await login('bob2', 'bob2pass')).status === 429)

    // 锁定列表：能看到是谁、什么时候自动解锁、并单独解锁
    const lockedPage = await (await fetch(`${srv.base}/admin`, { headers: { cookie } })).text()
    check('后台列出当前锁定', /当前锁定 \/ 失败记录/.test(lockedPage) && /bob2/.test(lockedPage))
    check('显示自动解锁时间', /自动解锁/.test(lockedPage))
    check('提示重置密码会自动解锁', /重置密码会自动解除该账号的锁定/.test(lockedPage))

    const one = await post(cookie, csrf, { action: 'unlock-key', key: 'user:bob2' })
    check('可以单独解锁一个账号', one.headers.get('location') === '/admin?ok=unlocked_one', one.headers.get('location'))
    check('解锁后能登录', (await login('bob2', 'bob2pass')).status === 303)

    // 再锁一次，用「重置密码」自动解锁
    for (const pw of ['y-1', 'y-2', 'y-3']) await login('bob2', pw)
    check('重置密码前是锁的', (await login('bob2', 'bob2pass')).status === 429)
    const reset = await post(cookie, csrf, { action: 'set-password', target: 'bob2', password: 'brandnew1' })
    check('重置密码成功', reset.headers.get('location') === '/admin?ok=password')
    check('改完密码锁自动解除', (await login('bob2', 'brandnew1')).status === 303)

    // 改设置立即生效
    const saved = await post(cookie, csrf, { action: 'save-settings', account_max_attempts: '1', ip_max_attempts: '0', lockout_minutes: '5' })
    check('保存设置成功', saved.headers.get('location') === '/admin?ok=settings')
    check('第 1 次失败就锁（新策略立即生效）', (await login('bob2', 'nope')).status === 429)
    check('锁定时长跟随设置（5 分钟）', Number((await login('bob2', 'nope')).headers.get('retry-after')) === 300)

    const bad = await post(cookie, csrf, { action: 'save-settings', account_max_attempts: '999', ip_max_attempts: '0', lockout_minutes: '5' })
    check('非法设置被拒', bad.headers.get('location') === '/admin?err=invalid_settings')

    const raw = JSON.parse(await readFile(USERS_FILE, 'utf8'))
    check('设置落在账号文件里', raw.settings?.accountMaxAttempts === 1 && raw.settings?.lockoutMinutes === 5)
  } finally {
    srv.stop()
  }
}

await rm(workdir, { recursive: true, force: true })
await mkdir(path.join(workdir, 'docs', '2025'), { recursive: true })
await mkdir(path.join(workdir, '照片'), { recursive: true })
await writeFile(path.join(workdir, 'docs', 'report.txt'), 'quarterly result')
await writeFile(path.join(workdir, 'docs', '2025', 'summary.md'), '# summary')
await writeFile(path.join(workdir, '照片', 'index.html'), '<h1>photo index</h1>')
await writeFile(path.join(workdir, 'big.bin'), Buffer.alloc(256 * 1024, 3))
await writeFile(path.join(workdir, '.env'), 'SECRET=1')

// --- 1. CLI 本身 ---------------------------------------------------------

console.log('\n16. --require-auth：不给密码，首次访问创建管理员')
{
  const dir = path.join(workdir, 'setup-demo')
  await mkdir(dir, { recursive: true })
  const usersFile = path.join(dir, 'users.json')
  const stateDir = path.join(dir, 'state')
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const args = ['--root', dir, '--require-auth', '--no-default-trusted', '--port', String(port), '--users-file', usersFile, '--state-dir', stateDir, '--foreground']
  const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OHMY_STATE_DIR: stateDir } })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  try {
    const deadline = Date.now() + 8000
    while (!out.includes('初始化口令') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    const token = /初始化口令: ([0-9a-f]+)/.exec(out)?.[1]
    check('启动时打印初始化口令', Boolean(token), token ? '有' : out.slice(0, 120))
    check('提示还没有账号', /还没有任何账号/.test(out))
    check('账号数量为 0 但认证已开启', /账号 0 个/.test(out))

    const page = await (await fetch(`${base}/login`)).text()
    check('登录页变成“创建管理员”', /创建管理员/.test(page))
    check('非内网来源要求初始化口令', /name="token"/.test(page))

    const submit = (body) =>
      fetch(`${base}/login`, { method: 'POST', headers: FORM, body: form({ username: 'admin', password: 'first123', confirm: 'first123', ...body }), redirect: 'manual' })
    check('不带口令不能创建', (await submit({})).status === 401)
    check('口令错误不能创建', (await submit({ token: 'nope' })).status === 401)
    const created = await submit({ token })
    check('带对口令创建成功', created.status === 303, `status=${created.status}`)
    const cookie = cookieOf(created)
    const who = await (await fetch(`${base}/whoami`, { headers: { cookie } })).json()
    check('创建后直接是登录态的管理员', who.user === 'admin' && who.role === 'admin')

    check('建完后 /login 不再显示初始化', !/创建管理员/.test(await (await fetch(`${base}/login`)).text()))
    check('账号已落盘', JSON.parse(await readFile(usersFile, 'utf8')).users.length === 1)

    // 之后再启动 --pass 会被忽略
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    const second = await run(['--root', dir, '--port', String(port), '--no-default-trusted', '--users-file', usersFile, '--pass', 'cli-pw'])
    void second
    const again = spawn(process.execPath, [bin, ...args.slice(0, -1).map((a) => (a === '--require-auth' ? '--pass=cli-pw' : a)), '--foreground'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OHMY_STATE_DIR: stateDir } })
    let out2 = ''
    again.stdout.on('data', (d) => (out2 += d))
    const deadline2 = Date.now() + 8000
    while (!out2.includes('listening') && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 50))
    check('账号已存在时启动会说明忽略 --pass', /忽略本次 --pass/.test(out2), out2.split('\n').find((l) => l.includes('账号:')) || '')
    const stillWorks = await fetch(`${base}/login`, { method: 'POST', headers: FORM, body: form({ username: 'admin', password: 'first123' }), redirect: 'manual' })
    check('创建时设的密码仍然有效（没被 --pass 覆盖）', stillWorks.status === 303, `status=${stillWorks.status}`)
    again.kill('SIGTERM')
  } finally {
    child.kill('SIGKILL')
  }
}

await rm(workdir, { recursive: true, force: true })

console.log(`\n${failed === 0 ? green('全部通过') : red('有失败项')}: ${passed} 通过, ${failed} 失败`)
if (failed) console.log(red(`失败项: ${failures.join(' | ')}`))
console.log()
process.exit(failed === 0 ? 0 : 1)
