import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** 一个已解析的 CIDR 网段。 */
export interface ParsedPrefix {
  /** 已按 prefixLen 掩码后的网络地址 */
  value: bigint
  prefixLen: number
  family: 4 | 6
  bits: 32 | 128
  /** 原始输入文本 */
  text: string
}

export type Role = 'admin' | 'member'

export interface AccessDecision {
  allowed: boolean
  method: 'public' | 'anonymous' | 'intranet-bypass' | 'password' | 'session' | 'none'
  ip: string | null
  peer: string | null
  viaProxy: boolean
  /** 没凭据时是否会被拦下来要求登录 */
  requiresPassword: boolean
  /** 命中的免认证网段，没命中为 null */
  matched: ParsedPrefix | null
  /** 已登录用户；未登录为 null */
  user: { username: string; role: Role } | null
}

export interface LogEntry {
  time: string
  ip: string
  peer: string | null
  viaProxy: boolean
  method: AccessDecision['method']
  user: string | null
  status: number
  durationMs: number
  requestMethod: string
  path: string
}

export interface ServerConfig {
  host: string
  port: number
  realm: string
  /** 引导管理员用户名（配合 --pass 使用） */
  username: string
  /** sha256 摘要；没有用 --pass 引导账号时为 null */
  passHash: Buffer | null
  anonymous: boolean
  /** --require-auth / OHMY_AUTH_REQUIRED=1：要求认证，但命令行不给密码 */
  authRequired: boolean
  /** 'form' = 登录页 + Cookie（默认，不弹浏览器窗口）；'basic' = 传统 Basic 弹窗 */
  auth: 'form' | 'basic'
  /** 不勾“记住我”时的会话天数 */
  sessionDays: number
  /** 勾上“记住我”后的会话天数；0 表示不提供该选项 */
  rememberDays: number
  /** 账号文件路径；null 表示不使用账号文件 */
  usersFile: string | null
  secureCookie: boolean
  trusted: ParsedPrefix[]
  publicPaths: string[]
  root: string | null
  /** 绑定目录的挂载点，默认 "/"（直接挂在根路径）；未绑定目录时为 null */
  mount: string | null
  /** 用户传入的原始目录（位置参数 / --root / OHMY_ROOT），未绑定目录时为 null */
  rootInput: string | null
  /** 是否使用了默认的当前目录 */
  rootIsDefault: boolean
  /** 是否列出/允许访问 . 开头的文件 */
  hidden: boolean
  /** --check-ip 指定的诊断 IP，未指定为 null */
  checkIp: string | null
  honorXFF: boolean
  quiet: boolean
  /** 运行时由 withAuthState 补充：有账号或给了密码 */
  authEnabled?: boolean
  /** 运行时由 withAuthState 补充：账号数量 */
  userCount?: number
  /** 后台运行（默认 true） */
  daemon: boolean
  /** 命令行显式给了 -d */
  explicitDaemon: boolean
  /** 命令行显式给了 -f 或 OHMY_FOREGROUND=1 */
  explicitForeground: boolean
  /** 自动切前台的原因：容器（PID 1 / OHMY_CONTAINER=1）或 systemd */
  daemonAutoOff: 'container' | 'systemd' | null
  /** --force：stop / restart 时等不到优雅退出就 SIGKILL */
  force: boolean
  /** PID 与日志文件存放目录，默认 ~/.oh-my-http */
  stateDir: string
  /** --allow-anonymous：即使已有账号也强制免认证 */
  forceAnonymous: boolean
  /** 同一账号连续失败多少次锁定（默认 3） */
  accountMaxAttempts: number
  /** 同一来源 IP 连续失败多少次锁定（默认 0 = 不按 IP 锁） */
  ipMaxAttempts: number
  /** 锁定时长（分钟，默认 60） */
  lockoutMinutes: number
  /** 查新版本用的 registry，默认 https://registry.npmjs.org（可用 OHMY_REGISTRY 换成镜像） */
  registry: string
  /** 关掉新版本检查 */
  noUpdateCheck: boolean
  /** 命令行是否显式指定了上面这些（显式时优先于后台设置） */
  accountMaxAttemptsExplicit: boolean
  ipMaxAttemptsExplicit: boolean
  lockoutMinutesExplicit: boolean
}

