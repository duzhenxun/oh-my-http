import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  humanDuration,
  isAlive,
  listStates,
  looksLikeOurs,
  readState,
  redactArgv,
  removeState,
  restoreArgv,
  stateFileFor,
  stateStatus,
  stopProcess,
  stripOptions,
  tailLog,
  writeState,
} from '../lib/runtime.js'

const tmpDir = async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-rt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 起一个“长得像 oh-my-http”的假进程，用来测停止逻辑。
 * 会等到脚本真正跑起来（写了一个 ready 文件）再返回，避开“信号早于处理器注册”的竞态。
 */
async function fakeProcess(dir, { ignoreTerm = false } = {}) {
  const script = path.join(dir, `oh-my-http-fake-${ignoreTerm ? 'stubborn' : 'plain'}.js`)
  const readyFile = `${script}.ready`
  await writeFile(
    script,
    [
      ignoreTerm ? 'process.on("SIGTERM", () => {})' : '',
      `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready')`,
      'setInterval(() => {}, 1000)',
    ].join('\n'),
  )
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })
  const deadline = Date.now() + 5000
  while (!existsSync(readyFile)) {
    if (Date.now() > deadline) throw new Error('假进程未能启动')
    await new Promise((r) => setTimeout(r, 20))
  }
  return child
}

/** 起一个“不是我们的”进程（命令行里不含 oh-my-http）。 */
function foreignProcess() {
  return spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
}

const waitExit = (child, timeoutMs = 4000) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })

test('redactArgv / restoreArgv：密码不落盘，重启时自动省略', () => {
  const argv = ['.', '--pass', 's3cret', '--port', '9000', '--no-default-trusted']
  const red = redactArgv(argv)
  assert.equal(red.hadSecret, true)
  assert.deepEqual(red.argv, ['.', '--pass=<已隐藏>', '--port', '9000', '--no-default-trusted'])
  assert.ok(!JSON.stringify(red.argv).includes('s3cret'), '密码绝对不能出现在状态文件里')

  // 还原时把占位符整个丢掉，而不是传一个空密码
  assert.deepEqual(restoreArgv(red.argv), ['.', '--port', '9000', '--no-default-trusted'])

  // --pass=xxx / --pass-sha256=xxx 两种写法
  const eq = redactArgv(['--pass=abc', '--pass-sha256=deadbeef'])
  assert.equal(eq.hadSecret, true)
  assert.deepEqual(eq.argv, ['--pass=<已隐藏>', '--pass-sha256=<已隐藏>'])
  assert.deepEqual(restoreArgv(eq.argv), [])

  assert.equal(redactArgv(['.', '--port', '80']).hadSecret, false)
})

test('状态文件读写与清理', async (t) => {
  const dir = await tmpDir(t)
  const file = stateFileFor(25250, dir)
  assert.equal(path.basename(file), 'state-25250.json')

  assert.equal(readState(file), null)
  writeState({ pid: process.pid, port: 25250, argv: [] }, file)
  assert.equal(readState(file).pid, process.pid)

  // 文件权限 0600（里面可能有 --state-dir 之类的路径信息）
  const { stat } = await import('node:fs/promises')
  assert.equal((await stat(file)).mode & 0o777, 0o600)

  assert.deepEqual(
    listStates(dir).map((s) => s.port),
    [25250],
  )
  removeState(file)
  assert.deepEqual(listStates(dir), [])
  removeState(file) // 重复删不报错
})

test('isAlive / stateStatus 能识别死进程和被复用的 PID', async (t) => {
  const dir = await tmpDir(t)
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(999999), false)
  assert.equal(isAlive(0), false)

  assert.equal(stateStatus(null), 'unknown')
  assert.equal(stateStatus({ pid: 999999 }), 'dead')

  const child = await fakeProcess(dir)
  t.after(() => child.kill('SIGKILL'))
  assert.equal(looksLikeOurs(child.pid), true, '假进程的命令行里带 oh-my-http，应被认作自己人')
  assert.equal(stateStatus({ pid: child.pid }), 'running')
  child.kill('SIGKILL')
  await waitExit(child)
  assert.equal(stateStatus({ pid: child.pid }), 'dead')

  // 命令行里不带 oh-my-http 的进程：判定为“别人的进程”，不会被误杀
  const foreign = foreignProcess()
  t.after(() => foreign.kill('SIGKILL'))
  assert.equal(looksLikeOurs(foreign.pid), false)
  assert.equal(stateStatus({ pid: foreign.pid }), 'reused')
  await waitExit(foreign.kill('SIGKILL') || foreign, 2000)
})

