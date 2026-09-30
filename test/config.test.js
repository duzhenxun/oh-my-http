import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { basicAuthHeader, checkCredentials } from '../lib/auth.js'
import { loadConfig } from '../lib/config.js'
import { sha256 } from '../lib/util.js'
import { VERSION } from '../lib/version.js'

const req = (authorization) => ({ headers: authorization ? { authorization } : {} })

// 单测不碰真实的账号文件
const load = (argv = [], env = {}) => loadConfig([...argv, '--users-file', 'none'], env)

test('package.json 与 lib/version.js 的版本号一致', () => {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  assert.equal(pkg.version, VERSION)
})

test('checkCredentials 校验用户名与密码', () => {
  const cfg = { username: 'admin', passHash: sha256('s3cret') }
  assert.equal(checkCredentials(req(basicAuthHeader('admin', 's3cret')), cfg), true)
  assert.equal(checkCredentials(req(basicAuthHeader('admin', 'wrong')), cfg), false)
  assert.equal(checkCredentials(req(basicAuthHeader('root', 's3cret')), cfg), false)
  assert.equal(checkCredentials(req('Basic ' + Buffer.from('admin').toString('base64')), cfg), false)
  assert.equal(checkCredentials(req('Bearer abc'), cfg), false)
  assert.equal(checkCredentials(req(), cfg), false)
  // 匿名模式：passHash 为 null 时永远不通过
  assert.equal(checkCredentials(req(basicAuthHeader('admin', 's3cret')), { username: 'admin', passHash: null }), false)
  // 密码含冒号与 UTF-8
  const cfg2 = { username: '用户', passHash: sha256('a:b:中') }
  assert.equal(checkCredentials(req(basicAuthHeader('用户', 'a:b:中')), cfg2), true)
})

test('loadConfig 读取环境变量', () => {
  const cfg = load([], { OHMY_PASS: 'pw', OHMY_PORT: '9000', OHMY_HOST: '127.0.0.1' })
  assert.equal(cfg.port, 9000)
  assert.equal(cfg.host, '127.0.0.1')
  assert.equal(cfg.username, 'admin')
  // form 模式下登录页本身免认证
  assert.deepEqual(cfg.publicPaths, ['/healthz', '/login', '/logout'])
  assert.equal(cfg.auth, 'form')
  assert.equal(cfg.sessionDays, 7)
  assert.equal(cfg.anonymous, false)
  assert.equal(cfg.honorXFF, true)
  assert.ok(cfg.trusted.length >= 9)
  // 不指定目录时默认绑定当前目录，并直接挂在根路径
  assert.equal(cfg.root, process.cwd())
  assert.equal(cfg.rootIsDefault, true)
  assert.equal(cfg.mount, '/')
})

test('目录可写成位置参数，. 就是当前目录', () => {
  const dot = load(['.'], { OHMY_PASS: 'p' })
  assert.equal(dot.root, process.cwd())
  assert.equal(dot.rootInput, '.')
  assert.equal(dot.rootIsDefault, false)

  const abs = load(['/tmp'], { OHMY_PASS: 'p' })
  assert.equal(abs.root, '/tmp')

  // -r 与 --root 等价
  assert.equal(load(['-r', '/tmp'], { OHMY_PASS: 'p' }).root, '/tmp')
  assert.equal(load(['--root', '/tmp'], { OHMY_PASS: 'p' }).root, '/tmp')
  // 目录参数与 --root 互斥
  assert.throws(() => load(['/tmp', '--root', '/tmp', '--pass', 'p']), /只能给一个/)
  assert.throws(() => load(['/tmp', '/var', '--pass', 'p']), /只能指定一个目录/)
  assert.throws(() => load(['/definitely/not/here', '--pass', 'p']), /不存在或不是目录/)
})

test('--no-files 只保留内置接口', () => {
  const cfg = load(['--no-files', '--pass', 'p'])
  assert.equal(cfg.root, null)
  assert.equal(cfg.mount, null)
  assert.throws(() => load(['--no-files', '--pass', 'p', '--mount', '/x']), /--no-files 不能与/)
  assert.throws(() => load(['--no-files', '/tmp', '--pass', 'p']), /--no-files 不能与/)
})

test('命令行参数覆盖环境变量', () => {
  const cfg = load(['--user', 'alice', '--port', '1234', '--pass', 'p', '--trusted', '203.0.113.0/24,10.9.0.0/16', '--public', '/healthz,/open'], {
    OHMY_USER: 'bob',
    OHMY_PASS: 'envpw',
    OHMY_PORT: '9999',
  })
  assert.equal(cfg.username, 'alice')
  assert.equal(cfg.port, 1234)
  assert.ok(cfg.trusted.some((p) => p.text === '203.0.113.0/24'))
  assert.ok(cfg.trusted.some((p) => p.text === '10.9.0.0/16'))
  assert.deepEqual(cfg.publicPaths, ['/healthz', '/open', '/login', '/logout'])
  assert.equal(checkCredentials(req(basicAuthHeader('alice', 'p')), cfg), true)
})

test('--pass-sha256 优先于 --pass', () => {
  const digest = sha256('fromhash').toString('hex')
  const cfg = load(['--pass', 'ignored', '--pass-sha256', digest.toUpperCase()])
  assert.equal(cfg.passHash.equals(sha256('fromhash')), true)
  assert.throws(() => load(['--pass-sha256', 'abcd']), /64 位十六进制/)
})

