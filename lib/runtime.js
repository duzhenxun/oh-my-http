import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 内置子命令。第一个位置参数命中这些词时按命令处理。 */
export const COMMANDS = ['start', 'stop', 'restart', 'status']

export const DEFAULT_STATE_DIR = path.join(os.homedir() || '.', '.oh-my-http')

export const stateFileFor = (port, dir = DEFAULT_STATE_DIR) => path.join(dir, `state-${port}.json`)
export const logFileFor = (port, dir = DEFAULT_STATE_DIR) => path.join(dir, `log-${port}.log`)

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 原子写入运行状态。 */
export function writeState(state, file) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  return file
}

export function readState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function removeState(file) {
  try {
    unlinkSync(file)
  } catch {
    /* 已经不存在 */
  }
}

/** 列出状态目录里的所有实例（按端口排序）。 */
export function listStates(dir = DEFAULT_STATE_DIR) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => /^state-\d+\.json$/.test(n))
    .map((n) => readState(path.join(dir, n)))
    .filter(Boolean)
    .sort((a, b) => a.port - b.port)
}

export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM' // 存在但没有权限
  }
}

/** 拿某个 PID 的命令行，用于确认“这真的是我们的进程”，避免误杀。 */
export function processCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

export function looksLikeOurs(pid) {
  return /oh-my-http/.test(processCommand(pid))
}

/** 运行状态是否还活着且确实是我们的进程。 */
export function stateStatus(state) {
  if (!state?.pid) return 'unknown'
  if (!isAlive(state.pid)) return 'dead'
  if (!looksLikeOurs(state.pid)) return 'reused'
  return 'running'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 停止一个实例：先 SIGTERM，超时后 SIGKILL。
 * @returns {Promise<{ok: boolean, reason: string, pid?: number, forced?: boolean}>}
 */
export async function stopProcess(pid, { timeoutMs = 6000, force = false } = {}) {
  if (!pid) return { ok: false, reason: '没有记录 PID' }
  // 双保险：永远不要结束自己或自己的父进程（命令行里带 oh-my-http 的进程很容易误判）
  if (pid === process.pid) return { ok: false, reason: '拒绝结束当前进程自己', pid }
  if (pid === process.ppid) return { ok: false, reason: '拒绝结束当前进程的父进程', pid }
  if (!isAlive(pid)) return { ok: true, reason: '进程已经不在了（可能上次已经停掉）', pid }
  if (!looksLikeOurs(pid)) {
    return { ok: false, reason: `PID ${pid} 现在不是 oh-my-http 进程，拒绝结束它`, pid }
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    return { ok: false, reason: `发送 SIGTERM 失败: ${err.message}`, pid }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return { ok: true, reason: '已优雅退出', pid }
    await sleep(100)
  }

  if (!force) return { ok: false, reason: `等待 ${timeoutMs}ms 仍未退出（可加 --force 强杀）`, pid }

  try {
    process.kill(pid, 'SIGKILL')
  } catch (err) {
    return { ok: false, reason: `发送 SIGKILL 失败: ${err.message}`, pid }
  }
  await sleep(200)
  return isAlive(pid)
    ? { ok: false, reason: 'SIGKILL 之后仍然存在，请手动检查', pid }
    : { ok: true, reason: '已强制结束', pid, forced: true }
}

/** 可能带密码的参数，落盘前要抹掉。 */
export function redactArgv(argv) {
  const out = []
  let hadSecret = false
  const secretFlags = ['--pass', '--pass-sha256']
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = secretFlags.find((f) => arg === f || arg.startsWith(`${f}=`))
    if (eq) {
      hadSecret = true
      out.push(`${eq}=<已隐藏>`)
      if (arg === eq) i++ // 跳过它的值
      continue
    }
    out.push(arg)
  }
  return { argv: out, hadSecret }
}

/** 去掉指定的布尔/带值参数（restart 时要用新值重写端口等，避免越滚越多）。 */
export function stripOptions(argv, names) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (names.includes(arg)) {
      i++ // 连带它的值一起跳过
      continue
    }
    if (names.some((n) => arg.startsWith(`${n}=`))) continue
    out.push(arg)
  }
  return out
}

/** 还原成可以直接传给子进程的参数（把占位符整个丢掉）。 */
export function restoreArgv(argv) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (/^--(pass|pass-sha256)=<已隐藏>$/.test(arg)) continue
    out.push(arg)
  }
  return out
}

/** 打开一个追加写的日志文件描述符（给后台进程当 stdio 用）。 */
export function openLog(port, dir = DEFAULT_STATE_DIR) {
  ensureDir(dir)
  const file = logFileFor(port, dir)
  return { file, fd: openSync(file, 'a') }
}

/** 等子进程就绪：状态文件出现且 PID 对得上，或者子进程挂了。 */
export async function waitForState({ file, pid, timeoutMs = 8000 }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(file)) {
      const state = readState(file)
      if (state && (!pid || state.pid === pid)) return { ok: true, state }
    }
    if (pid && !isAlive(pid)) return { ok: false, reason: '子进程已退出' }
    if (Date.now() > deadline) return { ok: false, reason: `等待 ${timeoutMs}ms 仍未就绪` }
    await sleep(100)
  }
}

/** 读取日志文件末尾若干行，用于启动失败时给提示。 */
export function tailLog(file, lines = 15) {
  try {
    const text = readFileSync(file, 'utf8').trimEnd()
    return text.split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

/** 毫秒转人类可读的“已运行多久”。 */
export function humanDuration(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分钟`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}