export const NAME: string
export const VERSION: string
export const BANNER: string
export const USAGE: string
export const DEFAULT_TRUSTED: string[]

/** 解析命令行参数与环境变量；抛出 Error 表示配置非法。`--help`/`--version` 时返回 { help | version: true }。
 *
 * 目录可以写成位置参数（`loadConfig(['.', '--pass', 'x'])`），默认 `"."` 即当前目录。
 */
export function loadConfig(
  argv?: string[],
  env?: Record<string, string | undefined>,
): ServerConfig | { help: true } | { version: true }

/** 规范化挂载点（必须以 / 开头，去尾斜杠）；非法抛出 Error。 */
export function normalizeMount(input: string): string
/** 把 URL 路径换算成绑定目录内的相对路径。 */
export function relativeToMount(urlPath: string, mount: string): string

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

/** 常数时间比对用户名与密码（表单与 Basic 共用）。 */
export function verifyUserPass(username: string, password: string, cfg: Pick<ServerConfig, 'username' | 'passHash'>): boolean
/** 常数时间校验 Basic 认证凭据。 */
export function checkCredentials(req: IncomingMessage, cfg: Pick<ServerConfig, 'username' | 'passHash'>): boolean
/** 从 Basic 头里取出用户名与密码。 */
export function basicAuthCredentials(req: IncomingMessage): { username: string; password: string } | null
/** 生成 Authorization 头值。 */
export function basicAuthHeader(username: string, password: string): string

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

/** 一个账号记录。密码是 scrypt 加盐哈希，不会存明文。 */
export interface AccountRecord {
  username: string
  role: Role
  disabled: boolean
  createdAt: string
  updatedAt: string
  lastLoginAt?: string
  /** 'scrypt' 为正常哈希；'sha256' 是 --pass-sha256 引导出来的旧格式 */
  algo: 'scrypt' | 'sha256'
  salt?: string
  hash: string
}

export interface AccountStore {
  readonly file: string | null
  /**
   * --pass / --user 引导账号的结果：
   * 'created' 首次建号 | 'updated' 加了 --reset-pass 强制覆盖 | 'ignored' 账号已存在（忽略）| 'none'
   */
  readonly bootstrapResult: 'created' | 'updated' | 'ignored' | 'none'
  /** 会话签名密钥，随账号文件一起持久化（重启后登录状态不失效） */
  readonly sessionSecret: Buffer
  readonly count: number
  readonly loadError: Error | null
  /** 后台里保存过的设置（登录保护策略等）；没保存过为 null */
  readonly settings: LockPolicySettings | null
  /** 保存设置并持久化 */
  saveSettings(next: LockPolicySettings): Promise<LockPolicySettings>
  list(): AccountRecord[]
  get(username: string): AccountRecord | null
  roleOf(username: string): Role | null
  /** 校验密码；touch=true 时更新最近登录时间并写盘（只有登录表单该用） */
  verify(username: string, password: string, touch?: boolean): boolean
  needsUpgrade(username: string): boolean
  adminCount(): number
  create(input: { username: string; password: string; role?: Role }): Promise<AccountRecord>
  remove(username: string): Promise<void>
  setPassword(username: string, password: string): Promise<void>
  setRole(username: string, role: Role): Promise<void>
  setDisabled(username: string, disabled: boolean): Promise<void>
  /** 原子写盘（tmp + rename，权限 0600） */
  persist(): Promise<void>
}

/**
 * 账号存储。bootstrap 用于把 `--user`/`--pass` 变成第一个管理员账号；
 * `file: null` 时账号只存在内存里。
 */
