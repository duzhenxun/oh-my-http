import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  installService,
  launchdPlist,
  serviceFilePath,
  serviceLabel,
  servicePlatform,
  serviceSpec,
  serviceStatus,
  systemdUnit,
  systemdUnitName,
  uninstallService,
} from '../lib/service.js'

const opts = (extra = {}) => ({
  port: 25250,
  args: ['/Users/me/Downloads', '--pass', 's3cret'],
  binPath: '/opt/bin/oh-my-http.js',
  nodePath: '/usr/local/bin/node',
  cwd: '/Users/me',
  stateDir: '/Users/me/.oh-my-http',
  home: '/Users/me',
  ...extra,
})

test('servicePlatform / 命名', () => {
  assert.equal(servicePlatform('darwin'), 'launchd')
  assert.equal(servicePlatform('linux'), 'systemd')
  assert.equal(servicePlatform('win32'), 'unsupported')
  assert.equal(serviceLabel(25250), 'cn.xs25.oh-my-http.25250')
  assert.equal(systemdUnitName(25250), 'oh-my-http-25250.service')
  assert.equal(
    serviceFilePath(25250, { platform: 'darwin', home: '/Users/me' }),
    '/Users/me/Library/LaunchAgents/cn.xs25.oh-my-http.25250.plist',
  )
  assert.equal(
    serviceFilePath(25250, { platform: 'linux', home: '/home/me' }),
    '/home/me/.config/systemd/user/oh-my-http-25250.service',
  )
})

test('launchd plist：登录启动、KeepAlive、参数完整、日志进状态目录', () => {
  const plist = launchdPlist({
    nodePath: '/usr/local/bin/node',
    binPath: '/opt/bin/oh-my-http.js',
    args: ['/Users/me/Downloads', '--port', '25250', '--foreground'],
    port: 25250,
    cwd: '/Users/me',
    logFile: '/Users/me/.oh-my-http/service-25250.log',
  })
  assert.match(plist, /<string>cn\.xs25\.oh-my-http\.25250<\/string>/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/)
  assert.match(plist, /<string>\/opt\/bin\/oh-my-http\.js<\/string>/)
  assert.match(plist, /<string>\/Users\/me\/Downloads<\/string>/)
  assert.match(plist, /<string>--foreground<\/string>/)
  assert.match(plist, /\/Users\/me\/\.oh-my-http\/service-25250\.log/)
})

test('systemd unit：ExecStart / Restart / WantedBy', () => {
  const unit = systemdUnit({
    nodePath: '/usr/bin/node',
    binPath: '/opt/bin/oh-my-http.js',
    args: ['/srv/files', '--port', '25250', '--foreground'],
    port: 25250,
    cwd: '/srv',
  })
  assert.match(unit, /Description=oh-my-http on port 25250/)
  assert.match(unit, /WorkingDirectory=\/srv/)
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/bin\/oh-my-http\.js \/srv\/files --port 25250 --foreground/)
  assert.match(unit, /Restart=always/)
  assert.match(unit, /WantedBy=default\.target/)
})

test('serviceSpec：去掉后台/前台参数，补 --port 与 --foreground', () => {
  const darwin = serviceSpec(
    opts({ platform: 'darwin', args: ['/Users/me/Downloads', '-d', '--foreground', '-f'] }),
  )
  assert.equal(darwin.kind, 'launchd')
  assert.equal(darwin.file, '/Users/me/Library/LaunchAgents/cn.xs25.oh-my-http.25250.plist')
  // 没有 --port 时补上
  assert.match(darwin.content, /<string>--port<\/string>\s*<string>25250<\/string>/)
  assert.equal((darwin.content.match(/--foreground/g) || []).length, 1)
  assert.doesNotMatch(darwin.content, /\s-d\s/)

  const linux = serviceSpec(opts({ platform: 'linux', args: ['/srv/files', '--port=25251'] }))
  assert.equal(linux.kind, 'systemd')
  assert.match(linux.content, /--port=25251/)
  assert.match(linux.content, /--foreground/)
  assert.equal((linux.content.match(/--port/g) || []).length, 1, '已有 --port= 时不再补')

  const none = serviceSpec(opts({ platform: 'win32' }))
  assert.equal(none.kind, 'unsupported')
  assert.equal(none.file, null)
})

test('安装 / 卸载：写文件、执行命令、能清理干净', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ohmy-svc-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const stateDir = path.join(home, '.oh-my-http')

  const calls = []
  const exec = (cmd, args) => {
    calls.push([cmd, ...args])
    // 模拟「服务还没装过」：bootout 会失败
    if (args[0] === 'bootout') throw new Error('Could not find service')
  }

  const result = installService(opts({ platform: 'darwin', home, stateDir }), { exec })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'launchd')
  assert.ok(existsSync(result.file), 'plist 应写入磁盘')
  assert.match(readFileSync(result.file, 'utf8'), /cn\.xs25\.oh-my-http\.25250/)
  assert.ok(
    calls.some((c) => c[0] === 'launchctl' && c.includes('bootstrap')),
    '应执行 launchctl bootstrap',
  )
  assert.ok(
    calls.some((c) => c[0] === 'launchctl' && c.includes('kickstart')),
    '应执行 launchctl kickstart',
  )
  assert.equal(result.steps.at(-1).ok, true)

  const removed = uninstallService(opts({ platform: 'darwin', home, stateDir }), {
    exec: () => {},
  })
  assert.equal(removed.ok, true)
  assert.equal(existsSync(result.file), false, '卸载后 plist 应被删除')
})

test('status：能看出装没装、跑没跑', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ohmy-svc2-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const base = opts({ platform: 'darwin', home, stateDir: path.join(home, '.oh-my-http') })

  const before = serviceStatus(base, { exec: () => { throw new Error('not loaded') } })
  assert.equal(before.installed, false)
  assert.equal(before.active, false)

  installService(base, { exec: () => {} })
  const after = serviceStatus(base, { exec: () => {} })
  assert.equal(after.installed, true)
  assert.equal(after.active, true)
})