test('--addr 同时设置 host 与 port，支持 IPv6 字面量', () => {
  const cfg = load(['--addr', '127.0.0.1:7777', '--pass', 'p'])
  assert.equal(cfg.host, '127.0.0.1')
  assert.equal(cfg.port, 7777)
  const v6 = load(['--addr', '[::1]:8888', '--pass', 'p'])
  assert.equal(v6.host, '::1')
  assert.equal(v6.port, 8888)
})

test('可以不配置密码，必要时用 --require-password 强制要求', () => {
  const cfg = load([], {})
  assert.equal(cfg.anonymous, true)
  assert.equal(cfg.passHash, null)
  assert.equal(checkCredentials(req(basicAuthHeader('admin', 'x')), cfg), false)

  // 兼容旧参数 --allow-anonymous（现在已是默认行为）
  assert.equal(load(['--allow-anonymous'], {}).anonymous, true)

  assert.throws(() => load(['--require-password'], {}), /--require-password/)
})

test('非法配置抛错', () => {
  assert.throws(() => load(['--pass', 'p', '--port', 'abc']), /无效端口/)
  assert.throws(() => load(['--pass', 'p', '--port', '70000']), /无效端口/)
  assert.throws(() => load(['--pass', 'p', '--trusted', '10.0.0.0/99']), /无效的免认证网段/)
  assert.throws(() => load(['--pass', 'p', '--user', 'a:b']), /冒号/)
})

test('--check-ip 只做诊断，不启动服务', () => {
  const cfg = load(['--pass', 'p', '--check-ip', '8.8.8.8'])
  assert.equal(cfg.checkIp, '8.8.8.8')
  // 映射地址会先归一化
  assert.equal(load(['--pass', 'p', '--check-ip', '::ffff:8.8.8.8']).checkIp, '8.8.8.8')
  assert.throws(() => load(['--pass', 'p', '--check-ip', 'nope']), /不是合法 IP/)
  assert.equal(load(['--pass', 'p']).checkIp, null)
})

test('--no-default-trusted 清空默认内网信任', () => {
  const cfg = load(['--pass', 'p', '--no-default-trusted'])
  assert.deepEqual(cfg.trusted, [])
})

test('--help / --version 短路', () => {
  assert.deepEqual(load(['--help'], {}), { help: true })
  assert.deepEqual(load(['--version'], {}), { version: true })
})

test('默认后台启动；-f / 容器 / systemd 走前台', () => {
  assert.equal(load(['--pass', 'p']).daemon, true, '默认后台')
  assert.equal(load(['--pass', 'p']).explicitDaemon, false)
  assert.equal(load(['--pass', 'p', '--foreground']).daemon, false)
  assert.equal(load(['--pass', 'p', '-f']).daemon, false)
  assert.equal(load(['--pass', 'p', '-d']).daemon, true)
  assert.equal(load(['--pass', 'p', '-d'], { OHMY_FOREGROUND: '1' }).daemon, false, '前台优先于 -d')

  // systemd 环境自动前台，否则 Type=simple 的服务一启动就退出了
  const sd = load(['--pass', 'p'], { INVOCATION_ID: 'abc123' })
  assert.equal(sd.daemon, false)
  assert.equal(sd.daemonAutoOff, 'systemd')
  assert.equal(load(['--pass', 'p'], { OHMY_FOREGROUND: '1' }).daemon, false)
  // 显式 -d 依然尊重
  assert.equal(load(['--pass', 'p', '-d'], { INVOCATION_ID: 'abc123' }).daemon, true)
})

test('登录保护参数：默认只锁账号，IP 维度默认关闭；命令行显式指定才算覆盖', () => {
  const plain = load(['--pass', 'p'])
  assert.equal(plain.accountMaxAttempts, 3, '默认同一账号 3 次')
  assert.equal(plain.ipMaxAttempts, 0, '默认不按 IP 锁')
  assert.equal(plain.lockoutMinutes, 60)
  assert.equal(plain.accountMaxAttemptsExplicit, false, '没传就不算显式，让后台设置生效')

  const explicit = load(['--pass', 'p', '--account-max-attempts', '5', '--ip-max-attempts', '9', '--lockout-minutes', '10'])
  assert.equal(explicit.accountMaxAttempts, 5)
  assert.equal(explicit.ipMaxAttempts, 9)
  assert.equal(explicit.lockoutMinutes, 10)
  assert.equal(explicit.accountMaxAttemptsExplicit, true)
  assert.equal(explicit.ipMaxAttemptsExplicit, true)
  assert.equal(explicit.lockoutMinutesExplicit, true)

  assert.equal(load(['--pass', 'p'], { OHMY_LOCKOUT_MINUTES: '15' }).lockoutMinutesExplicit, true)
  assert.equal(load(['--pass', 'p', '--account-max-attempts', '0']).accountMaxAttempts, 0)
  assert.throws(() => load(['--pass', 'p', '--account-max-attempts', '999']), /0-100/)
  assert.throws(() => load(['--pass', 'p', '--ip-max-attempts', '999']), /0-100/)
  assert.throws(() => load(['--pass', 'p', '--lockout-minutes=-1']), /0-10080/)
})