export function createAccountStore(options?: {
  file?: string | null
  bootstrap?: { username: string; password?: string; passHash?: Buffer } | null
}): AccountStore

/** 用户名只能包含字母、数字、`. _ -`，长度 1-32。 */
export function validUsername(name: string): boolean
/** 密码至少 MIN_PASSWORD 位。 */
export function validPassword(password: string): boolean
export const MIN_PASSWORD: number
export const ROLES: readonly Role[]

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export interface SessionStore {
  cookieName: string
  ttlMs: number
  /** 签发 token；ttlMs 用于“记住我”那种长期会话 */
  issue(username: string, now?: number, ttlMs?: number): string
  verify(token: string, now?: number): { username: string; expiresAt: number } | null
  cookieHeader(token: string, options?: { secure?: boolean; maxAge?: number }): string
  clearCookieHeader(options?: { secure?: boolean }): string
  /** 与会话绑定的 CSRF token */
  csrf(seed: string): string
  checkCsrf(seed: string, value: string): boolean
}

export function createSessionStore(options?: {
  secret?: Buffer
  ttlMs?: number
  cookieName?: string
}): SessionStore

/** 登录保护策略的持久化设置（管理后台可改）。 */
export interface LockPolicySettings {
  accountMaxAttempts?: number | string
  ipMaxAttempts?: number | string
  lockoutMinutes?: number | string
}

/** 一条锁定/失败记录。 */
export interface LockRecord {
  key: string
  kind: 'account' | 'ip'
  /** 账号名或 IP */
  target: string
  locked: boolean
  /** ISO 时间，未锁定为 null */
  lockedUntil: string | null
  /** 剩余秒数 */
  retryAfter: number
  /** 已累计的失败次数（已锁定为 0） */
  failures: number
  limit: number
}

/**
 * 登录失败锁定。默认**只按账号锁**（3 次 / 1 小时），IP 维度默认关闭。
 * 策略可在运行时修改（管理后台保存后立即生效）。
 */
export function createLoginThrottle(options?: {
  ipMaxAttempts?: number
  accountMaxAttempts?: number
  lockMs?: number
}): {
  readonly ipMaxAttempts: number
  readonly accountMaxAttempts: number
  readonly lockMs: number
  readonly lockoutMinutes: number
  readonly disabled: boolean
  readonly policy: { ipMaxAttempts: number; accountMaxAttempts: number; lockMs: number }
  readonly size: number
  check(key: string, now?: number): { allowed: boolean; locked: boolean; retryAfter: number; remaining: number; limit: number }
  /** fingerprint 相同的重复提交只算一次失败 */
  fail(key: string, now?: number, fingerprint?: string | null): { locked: boolean; retryAfter: number; remaining: number; limit: number; duplicate?: boolean }
  reset(key: string): void
  setPolicy(next?: { ipMaxAttempts?: number; accountMaxAttempts?: number; lockMs?: number; lockoutMinutes?: number }): { ipMaxAttempts: number; accountMaxAttempts: number; lockMs: number }
  /** 解除全部锁定，返回清掉了多少条 */
  clear(): number
  /** 解除单个 key */
  unlock(key: string): boolean
  /** 当前锁定/失败快照（管理后台展示用） */
  snapshot(now?: number): LockRecord[]
  lockedCount(now?: number): number
}
/** 账号维度的限流 key（避免同名 IP 冲突，大小写归一）。 */
export function accountKey(username: string): string
/** 凭据指纹：用于“同一个错误密码重复提交只算一次”。 */
export function credentialFingerprint(...parts: Array<string | undefined>): string

export function parseCookies(header: string | undefined): Record<string, string>
export function serializeCookie(
  name: string,
  value: string,
  options?: { maxAge?: number; path?: string; httpOnly?: boolean; sameSite?: string; secure?: boolean },
): string
/** 只放行站内相对路径，防开放重定向。 */
export function safeNext(next: unknown, fallback?: string): string

