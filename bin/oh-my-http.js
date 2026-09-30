#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { MIN_PASSWORD, createAccountStore } from '../lib/accounts.js'
import { loadConfig, USAGE } from '../lib/config.js'
import {
  COMMANDS,
  DEFAULT_STATE_DIR,
  humanDuration,
  listStates,
  logFileFor,
  openLog,
  readState,
  redactArgv,
  removeState,
  restoreArgv,
  stateFileFor,
  stateStatus,
  stopProcess,
  stripOptions,
  tailLog,
  waitForState,
  writeState,
} from '../lib/runtime.js'
import { createServer, explainAccess, lanAddresses, listen, withAuthState } from '../lib/server.js'
import { checkForUpdate, compareVersions, readUpdateCache, updateCacheFile, upgradeHint } from '../lib/update.js'
import { BANNER, NAME, VERSION } from '../lib/version.js'

const BIN = fileURLToPath(import.meta.url)

function formatLog(entry) {
  if (entry.level === 'warn') return `! ${entry.time} 警告 ${entry.message}`
  if (entry.error) return `! ${entry.time} error path=${entry.path} ${entry.error}`
  const ms = `${entry.durationMs.toFixed(0)}ms`
  const via = entry.viaProxy ? ` proxy->${entry.peer}` : ''
  return [
    entry.time,
    String(entry.ip).padEnd(15),
    String(entry.method).padEnd(16),
    String(entry.status).padEnd(3),
    String(entry.requestMethod).padEnd(6),
    entry.path,
    ms,
    via,
  ]
    .filter(Boolean)
    .join(' ')
}

// ---------------------------------------------------------------------------
// --check-ip
// ---------------------------------------------------------------------------

/** 不改任何东西，只说明来自该 IP 的请求会被怎么处理。 */
function printAccessCheck(cfg) {
  const ip = cfg.checkIp
  const rootPath = cfg.root ? (cfg.mount === '/' ? '/' : `${cfg.mount}/`) : '/'
  const paths = [rootPath]
  for (const p of cfg.publicPaths) if (!paths.includes(p)) paths.push(p)
  for (const p of ['/whoami', '/api/echo']) if (!paths.includes(p)) paths.push(p)

  const width = Math.max(...paths.map((p) => p.length))
  const main = explainAccess(ip, rootPath, cfg)

  console.log(`${BANNER}\n`)
  console.log(`检查客户端 ${ip} 会被怎么处理（本次不启动服务）\n`)
  console.log(`  结论: 来自 ${ip} 的请求 -> ${main.allowed ? '免认证' : '需要登录'}`)
  console.log(`  依据: ${main.reason}\n`)

  for (const p of paths) {
    const d = explainAccess(ip, p, cfg)
    const label = d.allowed ? `免认证 · ${d.reason}` : '需要登录（用户名密码）'
    console.log(`  ${p.padEnd(width)}  ${label}`)
  }

  console.log(`\n  当前免认证网段 (${cfg.trusted.length} 条):`)
  for (const t of cfg.trusted) {
    console.log(`    ${t.text} (${t.family === 4 ? 'IPv4' : 'IPv6'}, /${t.prefixLen})`)
  }
  if (!cfg.authEnabled) {
    console.log('\n  注意: 未启用认证，任何 IP 都免认证')
  } else if (main.requiresPassword) {
    const bits = ip.includes(':') ? 128 : 32
    console.log(`\n  提示: 想让 ${ip} 免认证，启动时追加 --trusted ${ip}/${bits}`)
  } else {
    console.log('\n  提示: 该 IP 已在免认证范围内；其余 IP 仍需登录')
  }
}

// ---------------------------------------------------------------------------
// stop / status / restart
// ---------------------------------------------------------------------------

