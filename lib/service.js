import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 开机自启：macOS 用 LaunchAgent，Linux 用 systemd --user。
 *
 * 两者都是「用户级」服务：登录后自动启动（macOS 也可加到登录项）；
 * 想要开机不登录就启动，得用 root 级的 LaunchDaemon / systemd system 服务，这里不做。
 */

export const SERVICE_PREFIX = 'oh-my-http'

/** 当前平台支持哪种服务管理器。 */
export function servicePlatform(platform = process.platform) {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'linux') return 'systemd'
  return 'unsupported'
}

/** LaunchAgent 的 label（反向域名，按端口区分多实例）。 */
export function serviceLabel(port) {
  return `cn.xs25.${SERVICE_PREFIX}.${port}`
}

/** systemd user unit 文件名。 */
export function systemdUnitName(port) {
  return `${SERVICE_PREFIX}-${port}.service`
}

/** 服务定义文件放在哪。 */
export function serviceFilePath(port, { platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', `${serviceLabel(port)}.plist`)
  if (platform === 'linux') return path.join(home, '.config', 'systemd', 'user', systemdUnitName(port))
  return null
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** LaunchAgent plist（登录后启动、异常退出自动拉起、日志写进状态目录）。 */
export function launchdPlist({ nodePath, binPath, args, port, cwd, logFile }) {
  const label = serviceLabel(port)
  const program = [nodePath, binPath, ...args].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${program}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`
}

/** systemd user unit。 */
export function systemdUnit({ nodePath, binPath, args, port, cwd }) {
  const exec = [nodePath, binPath, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  return `[Unit]
Description=${SERVICE_PREFIX} on port ${port}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${exec}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
}

/**
 * 生成服务定义（纯函数，方便测试）。
 * @param {{platform?: string, home?: string, port: number, args: string[],
 *          nodePath?: string, binPath?: string, cwd?: string, stateDir: string}} options
 */
export function serviceSpec(options) {
  const {
    platform = process.platform,
    home = os.homedir(),
    port,
    args,
    nodePath = process.execPath,
    binPath,
    cwd = process.cwd(),
    stateDir,
  } = options
  const kind = servicePlatform(platform)
  if (kind === 'unsupported') {
    return { kind, label: serviceLabel(port), file: null, content: '', commands: null }
  }

  // launchd / systemd 都需要前台进程，别让 CLI 自己再 fork 一个后台进程
  const startArgs = args.filter((a) => a !== '--foreground' && a !== '-f' && a !== '--daemon' && a !== '-d' && a !== '--')
  if (!startArgs.some((a) => a === '--port' || a.startsWith('--port='))) {
    startArgs.push('--port', String(port))
  }
  startArgs.push('--foreground')

  const label = serviceLabel(port)
  const file = serviceFilePath(port, { platform, home })
  const logFile = path.join(stateDir, `service-${port}.log`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501

  if (kind === 'launchd') {
    return {
      kind,
      label,
      file,
      logFile,
      content: launchdPlist({ nodePath, binPath, args: startArgs, port, cwd, logFile }),
      commands: {
        install: [
          ['launchctl', ['bootout', `gui/${uid}/${label}`]],
          ['launchctl', ['bootstrap', `gui/${uid}`, file]],
          ['launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]],
        ],
        uninstall: [['launchctl', ['bootout', `gui/${uid}/${label}`]]],
        status: [['launchctl', ['print', `gui/${uid}/${label}`]]],
      },
    }
  }

  return {
    kind,
    label,
    file,
    logFile,
    content: systemdUnit({ nodePath, binPath, args: startArgs, port, cwd }),
    commands: {
      install: [
        ['systemctl', ['--user', 'daemon-reload']],
        ['systemctl', ['--user', 'enable', '--now', systemdUnitName(port)]],
      ],
      uninstall: [['systemctl', ['--user', 'disable', '--now', systemdUnitName(port)]]],
      status: [['systemctl', ['--user', 'is-active', systemdUnitName(port)]]],
    },
  }
}

/** 执行一组命令；与 install/uninstall 分离，方便测试。 */
function runCommands(commands, { exec = execFileSync, ignoreFailure = false } = {}) {
  const ran = []
  for (const [cmd, args] of commands) {
    try {
      exec(cmd, args, { stdio: 'pipe' })
      ran.push({ cmd, args, ok: true })
    } catch (err) {
      ran.push({ cmd, args, ok: false, error: String(err.message || err) })
      if (!ignoreFailure) break
    }
  }
  return ran
}

/**
 * 安装并立即启动。
 * @returns {{ok: boolean, kind: string, file: string|null, logFile?: string, steps: object[], error?: string}}
 */
export function installService(options, { exec } = {}) {
  const spec = serviceSpec(options)
  if (spec.kind === 'unsupported') {
    return {
      ok: false,
      kind: spec.kind,
      file: null,
      steps: [],
      error: 'unsupported_platform',
    }
  }
  mkdirSync(path.dirname(spec.file), { recursive: true })
  mkdirSync(path.dirname(spec.logFile), { recursive: true })
  writeFileSync(spec.file, spec.content, { mode: 0o644 })
  // 先尝试卸载旧的（不存在会失败，忽略），再加载
  runCommands(spec.commands.install.slice(0, -1), { exec, ignoreFailure: true })
  const steps = runCommands(spec.commands.install.slice(-1), { exec })
  return { ok: true, kind: spec.kind, file: spec.file, logFile: spec.logFile, steps }
}

/** 停止并删除服务定义。 */
export function uninstallService(options, { exec } = {}) {
  const spec = serviceSpec(options)
  if (spec.kind === 'unsupported') {
    return { ok: false, kind: spec.kind, file: null, steps: [], error: 'unsupported_platform' }
  }
  const steps = runCommands(spec.commands.uninstall, { exec, ignoreFailure: true })
  if (spec.file && existsSync(spec.file)) rmSync(spec.file, { force: true })
  return { ok: true, kind: spec.kind, file: spec.file, steps }
}

/** 查服务是否在跑（退出码 0 = active）。 */
export function serviceStatus(options, { exec } = {}) {
  const spec = serviceSpec(options)
  if (spec.kind === 'unsupported') return { ok: false, kind: spec.kind, active: false, installed: false }
  const installed = Boolean(spec.file && existsSync(spec.file))
  let active = false
  try {
    exec(spec.commands.status[0][0], spec.commands.status[0][1], { stdio: 'pipe' })
    active = true
  } catch {
    active = false
  }
  return { ok: true, kind: spec.kind, file: spec.file, installed, active }
}