test('stopProcess：优雅停止 / 拒绝误杀 / 强制结束', async (t) => {
  const dir = await tmpDir(t)

  // 不存在的进程：不算失败
  const gone = await stopProcess(999999)
  assert.equal(gone.ok, true)
  assert.match(gone.reason, /已经不在了/)

  // 自己的 PID：直接拒绝，不做任何判断（守门员）
  const self = await stopProcess(process.pid)
  assert.equal(self.ok, false)
  assert.match(self.reason, /自己/)

  // 不是我们的进程：也拒绝
  const foreign = foreignProcess()
  t.after(() => foreign.kill('SIGKILL'))
  const refused = await stopProcess(foreign.pid)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /拒绝结束它/)
  assert.equal(isAlive(foreign.pid), true, '不能把别人的进程杀掉')

  const nonePid = await stopProcess(null)
  assert.equal(nonePid.ok, false)

  // 正常 SIGTERM 退出
  const child = await fakeProcess(dir)
  const res = await stopProcess(child.pid, { timeoutMs: 3000 })
  assert.equal(res.ok, true, res.reason)
  assert.equal(isAlive(child.pid), false)

  // 忽略 SIGTERM：不加 --force 会失败并提示，加了才会强杀
  const stubborn = await fakeProcess(dir, { ignoreTerm: true })
  t.after(() => stubborn.kill('SIGKILL'))
  const polite = await stopProcess(stubborn.pid, { timeoutMs: 400 })
  assert.equal(polite.ok, false)
  assert.match(polite.reason, /仍未退出/)
  const forced = await stopProcess(stubborn.pid, { timeoutMs: 400, force: true })
  assert.equal(forced.ok, true, forced.reason)
  assert.equal(forced.forced, true)
  assert.equal(isAlive(stubborn.pid), false)
})

test('tailLog / humanDuration', async (t) => {
  const dir = await tmpDir(t)
  const file = path.join(dir, 'x.log')
  assert.equal(tailLog(file), '')
  await writeFile(file, 'a\nb\nc\nd\n')
  assert.equal(tailLog(file, 2), 'c\nd')

  assert.equal(humanDuration(5_000), '5 秒')
  assert.equal(humanDuration(90_000), '1 分钟')
  assert.equal(humanDuration(3600_000 * 3 + 60_000 * 5), '3 小时 5 分钟')
  assert.equal(humanDuration(3600_000 * 50), '2 天 2 小时')
})

test('日志文件可追加写入', async (t) => {
  const dir = await tmpDir(t)
  const { openLog, logFileFor } = await import('../lib/runtime.js')
  const { fd, file } = openLog(25250, dir)
  assert.equal(file, logFileFor(25250, dir))
  const { writeSync, closeSync } = await import('node:fs')
  writeSync(fd, 'hello log\n')
  closeSync(fd)
  assert.match(await readFile(file, 'utf8'), /hello log/)
})

test('stripOptions：重启时不会让 --port 越滚越多', () => {
  const argv = ['/data', '--port', '25250', '--state-dir', '/tmp/s', '--no-default-trusted']
  assert.deepEqual(stripOptions(argv, ['--port', '--state-dir']), ['/data', '--no-default-trusted'])
  // --port=25250 这种写法也要去掉
  assert.deepEqual(stripOptions(['/data', '--port=1', '--state-dir=/x'], ['--port', '--state-dir']), ['/data'])
  // 重复追加两次也不会累积
  const once = [...stripOptions(argv, ['--port', '--state-dir']), '--port', '25250', '--state-dir', '/tmp/s']
  const twice = [...stripOptions(once, ['--port', '--state-dir']), '--port', '25250', '--state-dir', '/tmp/s']
  assert.deepEqual(twice, once)
})