// ---------------------------------------------------------------------------
// IP / CIDR
// ---------------------------------------------------------------------------

/** 规范化 IP（去 zone id 与 IPv4-mapped 前缀）；非法返回 null。 */
export function normalizeIP(ip: string): string | null
export function ipToNumber(ip: string): { value: bigint; family: 4 | 6; bits: 32 | 128; text: string } | null
export function parsePrefix(input: string): ParsedPrefix | null
export function prefixContains(prefix: ParsedPrefix, ip: string): boolean
export function isTrusted(ip: string, prefixes: ParsedPrefix[]): boolean
/** 返回第一个命中的免认证网段，没命中返回 null。 */
export function matchPrefix(ip: string, prefixes: ParsedPrefix[]): ParsedPrefix | null
export function peerIP(req: IncomingMessage): string | null
/** 解析真实客户端 IP；仅当直连对端可信时才采信 X-Forwarded-For。 */
export function clientIP(
  req: IncomingMessage,
  options?: { trusted?: ParsedPrefix[]; honorXFF?: boolean },
): { ip: string | null; peer: string | null; viaProxy: boolean }

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface AuthState {
  session?: SessionStore | null
  store?: AccountStore | null
}

export function evaluateAccess(req: IncomingMessage, cfg: ServerConfig, state?: AuthState): AccessDecision
/** 当前请求的登录用户；未登录返回 null。 */
export function authenticatedUser(
  req: IncomingMessage,
  cfg: ServerConfig,
  state?: AuthState,
): { username: string; role: Role; method: 'session' | 'password' } | null
/** 配置有没有启用认证（有账号、给了密码，或 --require-auth；--allow-anonymous 时为 false）。 */
export function isAuthEnabled(cfg: ServerConfig): boolean
/** 启用了认证但一个账号都没有 → 需要首次创建管理员。 */
export function needsSetup(cfg: ServerConfig, store: AccountStore | null): boolean
/** 把账号存储的状态写回配置（authEnabled / userCount）。 */
export function withAuthState(cfg: ServerConfig, store: AccountStore | null): ServerConfig
/** 登录保护策略：命令行显式指定 > 管理后台保存的 > 默认值。 */
export function resolvePolicy(
  cfg: ServerConfig,
  store: AccountStore | null,
): {
  accountMaxAttempts: number
  ipMaxAttempts: number
  lockoutMinutes: number
  source: 'cli' | 'admin' | 'default'
}

/**
 * 纯函数版判定：给定来源 IP 与路径，说明会怎么处理（不涉及真实请求）。
 * 顺序：公共路径 → 未启用认证（全放行）→ 免认证网段 → 需要登录。
 */
export function explainAccess(
  ip: string | null,
  path: string,
  cfg: ServerConfig,
): {
  method: 'public' | 'anonymous' | 'intranet-bypass' | 'password'
  allowed: boolean
  requiresPassword: boolean
  matched: ParsedPrefix | null
  reason: string
}