const COMMAND_OPTIONS = {
  port: { type: 'string' },
  'state-dir': { type: 'string' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

const COMMAND_USAGE = `用法:
  ${NAME} status [--port <n>] [--state-dir <dir>]
  ${NAME} stop [--port <n>] [--force] [--state-dir <dir>]
  ${NAME} restart [--port <n>] [--force] [--state-dir <dir>]

不带 --port 时：只有一个实例就直接用它，多个实例会列出来让你指定。`

function oneLine(state) {
  const status = stateStatus(state)
  const mark = status === 'running' ? '●' : status === 'dead' ? '○' : '⚠'
  return `${mark} :${state.port}  pid=${state.pid}  ${status === 'running' ? '运行中' : status === 'dead' ? '进程已不在' : 'PID 已被其它进程占用'}`
}

/** 用缓存（不联网）提示一下有没有新版本。 */
function printCachedUpdateHint(stateDir) {
  const cached = readUpdateCache(updateCacheFile(stateDir))
  if (!cached?.latest) return
  if (compareVersions(cached.latest, VERSION) <= 0) return
  for (const line of upgradeHint({ name: NAME, current: VERSION, latest: cached.latest })) {
    console.log(`  ${line}`)
  }
  console.log('')
}

/** 挑出要操作的实例。 */
function resolveTarget(states, port) {
  if (port) {
    const hit = states.find((s) => s.port === port)
    return hit ? { state: hit } : { error: `没有找到 :${port} 的实例记录` }
  }
  if (states.length === 0) return { error: '没有找到任何运行记录（服务可能没在这台机器上启动过）' }
  if (states.length === 1) return { state: states[0] }
  return { error: '有多个实例，请用 --port 指定', multiple: true }
}

function printState(state) {
  const status = stateStatus(state)
  const label = { running: '运行中', dead: '进程已不在', reused: 'PID 已被其它进程占用', unknown: '未知' }[status]
  console.log(`  ${oneLine(state)}`)
  if (state.root) console.log(`  目录    : ${state.root}${state.mount === '/' ? '  →  /' : `  →  ${state.mount}/`}`)
  else console.log('  目录    : 未绑定（--no-files）')
  console.log(`  监听    : http://${state.host}:${state.port}`)
  console.log(`  认证    : ${state.authEnabled ? (state.auth === 'form' ? `登录页 /login（账号 ${state.userCount} 个）` : `Basic 弹窗（账号 ${state.userCount} 个）`) : '未启用'}`)
  if (state.usersFile) console.log(`  账号文件: ${state.usersFile}`)
  if (state.setupToken) {
    console.log(`  待初始化: 还没有账号，打开 http://127.0.0.1:${state.port}/login 创建第一个管理员`)
    console.log(`  初始化口令: ${state.setupToken}（非内网来源创建时需要填）`)
  }
  if (status === 'running' && state.startedAt) {
    console.log(`  已运行  : ${humanDuration(Date.now() - Date.parse(state.startedAt))}（启动于 ${state.startedAt}）`)
  }
  console.log(`  启动参数: ${NAME} ${restoreArgv(state.argv || []).join(' ') || '(无)'}`)
  console.log(`  工作目录: ${state.cwd}`)
  if (state.daemon) console.log(`  日志    : ${logFileFor(state.port, state.stateDir)}`)
  return status
}

async function runCommand(cmd, args) {
  let values
  try {
    values = parseArgs({ args, options: COMMAND_OPTIONS, allowPositionals: false, strict: true }).values
  } catch (err) {
    console.error(`${NAME}: ${err.message}\n`)
    console.error(COMMAND_USAGE)
    process.exitCode = 2
    return
  }
  if (values.help) {
    console.log(COMMAND_USAGE)
    return
  }
  if (values.port !== undefined) {
    const n = Number(values.port)
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      console.error(`${NAME}: 无效端口: ${values.port}`)
      process.exitCode = 2
      return
    }
  }

  const dir = path.resolve(values['state-dir'] || process.env.OHMY_STATE_DIR || DEFAULT_STATE_DIR)
  const port = values.port !== undefined ? Number(values.port) : null

  if (cmd === 'status') {
    if (port) {
      const state = readState(stateFileFor(port, dir))
      if (!state) {
        console.log(`没有找到 :${port} 的运行记录（状态目录 ${dir}）`)
        printCachedUpdateHint(dir)
        process.exitCode = 1
        return
      }
      printState({ ...state, stateDir: dir })
      printCachedUpdateHint(dir)
      return
    }
    const states = listStates(dir).map((s) => ({ ...s, stateDir: dir }))
    if (states.length === 0) {
      console.log(`没有运行中的实例（状态目录 ${dir}）`)
      printCachedUpdateHint(dir)
      return
    }
    console.log(`状态目录: ${dir}\n`)
    for (const s of states) {
      printState(s)
      console.log('')
    }
    printCachedUpdateHint(states[0]?.stateDir || dir)
    return
  }

  // stop / restart
  let target
  if (port) {
    target = readState(stateFileFor(port, dir))
    if (!target) {
      console.error(`${NAME}: 没有找到 :${port} 的运行记录（状态目录 ${dir}）`)
      process.exitCode = 1
      return
    }
    target = { ...target, stateDir: dir }
  } else {
    const states = listStates(dir).map((s) => ({ ...s, stateDir: dir }))
    const picked = resolveTarget(states, null)
    if (picked.error) {
      if (picked.multiple) {
        console.error(`${NAME}: ${picked.error}\n`)
        for (const s of states) console.error(`  ${oneLine(s)}  ${s.root || ''}`)
      } else {
        console.error(`${NAME}: ${picked.error}`)
      }
      process.exitCode = 1
      return
    }
    target = picked.state
  }

  const stateFile = stateFileFor(target.port, dir)
  const status = stateStatus(target)

  // 陈旧记录：直接清掉
  if (status === 'dead') {
    console.log(`:${target.port} 的进程（pid=${target.pid}）已经不在了，清理掉旧记录。`)
    removeState(stateFile)
    if (cmd === 'stop') return
  }
  if (status === 'reused') {
    console.error(`${NAME}: 记录的 PID ${target.pid} 现在不是 oh-my-http 进程，出于安全不操作它。`)
    console.error(`请手动确认后删除状态文件: ${stateFile}`)
    process.exitCode = 1
    return
  }

  if (cmd === 'restart' && !target.usersFile && target.hadSecret) {
    console.error(`${NAME}: 无法自动重启：密码是用 --pass 传的，而且没有账号文件（--users-file none）。`)
    console.error('        重启会丢掉账号，请手动用原来的命令启动一次。')
    process.exitCode = 1
    return
  }

  // restart 会先停服务，所以先把参数验证一遍，避免"停掉了却起不来"
  if (cmd === 'restart') {
    const preview = [...stripOptions(stripDaemon(restoreArgv(target.argv || [])), ['--port', '--state-dir']), '--port', String(target.port), '--state-dir', dir]
    try {
      const parsed = loadConfig(preview)
      if (parsed.help || parsed.version) throw new Error('参数异常')
    } catch (err) {
      console.error(`${NAME}: 记录里的启动参数已不可用（${err.message}）`)
      console.error('        为避免停掉之后起不来，本次不执行重启。请手动启动，例如：')
      console.error(`        ${NAME} ${preview.join(' ')}`)
      process.exitCode = 1
      return
    }
  }

  if (status === 'running') {
    const res = await stopProcess(target.pid, { force: Boolean(values.force) })
    if (!res.ok) {
      console.error(`${NAME}: 停止失败: ${res.reason}`)
      process.exitCode = 1
      return
    }
    console.log(`:${target.port} 已停止（pid=${target.pid}，${res.reason}）`)
  }
  removeState(stateFile)

  if (cmd === 'stop') return

  // ---- restart：用上次的参数重新拉起来 ----
  // 先剥掉旧记录里的 --port/--state-dir，再补上本次的，避免参数越重启越多
  const argv = stripOptions(stripDaemon(restoreArgv(target.argv || [])), ['--port', '--state-dir'])
  argv.push('--port', String(target.port), '--state-dir', dir)

  const { file: logFile, fd } = openLog(target.port, dir)
  const child = spawn(process.execPath, [BIN, ...argv], {
    cwd: target.cwd || process.cwd(),
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, OHMY_DAEMON: '1', OHMY_FOREGROUND: '1' },
  })
  child.unref()

  const ready = await waitForState({ file: stateFile, pid: child.pid, timeoutMs: 10_000 })
  if (!ready.ok) {
    console.error(`${NAME}: 重启失败: ${ready.reason}`)
    const tail = tailLog(logFile)
    if (tail) console.error(`\n--- 日志末尾 ---\n${tail}`)
    process.exitCode = 1
    return
  }
  console.log(`:${target.port} 已按上次的参数重启（pid=${child.pid}）`)
  console.log(`  日志: ${logFile}`)
  if (target.root) console.log(`  访问: http://127.0.0.1:${target.port}/`)
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const stripDaemon = (argv) => argv.filter((a) => a !== '-d' && a !== '--daemon')

/** --daemon：把真正的服务甩到后台，自己等它起来后退出。 */
async function startDaemon(argv, cfg) {
  const { file: logFile, fd } = openLog(cfg.port, cfg.stateDir)
  const stateFile = stateFileFor(cfg.port, cfg.stateDir)
  removeState(stateFile)

  const child = spawn(process.execPath, [BIN, ...stripDaemon(argv)], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', fd, fd],
    // OHMY_FOREGROUND 避免这个后台子进程又去“后台启动”一次
    env: { ...process.env, OHMY_DAEMON: '1', OHMY_FOREGROUND: '1' },
  })
  child.unref()

  const ready = await waitForState({ file: stateFile, pid: child.pid, timeoutMs: 10_000 })
  if (!ready.ok) {
    console.error(`${NAME}: 后台启动失败: ${ready.reason}`)
    const tail = tailLog(logFile)
    if (tail) console.error(`\n--- 日志末尾 ---\n${tail}`)
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {
      /* ignore */
    }
    process.exitCode = 1
    return
  }

  console.log(`${BANNER}\n`)
  console.log(`已在后台启动（pid=${child.pid}）`)
  console.log(`  监听: http://${cfg.host}:${cfg.port}`)
  if (cfg.root) console.log(`  目录: ${cfg.root}${cfg.mount === '/' ? '  →  /' : `  →  ${cfg.mount}/`}`)
  console.log(`  日志: ${logFile}`)
  if (ready.state?.setupToken) {
    console.log('')
    console.log('  还没有任何账号 —— 打开 /login 创建第一个管理员')
    console.log(`  初始化口令: ${ready.state.setupToken}`)
  }
  printCachedUpdateHint(cfg.stateDir)
  console.log(`\n  停止: ${NAME} stop${cfg.port === 25250 ? '' : ` --port ${cfg.port}`}`)
  console.log(`  重启: ${NAME} restart${cfg.port === 25250 ? '' : ` --port ${cfg.port}`}`)
  console.log(`  状态: ${NAME} status`)
}

