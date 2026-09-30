import { existsSync, readFileSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { DEFAULT_TRUSTED, normalizeIP, parsePrefix } from './ip.js'
import { DEFAULT_STATE_DIR } from './runtime.js'
import { DEFAULT_REGISTRY } from './update.js'
import { firstString, sha256, splitHostPort, splitList } from './util.js'
import { BANNER, NAME } from './version.js'

const DEFAULT_REALM = NAME
const DEFAULT_USER = 'admin'
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PORT = 25250
const DEFAULT_PUBLIC = ['/healthz']
/** 绑定目录默认直接挂在根路径，访问时不需要 /files/ 这层前缀 */
const DEFAULT_MOUNT = '/'
const DEFAULT_USERS_FILE = path.join(os.homedir() || '.', '.oh-my-http', 'users.json')
/** 同一个账号连续失败多少次就锁定（默认只锁账号） */
const DEFAULT_ACCOUNT_MAX_ATTEMPTS = 3
/** 同一个来源 IP 连续失败多少次锁定；0 = 不按 IP 锁（默认，避免隧道/反代后面误伤） */
const DEFAULT_IP_MAX_ATTEMPTS = 0
/** 锁定多久（分钟） */
const DEFAULT_LOCKOUT_MINUTES = 60
/** 不指定目录时，默认绑定当前目录 */
const DEFAULT_ROOT = '.'

const FLAG_OPTIONS = {
  addr: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  realm: { type: 'string' },
  user: { type: 'string' },
  pass: { type: 'string' },
  'pass-sha256': { type: 'string' },
  auth: { type: 'string' },
  'session-days': { type: 'string' },
  'remember-days': { type: 'string' },
  'users-file': { type: 'string' },
  'secure-cookie': { type: 'boolean' },
  'no-update-check': { type: 'boolean' },
  trusted: { type: 'string', multiple: true },
  'no-default-trusted': { type: 'boolean' },
  'no-xff': { type: 'boolean' },
  public: { type: 'string', multiple: true },
  root: { type: 'string', short: 'r' },
  mount: { type: 'string' },
  hidden: { type: 'boolean' },
  'no-files': { type: 'boolean' },
  'check-ip': { type: 'string' },
  'require-auth': { type: 'boolean' },
  'reset-pass': { type: 'boolean' },
  'require-password': { type: 'boolean' },
  'account-max-attempts': { type: 'string' },
  'ip-max-attempts': { type: 'string' },
  'lockout-minutes': { type: 'string' },
  'allow-anonymous': { type: 'boolean' },
  daemon: { type: 'boolean', short: 'd' },
  foreground: { type: 'boolean', short: 'f' },
  force: { type: 'boolean' },
  'state-dir': { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
}

export const USAGE = `${BANNER}

用法: ${NAME} [目录] [选项]
      ${NAME} stop|status|restart [--port <n>]

  目录                     要绑定（可浏览/下载）的目录，默认 .
                           写 . 就是当前目录，也可以直接给绝对路径
                           (env OHMY_ROOT，等价于 --root)

子命令（第一个位置参数是这些词时按命令处理）:
  status                   查看运行中的实例（PID / 端口 / 目录 / 已运行时长）
  stop                     停掉实例（先 SIGTERM，--force 可强杀）
  restart                  用上次启动的参数重启（密码不会落盘，靠账号文件保持）
                           多个实例时用 --port 指定；--state-dir 指定状态目录

选项:
  --addr <host:port>       等价于同时设置 --host 与 --port
  --host <ip>              监听地址，默认 ${DEFAULT_HOST} (env OHMY_HOST)
  --port <n>               监听端口，默认 ${DEFAULT_PORT} (env OHMY_PORT)
  --realm <name>           Basic 认证 realm，默认 ${DEFAULT_REALM} (env OHMY_REALM)
  --user <name>            引导管理员用户名，默认 ${DEFAULT_USER} (env OHMY_USER)
  --pass <pwd>             密码；第一次启动会用它创建管理员账号 (env OHMY_PASS)
  --pass-sha256 <hex>      密码的 sha256 十六进制摘要，优先于 --pass (env OHMY_PASS_SHA256)
  --users-file <path>      账号文件，默认 ${DEFAULT_USERS_FILE}
                           写 none 则不使用账号文件（只用 --pass 单账号） (env OHMY_USERS_FILE)
  --auth <form|basic>      认证方式，默认 form=登录页面+Cookie（不弹浏览器窗口）
                           basic=传统 Basic 弹窗；form 模式仍可用 curl -u (env OHMY_AUTH)
  --session-days <n>       不勾“记住我”时的登录保持天数，默认 7 (env OHMY_SESSION_DAYS)
  --remember-days <n>       勾上“记住我”后的保持天数，默认 365；写 0 则不提供该选项
                           (env OHMY_REMEMBER_DAYS)
  --secure-cookie          给会话 Cookie 加 Secure（HTTPS 访问时必须，自动探测反代）
  --require-auth           开启认证，但不在命令行给密码：没有账号时第一个访问 /login
                           的人会被引导创建管理员（内网之外需要启动日志里的初始化口令）
                           (env OHMY_AUTH_REQUIRED=1)
  --reset-pass             配合 --pass：账号已存在时也强制把密码改掉（默认忽略）
  --require-password       必须有密码（没有就报错退出），适合脚本自动化
  --allow-anonymous        强制关闭认证：已有账号也直接放行（慎用，裸启动时本来就是放行）
  --account-max-attempts <n>  同一账号连续失败几次锁定，默认 ${DEFAULT_ACCOUNT_MAX_ATTEMPTS}；0 = 不锁账号
                              (env OHMY_ACCOUNT_MAX_ATTEMPTS)
  --ip-max-attempts <n>       同一来源 IP 连续失败几次锁定，默认 ${DEFAULT_IP_MAX_ATTEMPTS}（不锁）
                              在隧道 / 反代 / 公司出口后面别开，会误伤一整片人
                              (env OHMY_IP_MAX_ATTEMPTS)
  --lockout-minutes <n>       锁定时长（分钟），默认 ${DEFAULT_LOCKOUT_MINUTES} (env OHMY_LOCKOUT_MINUTES)
  -r, --root <dir>         同「目录」参数 (env OHMY_ROOT)
  --mount <path>           挂载点，默认 /（直接挂在根路径）；写 /files 就多一层前缀 (env OHMY_MOUNT)
  --hidden                 列出并允许访问以 . 开头的文件（默认隐藏，防误泄 .env/.git）
  --no-files               不绑定任何目录，只保留内置接口
  -d, --daemon             后台运行（默认就是后台，加这个只是写明白）
  -f, --foreground         前台运行：占着当前终端，Ctrl+C 才退出
                           （docker / systemd / 调试时用；容器与 systemd 环境会自动切前台）
  --state-dir <dir>        PID / 日志存放目录，默认 ~/.oh-my-http (env OHMY_STATE_DIR)
  --trusted <cidr|ip>      追加免认证网段，可重复或用逗号分隔 (env OHMY_TRUSTED)
  --no-default-trusted     不再默认信任回环 / 私网 / 链路本地 / ULA / CGNAT
  --check-ip <ip>          不改任何东西，只打印来自该 IP 的请求会免认证还是需要密码，然后退出
  --no-xff                 即使直连对端可信也不采信 X-Forwarded-For
  --force                  配合 stop / restart：等不到优雅退出就 SIGKILL
  --public <path>          免认证路径，可重复或用逗号分隔 (env OHMY_PUBLIC)
  --no-update-check        不去 npm 查新版本（默认 24 小时最多查一次，只请求版本号）
                           (env OHMY_NO_UPDATE_CHECK=1，或 NO_UPDATE_NOTIFIER=1)
  -q, --quiet              不打印访问日志
  -v, --version            打印版本
  -h, --help               打印本帮助

示例:
  ${NAME}                                  当前目录挂在 /，25250 端口，不启用认证
  ${NAME} . --pass s3cret                  后台启动（默认），返回时会给 PID
  ${NAME} . --pass s3cret -f               前台启动，Ctrl+C 退出
  ${NAME} status / stop / restart           看状态 / 停止 / 按上次参数重启
  ${NAME} ~/Downloads --pass s3cret       绑定指定目录，直接访问 http://ip:25250/
  ${NAME} ~/Downloads --mount /files       多一层 /files 前缀
  OHMY_PASS=s3cret ${NAME} /srv/files --port 9000

默认免认证网段: ${DEFAULT_TRUSTED.join(', ')}`

/**
 * 合并命令行与环境变量，得到运行配置。
 * @param {string[]} argv 不含 node/脚本路径的参数
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(argv = [], env = process.env) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: FLAG_OPTIONS,
    allowPositionals: true,
    strict: true,
  })

  if (values.help) return { help: true }
  if (values.version) return { version: true }

  if (positionals.length > 1) {
    throw new Error(`只能指定一个目录，收到多个参数: ${positionals.join(' ')}`)
  }

  // --- 监听地址 ---
  let host = firstString(values.host, env.OHMY_HOST)
  let portRaw = firstString(values.port, env.OHMY_PORT)
  const addr = firstString(values.addr, env.OHMY_ADDR)
  if (addr) {
    const { host: h, port: p } = splitHostPort(addr)
    if (h) host = h
    if (p !== null) portRaw = String(p)
  }
  host = firstString(host, DEFAULT_HOST)
  const port = Number(firstString(portRaw, String(DEFAULT_PORT)))
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`无效端口: ${portRaw}; 应为 0-65535`)
  }

  // --- 账号：密码可选，不填就是不启用认证 ---
  const username = firstString(values.user, env.OHMY_USER, DEFAULT_USER)
  if (!username) throw new Error('用户名不能为空')
  if (username.includes(':')) throw new Error('用户名不能包含冒号')

  const sha = firstString(values['pass-sha256'], env.OHMY_PASS_SHA256)
  let passHash = null
  if (sha) {
    if (!/^[0-9a-fA-F]{64}$/.test(sha.trim())) {
      throw new Error('--pass-sha256 需要 64 位十六进制 sha256 摘要')
    }
    passHash = Buffer.from(sha.trim(), 'hex')
  } else {
    const plain = firstString(values.pass, env.OHMY_PASS)
    if (plain !== undefined) passHash = sha256(plain)
  }
  // --- 认证方式 ---
  const auth = firstString(values.auth, env.OHMY_AUTH, 'form')
  if (auth !== 'form' && auth !== 'basic') {
    throw new Error(`无效的认证方式: ${auth}；只支持 form 或 basic`)
  }
  const sessionDays = Number(firstString(values['session-days'], env.OHMY_SESSION_DAYS, '7'))
  if (!Number.isFinite(sessionDays) || sessionDays <= 0 || sessionDays > 365) {
    throw new Error('--session-days 应为 0-365 之间的数字')
  }
  const rememberDays = Number(firstString(values['remember-days'], env.OHMY_REMEMBER_DAYS, '365'))
  if (!Number.isFinite(rememberDays) || rememberDays < 0 || rememberDays > 3650) {
    throw new Error('--remember-days 应为 0-3650 之间的数字（0 表示不提供“记住我”）')
  }

  // --- 账号文件 ---
  const usersFileRaw = firstString(values['users-file'], env.OHMY_USERS_FILE, DEFAULT_USERS_FILE)
  const usersFile = /^(none|off|false|no)$/i.test(usersFileRaw) ? null : path.resolve(usersFileRaw)
  const accounts = readAccounts(usersFile)

  const authRequired = Boolean(values['require-auth'] || env.OHMY_AUTH_REQUIRED === '1')
  const anonymous = !authRequired && passHash === null && accounts.count === 0
  const forceAnonymous = Boolean(values['allow-anonymous'] || env.OHMY_ALLOW_ANONYMOUS === '1')
  if (anonymous && values['require-password'] && !forceAnonymous) {
    throw new Error(
      '--require-password 已启用但未配置密码：请设置 OHMY_PASS / --pass，或 --pass-sha256',
    )
  }

  // --- 登录失败锁定 ---
  const accountMaxAttempts = Number(
    firstString(
      values['account-max-attempts'],
      env.OHMY_ACCOUNT_MAX_ATTEMPTS,
      String(DEFAULT_ACCOUNT_MAX_ATTEMPTS),
    ),
  )
  const accountMaxAttemptsExplicit =
    values['account-max-attempts'] !== undefined || env.OHMY_ACCOUNT_MAX_ATTEMPTS !== undefined
  if (!Number.isInteger(accountMaxAttempts) || accountMaxAttempts < 0 || accountMaxAttempts > 100) {
    throw new Error('--account-max-attempts 应为 0-100 的整数（0 表示不锁账号）')
  }
  const ipMaxAttempts = Number(
    firstString(values['ip-max-attempts'], env.OHMY_IP_MAX_ATTEMPTS, String(DEFAULT_IP_MAX_ATTEMPTS)),
  )
  const ipMaxAttemptsExplicit =
    values['ip-max-attempts'] !== undefined || env.OHMY_IP_MAX_ATTEMPTS !== undefined
  if (!Number.isInteger(ipMaxAttempts) || ipMaxAttempts < 0 || ipMaxAttempts > 100) {
    throw new Error('--ip-max-attempts 应为 0-100 的整数（0 表示不锁 IP）')
  }
  const lockoutMinutes = Number(
    firstString(values['lockout-minutes'], env.OHMY_LOCKOUT_MINUTES, String(DEFAULT_LOCKOUT_MINUTES)),
  )
  const lockoutMinutesExplicit =
    values['lockout-minutes'] !== undefined || env.OHMY_LOCKOUT_MINUTES !== undefined
  if (!Number.isFinite(lockoutMinutes) || lockoutMinutes < 0 || lockoutMinutes > 10080) {
    throw new Error('--lockout-minutes 应为 0-10080 之间的数字（0 表示不锁定）')
  }
  const bootstrap =
    passHash || (values.pass !== undefined || env.OHMY_PASS !== undefined)
      ? {
          username,
          password: firstString(values.pass, env.OHMY_PASS),
          passHash: passHash && !firstString(values.pass, env.OHMY_PASS) ? passHash : null,
          // 默认只在第一次建号时写入；已有账号就忽略，想强制改密码加 --reset-pass
          overwrite: Boolean(values['reset-pass']),
        }
      : null

  // --- 诊断：--check-ip ---
  let checkIp = null
  const checkIpRaw = firstString(values['check-ip'], env.OHMY_CHECK_IP)
  if (checkIpRaw) {
    checkIp = normalizeIP(checkIpRaw)
    if (!checkIp || !isIP(checkIp)) throw new Error(`--check-ip 不是合法 IP: ${checkIpRaw}`)
  }

  // --- 可信网段 ---
  const trusted = []
  if (!values['no-default-trusted']) {
    for (const cidr of DEFAULT_TRUSTED) trusted.push(parsePrefix(cidr))
  }
  for (const raw of splitList([...(values.trusted || []), env.OHMY_TRUSTED])) {
    const p = parsePrefix(raw)
    if (!p) throw new Error(`无效的免认证网段: ${raw}`)
    trusted.push(p)
  }
  trusted.sort((a, b) => b.prefixLen - a.prefixLen) // 长前缀在前，日志更好读

  // --- 免认证路径 ---
  const publicPaths = splitList([...(values.public || []), env.OHMY_PUBLIC])
  if (publicPaths.length === 0) publicPaths.push(...DEFAULT_PUBLIC)
  // 登录页（含首次创建管理员）本身必须免认证
  if ((authRequired || !anonymous) && auth === 'form') {
    for (const p of ['/login', '/logout']) if (!publicPaths.includes(p)) publicPaths.push(p)
  }

  // --- 绑定目录：位置参数 > --root > 环境变量 > 当前目录 ---
  const noFiles = Boolean(values['no-files'])
  const mountRaw = firstString(values.mount, env.OHMY_MOUNT)
  const mount = mountRaw ? normalizeMount(mountRaw) : null // 先校验格式，再校验组合

  const dirArg = positionals[0]
  const rootFlag = firstString(values.root, env.OHMY_ROOT)
  if (dirArg !== undefined && rootFlag !== undefined) {
    throw new Error(`目录参数与 --root 只能给一个（收到 "${dirArg}" 和 "${rootFlag}"）`)
  }
  if (noFiles && (dirArg !== undefined || rootFlag !== undefined || mount)) {
    throw new Error('--no-files 不能与目录参数 / --root / --mount 同时使用')
  }
  const base = {
    host,
    port,
    realm: firstString(values.realm, env.OHMY_REALM, DEFAULT_REALM),
    username,
    passHash,
    anonymous,
    authRequired,
    forceAnonymous,
    accountMaxAttempts,
    ipMaxAttempts,
    lockoutMinutes,
    accountMaxAttemptsExplicit,
    ipMaxAttemptsExplicit,
    lockoutMinutesExplicit,
    auth,
    sessionDays,
    rememberDays,
    usersFile,
    bootstrap,
    userCount: accounts.count,
    secureCookie: Boolean(values['secure-cookie']),
    trusted,
    publicPaths,
    honorXFF: !values['no-xff'],
    quiet: Boolean(values.quiet),
    hidden: Boolean(values.hidden),
    checkIp,
    daemon: Boolean(values.daemon),
    force: Boolean(values.force),
    stateDir: path.resolve(firstString(values['state-dir'], env.OHMY_STATE_DIR, DEFAULT_STATE_DIR)),
    registry: firstString(env.OHMY_REGISTRY, DEFAULT_REGISTRY),
    noUpdateCheck: Boolean(
      values['no-update-check'] ||
        env.OHMY_NO_UPDATE_CHECK === '1' ||
        env.NO_UPDATE_NOTIFIER === '1' ||
        env.CI === 'true' ||
        env.CI === '1',
    ),
  }
  // --- 后台 / 前台 ---
  // 默认后台运行；容器（PID 1）与 systemd 环境自动切前台，避免一启动就退出
  const explicitDaemon = Boolean(values.daemon)
  const explicitForeground = Boolean(values.foreground || env.OHMY_FOREGROUND === '1')
  // 容器（PID 1，或手动指定 OHMY_CONTAINER=1）与 systemd 环境自动切前台，
  // 否则服务一启动就“后台化”，容器/服务管理器会以为它退了
  const inContainer = (process.pid === 1 || env.OHMY_CONTAINER === '1') && !explicitDaemon
  const inSystemd = Boolean(env.INVOCATION_ID || env.NOTIFY_SOCKET) && !explicitDaemon
  // 前台优先级最高（同时给 -d -f 时以前台为准，更安全）
  const daemon = !explicitForeground && (explicitDaemon || (!inContainer && !inSystemd))
  const daemonAutoOff = daemon ? null : inContainer ? 'container' : inSystemd ? 'systemd' : null
  const runtimeMode = { daemon, explicitDaemon, explicitForeground, daemonAutoOff }

  if (noFiles) {
    return { ...base, ...runtimeMode, root: null, mount: null, rootInput: null, rootIsDefault: false }
  }

  const rootInput = dirArg ?? rootFlag ?? DEFAULT_ROOT
  const rootIsDefault = dirArg === undefined && rootFlag === undefined
  const root = path.resolve(rootInput)
  let ok = false
  try {
    ok = statSync(root).isDirectory()
  } catch {
    ok = false
  }
  if (!ok) {
    throw new Error(
      rootInput === '.'
        ? `当前目录不可访问: ${root}`
        : `绑定的目录不存在或不是目录: ${rootInput} (解析为 ${root})`,
    )
  }

  return { ...base, ...runtimeMode, root, mount: mount ?? DEFAULT_MOUNT, rootInput, rootIsDefault }
}

/** 读取账号文件里的账号数量（容错：文件坏了就当作没有）。 */
function readAccounts(file) {
  if (!file || !existsSync(file)) return { count: 0 }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { count: Array.isArray(raw.users) ? raw.users.length : 0 }
  } catch {
    return { count: 0 }
  }
}

/** 规范化挂载点：必须以 / 开头；去掉尾部斜杠（根路径除外）。 */export function normalizeMount(input) {
  let m = String(input || '').trim()
  if (!m) return DEFAULT_MOUNT
  if (!m.startsWith('/')) throw new Error(`--mount 必须以 / 开头: ${input}`)
  m = m.replace(/\/+$/, '')
  if (m === '') return '/'
  if (m.includes('..')) throw new Error(`--mount 不能包含 ..: ${input}`)
  return m
}