export function createHandler(
  cfg: ServerConfig,
  options?: { logger?: (entry: LogEntry | Record<string, unknown>) => void; store?: AccountStore },
): (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function createServer(
  cfg: ServerConfig,
  options?: { logger?: (entry: LogEntry | Record<string, unknown>) => void; store?: AccountStore },
): Server

/** listen 的 Promise 包装，resolve 后服务已在监听。 */
export function listen(server: Server, cfg: Pick<ServerConfig, 'host' | 'port'>): Promise<Server>
export function lanAddresses(): string[]
export const MIME: Record<string, string>

// ---------------------------------------------------------------------------
// stop / status / restart
// ---------------------------------------------------------------------------

/** 内置子命令；第一个位置参数命中这些词时按命令处理。 */
export const COMMANDS: readonly string[]
export const DEFAULT_STATE_DIR: string

export interface RuntimeState {
  pid: number
  port: number
  host: string
  root: string | null
  mount: string | null
  auth: 'form' | 'basic'
  authEnabled: boolean
  userCount: number
  usersFile: string | null
  daemon: boolean
  /** 启动时的工作目录，restart 会在同一个目录下拉起来 */
  cwd: string
  /** 启动参数（--pass / --pass-sha256 的值已被隐藏） */
  argv: string[]
  /** 启动参数里是否出现过密码 */
  hadSecret: boolean
  startedAt: string
  version: string
  /** printState 时附加的展示用字段 */
  stateDir?: string
}

export function stateFileFor(port: number, dir?: string): string
export function logFileFor(port: number, dir?: string): string
export function writeState(state: Partial<RuntimeState>, file: string): string
export function readState(file: string): RuntimeState | null
export function removeState(file: string): void
export function listStates(dir?: string): RuntimeState[]
/** 'running' = 活着且确实是我们的进程；'dead' = 进程没了；'reused' = PID 被别的进程占了 */
export function stateStatus(state: Partial<RuntimeState> | null): 'running' | 'dead' | 'reused' | 'unknown'
export function isAlive(pid: number): boolean
/** 通过 ps 确认命令行里带 oh-my-http，避免误杀别人的进程 */
export function looksLikeOurs(pid: number): boolean
/** 先 SIGTERM，超时后（--force）才 SIGKILL；永远不会结束自己或父进程 */
export function stopProcess(
  pid: number | null,
  options?: { timeoutMs?: number; force?: boolean },
): Promise<{ ok: boolean; reason: string; pid?: number; forced?: boolean }>
/** 把 --pass / --pass-sha256 的值换成占位符，让密码不落盘 */
export function redactArgv(argv: string[]): { argv: string[]; hadSecret: boolean }
/** 把占位符整个丢掉（重启时靠账号文件里的密码） */
export function restoreArgv(argv: string[]): string[]
/** 去掉指定的布尔/带值参数（restart 时避免 --port 越滚越多） */
export function stripOptions(argv: string[], names: string[]): string[]
export function openLog(port: number, dir?: string): { file: string; fd: number }
export function waitForState(options: {
  file: string
  pid?: number
  timeoutMs?: number
}): Promise<{ ok: boolean; state?: RuntimeState; reason?: string }>
export function tailLog(file: string, lines?: number): string
export function humanDuration(ms: number): string
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
  urlPath: string,
): Promise<void>

// ---------------------------------------------------------------------------
// 新版本检查
// ---------------------------------------------------------------------------

export const DEFAULT_REGISTRY: string
export const CHECK_INTERVAL_MS: number
/** 解析 "1.2.3" / "v1.2.3" / "1.2.3-beta.1"；非法返回 null。 */
export function parseVersion(value: unknown): { major: number; minor: number; patch: number; pre: string | null } | null
/** a > b 返回 1，a < b 返回 -1，无法比较返回 0。 */
export function compareVersions(a: unknown, b: unknown): number
export function updateCacheFile(stateDir: string): string
export function readUpdateCache(file: string): { checkedAt?: string; latest?: string | null } | null
export function writeUpdateCache(file: string, data: object): boolean
/** 查 npm 上的最新版本；离线 / 超时 / 404 都静默返回 null。 */
export function fetchLatestVersion(options?: {
  name: string
  registry?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<string | null>
/** 带缓存的检查（默认 24 小时内只联网一次）。 */
export function checkForUpdate(options?: {
  name: string
  current: string
  cacheFile?: string
  registry?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: number
  force?: boolean
}): Promise<{ latest: string | null; newer: boolean; checkedAt: string | null; fromCache: boolean }>
/** 生成给用户看的升级提示。 */
export function upgradeHint(options: { name: string; current: string; latest: string; installCmd?: string }): string[]

export default createServer
