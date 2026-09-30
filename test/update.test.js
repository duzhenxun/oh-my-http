import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  checkForUpdate,
  compareVersions,
  fetchLatestVersion,
  parseVersion,
  readUpdateCache,
  updateCacheFile,
  upgradeHint,
  writeUpdateCache,
} from '../lib/update.js'

const tmpDir = async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-upd-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('版本号比较', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: null })
  assert.equal(parseVersion('1.2.3-beta.1').pre, 'beta.1')
  assert.equal(parseVersion('nope'), null)
  assert.equal(parseVersion(undefined), null)

  assert.equal(compareVersions('0.1.1', '0.1.0'), 1)
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1)
  assert.equal(compareVersions('0.1.1', '0.1.1'), 0)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1, '按数字比而不是字符串')
  assert.equal(compareVersions('0.2.0', '0.1.99'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1, '正式版比预发布版新')
  assert.equal(compareVersions('bad', '0.1.0'), 0, '无法比较时返回 0，不误报升级')
})

test('fetchLatestVersion：成功 / 失败 / 超时都要稳', async () => {
  const ok = await fetchLatestVersion({
    name: 'oh-my-http',
    registry: 'https://r.example/',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://r.example/oh-my-http/latest')
      return { ok: true, json: async () => ({ version: '9.9.9' }) }
    },
  })
  assert.equal(ok, '9.9.9')

  // 404 / 网络错误 / 返回体不对，都返回 null 而不是抛
  assert.equal(await fetchLatestVersion({ name: 'x', fetchImpl: async () => ({ ok: false, status: 404 }) }), null)
  assert.equal(await fetchLatestVersion({ name: 'x', fetchImpl: async () => { throw new Error('offline') } }), null)
  assert.equal(await fetchLatestVersion({ name: 'x', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), null)
  assert.equal(await fetchLatestVersion({ name: 'x', fetchImpl: null }), null)

  // 卡住时要能超时返回
  const slow = await fetchLatestVersion({
    name: 'x',
    timeoutMs: 50,
    fetchImpl: (url, opts) =>
      new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  })
  assert.equal(slow, null)
})

test('checkForUpdate：24 小时内用缓存，不重复联网', async (t) => {
  const dir = await tmpDir(t)
  const cacheFile = updateCacheFile(dir)
  assert.equal(path.basename(cacheFile), 'update-check.json')

  let calls = 0
  const fetchImpl = async () => {
    calls++
    return { ok: true, json: async () => ({ version: '0.2.0' }) }
  }

  const first = await checkForUpdate({ name: 'oh-my-http', current: '0.1.1', cacheFile, fetchImpl })
  assert.equal(first.latest, '0.2.0')
  assert.equal(first.newer, true)
  assert.equal(first.fromCache, false)
  assert.equal(calls, 1)

  // 再查一次：命中缓存，不联网
  const second = await checkForUpdate({ name: 'oh-my-http', current: '0.1.1', cacheFile, fetchImpl })
  assert.equal(second.fromCache, true)
  assert.equal(second.newer, true)
  assert.equal(calls, 1, '缓存期内不应该再联网')

  // 缓存过期后会再查，force 也能强制查
  const later = await checkForUpdate({ name: 'oh-my-http', current: '0.1.1', cacheFile, fetchImpl, now: Date.now() + 25 * 3600 * 1000 })
  assert.equal(later.fromCache, false)
  assert.equal(calls, 2)
  await checkForUpdate({ name: 'oh-my-http', current: '0.1.1', cacheFile, fetchImpl, force: true })
  assert.equal(calls, 3)

  // 当前就是最新版 → 不提示
  const same = await checkForUpdate({ name: 'oh-my-http', current: '0.2.0', cacheFile, fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.2.0' }) }), force: true })
  assert.equal(same.newer, false)

  // 本地版本比线上新（自己改过版本号）→ 也不提示
  const ahead = await checkForUpdate({ name: 'oh-my-http', current: '9.0.0', cacheFile, fetchImpl, force: true })
  assert.equal(ahead.newer, false)
})

test('checkForUpdate：离线时也写缓存，不反复联网，也不崩', async (t) => {
  const dir = await tmpDir(t)
  const cacheFile = updateCacheFile(dir)
  let calls = 0
  const offline = async () => {
    calls++
    throw new Error('ENOTFOUND')
  }

  const first = await checkForUpdate({ name: 'oh-my-http', current: '0.1.1', cacheFile, fetchImpl: offline })
  assert.equal(first.latest, null)
  assert.equal(first.newer, false)
  assert.equal(readUpdateCache(cacheFile).latest, null)

  await checkForUpdate({ name: 'oh-my-http', current: '0.1.1', cacheFile, fetchImpl: offline })
  assert.equal(calls, 1, '失败也记时间，避免每次启动都去连')

  // 没有 cacheFile 也不报错（比如 stateDir 不可写）
  const noCache = await checkForUpdate({ name: 'oh-my-http', current: '0.1.1', fetchImpl: offline })
  assert.equal(noCache.latest, null)
})

test('缓存文件损坏 / 升级提示文案', async (t) => {
  const dir = await tmpDir(t)
  const file = updateCacheFile(dir)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, '{ 坏的 json')
  assert.equal(readUpdateCache(file), null, '坏了当没有，不抛异常')
  assert.equal(readUpdateCache(path.join(dir, 'nope.json')), null)
  assert.equal(writeUpdateCache(file, { checkedAt: 'x', latest: '1.0.0' }), true)

  const hint = upgradeHint({ name: 'oh-my-http', current: '0.1.1', latest: '0.2.0' })
  assert.equal(hint.length, 2)
  assert.match(hint[0], /0\.1\.1 → 0\.2\.0/)
  assert.match(hint[1], /npm i -g oh-my-http/)
  assert.match(upgradeHint({ name: 'x', current: '1.0.0', latest: '2.0.0', installCmd: 'brew upgrade x' })[1], /brew upgrade x/)
})