async function main() {
  const rawArgv = process.argv.slice(2)

  // 子命令（stop / status / restart / start）
  const cmd = rawArgv[0] && COMMANDS.includes(rawArgv[0]) ? rawArgv[0] : null
  if (cmd === 'stop' || cmd === 'status' || cmd === 'restart') {
    await runCommand(cmd, rawArgv.slice(1))
    return
  }
  const argv = cmd === 'start' ? rawArgv.slice(1) : rawArgv

  let cfg
  try {
    cfg = loadConfig(argv)
  } catch (err) {
    console.error(`${NAME}: 配置错误: ${err.message}\n`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }

  if (cfg.help) {
    console.log(USAGE)
    return
  }
  if (cfg.version) {
    console.log(`${NAME} ${VERSION}`)
    return
  }
  // --check-ip 是只读诊断：必须在“后台启动”之前处理掉，否则会被当成要后台运行
  if (cfg.checkIp) {
    const store = createAccountStore({ file: cfg.usersFile, bootstrap: null })
    if (store.loadError) {
      console.error(`${NAME}: ${store.loadError.message}`)
      process.exitCode = 2
      return
    }
    printAccessCheck(withAuthState(cfg, store))
    return
  }

  if (cfg.daemon) {
    await startDaemon(argv, cfg)
    return
  }
  if (cfg.daemonAutoOff) {
    console.log(
      `（检测到${{ container: '容器（PID 1）', systemd: 'systemd' }[cfg.daemonAutoOff]} 环境，已自动前台运行；想后台跑加 -d）`,
    )
  }

  // 账号存储（读账号文件；--pass 会引导出第一个管理员）
  let store
  try {
    // --check-ip 是只读诊断，不要顺手写账号文件
    store = createAccountStore({ file: cfg.usersFile, bootstrap: cfg.checkIp ? null : cfg.bootstrap })
  } catch (err) {
    console.error(`${NAME}: 读取账号文件失败: ${err.message}`)
    process.exitCode = 2
    return
  }
  if (store.loadError) {
    console.error(`${NAME}: ${store.loadError.message}`)
    console.error('请修复或删除该文件后重试（不会自动重建，以免覆盖已有账号）')
    process.exitCode = 2
    return
  }
  cfg = withAuthState(cfg, store)

  const options = cfg.quiet ? {} : { logger: (entry) => console.log(formatLog(entry)) }
  const server = createServer(cfg, { ...options, store })

  try {
    await listen(server, cfg)
  } catch (err) {
    console.error(`${NAME}: 监听 ${cfg.host}:${cfg.port} 失败: ${err.message}`)
    process.exitCode = 1
    return
  }

  // 记录运行状态，供 stop / status / restart 使用
  const stateFile = stateFileFor(cfg.port, cfg.stateDir)
  const { argv: safeArgv, hadSecret } = redactArgv(argv)
  writeState(
    {
      pid: process.pid,
      port: cfg.port,
      host: cfg.host,
      root: cfg.root,
      mount: cfg.mount,
      auth: cfg.auth,
      authEnabled: cfg.authEnabled,
      userCount: store.count,
      usersFile: cfg.usersFile,
      setupToken: server.ohmy?.setupToken || null,
      hidden: cfg.hidden,
      daemon: cfg.daemon || process.env.OHMY_DAEMON === '1',
      cwd: process.cwd(),
      argv: safeArgv,
      hadSecret,
      startedAt: new Date().toISOString(),
      version: VERSION,
    },
    stateFile,
  )
  process.on('exit', () => {
    const recorded = readState(stateFile)
    if (recorded?.pid === process.pid) removeState(stateFile)
  })

  console.log(BANNER)
  console.log(`listening on http://${cfg.host}:${cfg.port} (realm="${cfg.realm}")`)
  if (!cfg.authEnabled) {
    console.warn('WARNING: 未启用认证，任何能访问到该端口的人都能浏览这些文件')
    console.warn('         要开启认证：--pass <密码> 或 OHMY_PASS=<密码>，第一个账号默认是管理员')
  } else if (cfg.auth === 'form') {    const remember = cfg.rememberDays > 0 ? `，勾选“记住我”可保持 ${cfg.rememberDays} 天` : ''
    console.log(`  auth: 登录页 /login（会话 ${cfg.sessionDays} 天${remember}），账号 ${store.count} 个`)
    console.log(`  管理员界面: http://127.0.0.1:${cfg.port}/admin（需管理员账号）`)
  } else {
    console.log(`  auth: Basic 弹窗（账号 ${store.count} 个）`)
  }
  if (cfg.usersFile) console.log(`  账号文件: ${cfg.usersFile}`)
  else console.log('  账号文件: 未启用（本次运行的账号不落盘）')
  if (cfg.forceAnonymous) {
    console.warn('  ⚠ 已指定 --allow-anonymous：即使已有账号也强制免认证，请确认这不是你要的效果')
  }
  const policy = server.ohmy?.policy || cfg
  if (policy.lockoutMinutes > 0 && (policy.accountMaxAttempts > 0 || policy.ipMaxAttempts > 0)) {
    const parts = []
    if (policy.accountMaxAttempts > 0) parts.push(`同一账号失败 ${policy.accountMaxAttempts} 次`)
    if (policy.ipMaxAttempts > 0) parts.push(`同一 IP 失败 ${policy.ipMaxAttempts} 次`)
    console.log(`  登录保护: ${parts.join('、')} → 锁 ${policy.lockoutMinutes} 分钟`)
  } else {
    console.warn('  登录保护: 已关闭（--account-max-attempts 0 / --lockout-minutes 0）')
  }
  if (store.bootstrapResult === 'created') {
    console.log(`  账号: 已创建管理员 "${cfg.username}"（来自 --pass / --user）`)
  } else if (store.bootstrapResult === 'updated') {
    console.log(`  账号: "${cfg.username}" 的密码已按 --reset-pass 强制改回启动参数里的值`)
  } else if (store.bootstrapResult === 'ignored') {
    console.log(`  账号: "${cfg.username}" 已存在，忽略本次 --pass（想强制改回加 --reset-pass；改密码推荐去 /admin）`)
  }
  if (server.ohmy?.setupToken) {
    console.log('')
    console.log('  还没有任何账号 —— 浏览器打开 /login 创建第一个管理员')
    console.log(`  初始化口令: ${server.ohmy.setupToken}`)
    console.log('              （从非内网地址访问时需要填它，也可以用 oh-my-http status 再查）')
    console.log('')
  }
  if (cfg.bootstrap?.password && cfg.bootstrap.password.length < MIN_PASSWORD) {
    console.warn(`  提示: 启动参数里的密码不足 ${MIN_PASSWORD} 位，建议换一个更长一点的`)
  }
  for (const p of cfg.trusted) {
    console.log(`  trusted: ${p.text} (${p.family === 4 ? 'IPv4' : 'IPv6'}, /${p.prefixLen})`)
  }
  if (cfg.publicPaths.length) console.log(`  public paths: ${cfg.publicPaths.join(', ')}`)
  if (cfg.root) {
    const where = cfg.mount === '/' ? '/' : `${cfg.mount}/`
    const note = cfg.rootIsDefault ? ' (默认：当前目录)' : ''
    console.log(`  static root: ${cfg.root}${note} -> ${where}`)
    if (cfg.mount === '/') {
      console.log('  直接访问根路径即可浏览该目录（内置信息页让位给目录列表，状态看 /whoami）')
    }
    if (!cfg.hidden) console.log('  隐藏文件: 以 . 开头的文件不列出也不可访问（--hidden 可放开）')
  } else {
    console.log('  static root: 未绑定目录（--no-files）')
  }
  console.log(`  pid: ${process.pid}   停止: ${NAME} stop${cfg.port === 25250 ? '' : ` --port ${cfg.port}`}`)
  // 后台异步查新版本，不阻塞启动；24 小时内只联网一次
  if (!cfg.noUpdateCheck) {
    void checkForUpdate({
      name: NAME,
      current: VERSION,
      cacheFile: updateCacheFile(cfg.stateDir),
      registry: cfg.registry,
    })
      .then((result) => {
        if (!result?.newer) return
        console.log('')
        for (const line of upgradeHint({ name: NAME, current: VERSION, latest: result.latest })) {
          console.log(`  ${line}`)
        }
        console.log('')
      })
      .catch(() => {})
  }
  for (const ip of lanAddresses()) console.log(`  reachable at http://${ip}:${cfg.port}`)
  if (!cfg.authEnabled) {
    console.warn(
      `\n>>> 认证已关闭，直接用浏览器打开： http://127.0.0.1:${cfg.port}${cfg.mount === '/' ? '/' : `${cfg.mount || ''}/`}`,
    )
  } else if (cfg.auth === 'form') {
    console.log(`\n>>> 打开 http://127.0.0.1:${cfg.port}/ 会自动跳到登录页`)
  }

  let closing = false
  const shutdown = (signal) => {
    if (closing) return
    closing = true
    console.log(`\n收到 ${signal}，正在关闭 ...`)
    server.close(() => {
      console.log('bye')
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error(`${NAME}: 未捕获错误:`, err)
  process.exit(1)
})
