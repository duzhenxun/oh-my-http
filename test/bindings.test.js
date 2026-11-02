import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { basicAuthHeader } from '../lib/auth.js'
import { loadConfig } from '../lib/config.js'
import { defaultBinding, matchBinding, normalizeBinding, normalizeBindings, normalizeBindPath } from '../lib/mounts.js'
import { createServer, listen } from '../lib/server.js'
import { createSessionStore } from '../lib/session.js'

const FORM = { 'content-type': 'application/x-www-form-urlencoded' }
const form = (o) => new URLSearchParams(o).toString()

async function tmpDir(t, prefix, files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name)
    if (content === null) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return dir
}

async function startServer(t, argv) {
  const cfg = loadConfig(argv, {})
  const server = createServer(cfg)
  await listen(server, { host: '127.0.0.1', port: 0 })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  return { cfg, server, base: `http://127.0.0.1:${port}` }
}

/** 登录成管理员，返回 cookie 和 /admin 页面里的 csrf。 */
async function adminSession(base) {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: FORM,
    body: form({ username: 'admin', password: 'p' }),
    redirect: 'manual',
  })
  assert.equal(res.status, 303)
  const cookie = (res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie') || '').split(';')[0]
  const page = await fetch(`${base}/admin`, { headers: { cookie } })
  assert.equal(page.status, 200)
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1]
  // 账号动作发到 /admin/users，绑定动作发到 /admin/bindings（两个 tab 各管各的）
  const BINDING_ACTIONS = new Set([
    'add-binding',
    'delete-binding',
    'save-default',
    'clear-default',
    'set-binding-auth',
    'clear-binding-auth',
    'share-binding',
    'auto-binding-auth',
  ])
  const act = (fields) =>
    fetch(`${base}${BINDING_ACTIONS.has(fields.action) ? '/admin/bindings' : '/admin/users'}`, {
      method: 'POST',
      headers: { cookie, ...FORM },
      body: form({ csrf, ...fields }),
      redirect: 'manual',
    })
  return { cookie, csrf, act }
}

const get = (base, p, cookie) => fetch(`${base}${p}`, { headers: cookie ? { cookie } : {} })

test('子目录绑定：后台添加后立即生效，删除立即失效', async (t) => {
  const main = await tmpDir(t, 'ohmy-bind-main-', { 'hello.txt': 'main hello' })
  const alpha = await tmpDir(t, 'ohmy-bind-alpha-', {
    'a.txt': 'alpha a',
    'sub/nested.txt': 'alpha nested',
    '.secret': 'top secret',
  })
  const usersFile = path.join(await tmpDir(t, 'ohmy-bind-users-'), 'users.json')
  const { base } = await startServer(t, [
    '--pass', 'p',
    '--no-default-trusted',
    '--root', main,
    '--users-file', usersFile,
  ])

  // 没登录之前，绑定路径也是受保护的
  assert.equal((await get(base, '/abc/a.txt')).status, 401)

  const { cookie, act } = await adminSession(base)

  // 主目录照常
  assert.equal(await (await get(base, '/hello.txt', cookie)).text(), 'main hello')
  assert.equal((await get(base, '/abc/a.txt', cookie)).status, 404)

  // 添加绑定
  const added = await act({ action: 'add-binding', bind_path: '/abc', bind_dir: alpha })
  assert.equal(added.status, 303)
  assert.match(added.headers.get('location'), /\/admin\/bindings\?ok=bound/)

  // 同一个进程，不重启就已经生效
  assert.equal(await (await get(base, '/abc/a.txt', cookie)).text(), 'alpha a')
  assert.equal(await (await get(base, '/abc/sub/nested.txt', cookie)).text(), 'alpha nested')
  const listing = await (await get(base, '/abc/', cookie)).text()
  assert.match(listing, /a\.txt/)
  assert.match(listing, /href="\/abc\/sub\/"/)
  // 主目录没有被影响
  assert.equal(await (await get(base, '/hello.txt', cookie)).text(), 'main hello')
  assert.equal((await get(base, '/a.txt', cookie)).status, 404)

  // 隐藏文件与目录穿越规则照旧
  assert.equal((await get(base, '/abc/.secret', cookie)).status, 404)
  for (const attack of ['/abc/..%2f..%2fetc/hosts', '/abc/%2e%2e%2f%2e%2e%2fetc%2fhosts']) {
    const res = await get(base, attack, cookie)
    assert.ok([403, 404].includes(res.status), `${attack} 期望 403/404，实际 ${res.status}`)
  }

  // 后台页面能看到这条绑定
  assert.match(await (await get(base, '/admin/bindings', cookie)).text(), /\/abc\//)

  // 删除后立即 404，主目录不受影响
  const removed = await act({ action: 'delete-binding', bind_path: '/abc' })
  assert.equal(removed.status, 303)
  assert.equal(removed.headers.get('location'), '/admin/bindings?ok=unbound')
  assert.equal((await get(base, '/abc/a.txt', cookie)).status, 404)
  assert.equal(await (await get(base, '/hello.txt', cookie)).text(), 'main hello')

  // 删除不存在的绑定给出提示，不会 500
  const gone = await act({ action: 'delete-binding', bind_path: '/nope' })
  assert.equal(gone.headers.get('location'), '/admin/bindings?err=notfound')
})

test('子目录绑定：嵌套按最长前缀匹配，可以绑多层', async (t) => {
  const main = await tmpDir(t, 'ohmy-bind2-main-', { 'root.txt': 'root' })
  const alpha = await tmpDir(t, 'ohmy-bind2-alpha-', { 'sub/x.txt': 'alpha sub', 'x.txt': 'alpha x' })
  const beta = await tmpDir(t, 'ohmy-bind2-beta-', { 'y.txt': 'beta y' })
  const usersFile = path.join(await tmpDir(t, 'ohmy-bind2-users-'), 'users.json')
  const { base } = await startServer(t, [
    '--pass', 'p',
    '--no-default-trusted',
    '--root', main,
    '--users-file', usersFile,
  ])
  const { cookie, act } = await adminSession(base)

  assert.equal((await act({ action: 'add-binding', bind_path: '/abc', bind_dir: alpha })).status, 303)
  assert.equal((await act({ action: 'add-binding', bind_path: '/abc/sub', bind_dir: beta })).status, 303)

  assert.equal(await (await get(base, '/abc/x.txt', cookie)).text(), 'alpha x')
  // /abc/sub 更长的前缀赢过 /abc
  assert.equal(await (await get(base, '/abc/sub/y.txt', cookie)).text(), 'beta y')
  assert.equal((await get(base, '/abc/sub/x.txt', cookie)).status, 404)

  // 删掉更具体的那条，回到上一级绑定
  assert.equal((await act({ action: 'delete-binding', bind_path: '/abc/sub' })).status, 303)
  assert.equal(await (await get(base, '/abc/sub/x.txt', cookie)).text(), 'alpha sub')
})

test('子目录绑定：非法输入被拒，且有明确提示', async (t) => {
  const main = await tmpDir(t, 'ohmy-bind3-main-', { 'root.txt': 'root' })
  const usersFile = path.join(await tmpDir(t, 'ohmy-bind3-users-'), 'users.json')
  const { base } = await startServer(t, [
    '--pass', 'p',
    '--no-default-trusted',
    '--root', main,
    '--users-file', usersFile,
  ])
  const { cookie, act } = await adminSession(base)

  const err = async (fields) => (await act(fields)).headers.get('location')
  // 没带 / 开头
  assert.match(await err({ action: 'add-binding', bind_path: 'abc', bind_dir: main }), /err=bind_invalid/)
  // 占用内置接口
  assert.match(await err({ action: 'add-binding', bind_path: '/admin', bind_dir: main }), /err=bind_reserved/)
  assert.match(await err({ action: 'add-binding', bind_path: '/api/x', bind_dir: main }), /err=bind_reserved/)
  // 目录不存在
  assert.match(
    await err({ action: 'add-binding', bind_path: '/ghost', bind_dir: path.join(main, 'nope') }),
    /err=bind_missing/,
  )
  // 根路径留给「默认目录」
  assert.match(await err({ action: 'add-binding', bind_path: '/', bind_dir: main }), /err=bind_root/)

  // 成功一次之后不允许重复绑定同一路径
  assert.equal((await act({ action: 'add-binding', bind_path: '/ok', bind_dir: main })).status, 303)
  assert.match(await err({ action: 'add-binding', bind_path: '/ok/', bind_dir: main }), /err=bind_exists/)

  // 全程只写入了那一条
  const saved = JSON.parse(await readFile(usersFile, 'utf8'))
  assert.deepEqual(saved.settings.mounts, [{ mount: '/ok', root: main }])
  assert.equal(await (await get(base, '/ok/root.txt', cookie)).text(), 'root')
})

test('子目录绑定：重启后依旧有效（存在账号文件里）', async (t) => {
  const main = await tmpDir(t, 'ohmy-bind4-main-', { 'root.txt': 'root' })
  const alpha = await tmpDir(t, 'ohmy-bind4-alpha-', { 'a.txt': 'alpha' })
  const usersFile = path.join(await tmpDir(t, 'ohmy-bind4-users-'), 'users.json')
  const argv = ['--pass', 'p', '--no-default-trusted', '--root', main, '--users-file', usersFile]

  const first = await startServer(t, argv)
  const { act } = await adminSession(first.base)
  assert.equal((await act({ action: 'add-binding', bind_path: '/abc', bind_dir: alpha })).status, 303)
  const cookie = (await adminSession(first.base)).cookie
  assert.equal(await (await get(first.base, '/abc/a.txt', cookie)).text(), 'alpha')

  // 换一个进程（同一个账号文件）仍然生效
  const second = await startServer(t, argv)
  const again = await adminSession(second.base)
  assert.equal(await (await get(second.base, '/abc/a.txt', again.cookie)).text(), 'alpha')
  assert.match(await (await get(second.base, '/admin/bindings', again.cookie)).text(), /\/abc\//)
})

test('默认目录：后台设置后 / 立即变成该目录，清除后回到命令行绑定', async (t) => {
  const main = await tmpDir(t, 'ohmy-def-main-', { 'hello.txt': 'main hello' })
  const alpha = await tmpDir(t, 'ohmy-def-alpha-', { 'a.txt': 'alpha a' })
  const beta = await tmpDir(t, 'ohmy-def-beta-', { 'b.txt': 'beta b' })
  const usersFile = path.join(await tmpDir(t, 'ohmy-def-users-'), 'users.json')
  const { base } = await startServer(t, [
    '--pass', 'p',
    '--no-default-trusted',
    '--root', main,
    '--users-file', usersFile,
  ])
  const { cookie, act } = await adminSession(base)

  // 一开始是命令行的 --root
  assert.equal(await (await get(base, '/hello.txt', cookie)).text(), 'main hello')
  assert.match(await (await get(base, '/admin/bindings', cookie)).text(), /来自命令行/)

  // 设默认目录 → 立即生效（同一个进程）
  const saved = await act({ action: 'save-default', default_dir: alpha })
  assert.equal(saved.status, 303)
  assert.match(saved.headers.get('location'), /\/admin\/bindings\?ok=default_bound/)
  assert.equal(await (await get(base, '/a.txt', cookie)).text(), 'alpha a')
  assert.equal((await get(base, '/hello.txt', cookie)).status, 404)
  assert.match(await (await get(base, '/admin/bindings', cookie)).text(), /后台设置，优先于命令行/)

  // 子路径仍然赢过默认目录
  assert.equal((await act({ action: 'add-binding', bind_path: '/deep', bind_dir: beta })).status, 303)
  assert.equal(await (await get(base, '/deep/b.txt', cookie)).text(), 'beta b')
  assert.equal(await (await get(base, '/a.txt', cookie)).text(), 'alpha a')

  // 清除默认目录 → 回到命令行绑定，子路径不受影响
  const cleared = await act({ action: 'clear-default' })
  assert.equal(cleared.status, 303)
  assert.equal(cleared.headers.get('location'), '/admin/bindings?ok=default_cleared')
  assert.equal(await (await get(base, '/hello.txt', cookie)).text(), 'main hello')
  assert.equal((await get(base, '/a.txt', cookie)).status, 404)
  assert.equal(await (await get(base, '/deep/b.txt', cookie)).text(), 'beta b')

  // 清除不存在的默认目录不会 500
  assert.equal((await act({ action: 'clear-default' })).headers.get('location'), '/admin/bindings?err=notfound')

  // 持久化：settings.mounts 里只有子路径那一条
  const savedFile = JSON.parse(await readFile(usersFile, 'utf8'))
  assert.deepEqual(savedFile.settings.mounts, [{ mount: '/deep', root: beta }])
})

test('默认目录：--no-files 也能用后台默认目录，不写命令行就能浏览文件', async (t) => {
  const alpha = await tmpDir(t, 'ohmy-def2-alpha-', { 'a.txt': 'alpha a', 'sub/n.txt': 'nested' })
  const usersFile = path.join(await tmpDir(t, 'ohmy-def2-users-'), 'users.json')
  const argv = ['--pass', 'p', '--no-default-trusted', '--no-files', '--users-file', usersFile]

  const first = await startServer(t, argv)
  const { cookie, act } = await adminSession(first.base)
  assert.equal((await get(first.base, '/a.txt', cookie)).status, 404)

  assert.equal((await act({ action: 'save-default', default_dir: alpha })).status, 303)
  assert.equal(await (await get(first.base, '/a.txt', cookie)).text(), 'alpha a')
  assert.equal(await (await get(first.base, '/sub/n.txt', cookie)).text(), 'nested')
  assert.match(await (await get(first.base, '/', cookie)).text(), /a\.txt/)
  // 内置接口还在
  assert.equal((await get(first.base, '/healthz', cookie)).status, 200)

  // 重启后默认目录依旧生效（现在完全不需要命令行给目录）
  const second = await startServer(t, argv)
  const again = await adminSession(second.base)
  assert.equal(await (await get(second.base, '/a.txt', again.cookie)).text(), 'alpha a')
})

test('目录输入：候选下拉 + 弹窗浏览接口 + 手输', async (t) => {
  const main = await tmpDir(t, 'ohmy-pick-main-', {
    'root.txt': 'root',
    'one/a.txt': 'A',
    'two/b.txt': 'B',
    'x<y/c.txt': 'C',
  })
  const usersFile = path.join(await tmpDir(t, 'ohmy-pick-users-'), 'users.json')
  const { base } = await startServer(t, [
    '--pass', 'p',
    '--no-default-trusted',
    '--root', main,
    '--users-file', usersFile,
  ])
  const { cookie, act } = await adminSession(base)

  const page = await (await get(base, '/admin/bindings', cookie)).text()
  // datalist 候选里带命令行目录
  assert.ok(page.includes('<datalist id="dir-options">'))
  assert.ok(page.includes(`<option value="${main}"></option>`), '候选里应有命令行目录')
  // 两个目录输入框都有「浏览…」按钮，页面上有弹窗容器和接口地址
  assert.ok(page.includes('data-browse="dd"'), '默认目录应有浏览按钮')
  assert.ok(page.includes('data-browse="bd"'), '绑定目录应有浏览按钮')
  assert.ok(page.includes('id="dir-modal"'), '应有浏览弹窗')
  assert.ok(page.includes('/admin/api/dirs'), '弹窗应调用目录接口')
  // 仿 Finder 的两栏结构：侧栏 + 列表头 + 底部按钮
  assert.ok(page.includes('选择项目文件夹'))
  assert.ok(page.includes('mk-side'))
  for (const col of ['名称', '大小', '类型', '修改日期']) assert.ok(page.includes(col), `应有 ${col} 列`)
  // 绑定表格多了「有效期 / 结束时间」两列，且不再有「取消口令」
  for (const col of ['有效期', '结束时间']) assert.ok(page.includes(col), `应有 ${col} 列`)
  assert.ok(!page.includes('取消口令'), '不应再有取消口令按钮')
  assert.ok(page.includes('>取消<') && page.includes('>选取<'))

  // 弹窗数据接口：只列目录、给父目录、给快捷入口
  const one = path.join(main, 'one')
  const listing = await (
    await get(base, `/admin/api/dirs?path=${encodeURIComponent(main)}`, cookie)
  ).json()
  assert.equal(listing.path, main)
  assert.equal(listing.parent, path.dirname(main))
  assert.equal(listing.error, null)
  // 目录在前、同类按名字排；文件也列出来（跟 Finder 一样，但只有目录能选）
  const dirs = listing.entries.filter((e) => e.dir)
  assert.deepEqual(dirs.map((e) => e.name), ['one', 'two', 'x<y'])
  assert.ok(listing.entries.every((e) => e.path.startsWith(main)))
  const file = listing.entries.find((e) => e.name === 'root.txt')
  assert.ok(file, '文件也应列出（只是不可选）')
  assert.equal(file.dir, false)
  assert.equal(file.size, 4)
  assert.ok(file.mtime && file.kind, '文件应带类型与修改时间')
  assert.equal(dirs[0].kind, '文件夹')
  assert.ok(listing.roots.length > 0)
  assert.ok(listing.roots.some((r) => r.name === '家目录' && r.kind === 'favorite'))
  assert.ok(listing.roots.some((r) => r.kind === 'location'))

  // 不存在的目录：200 + error，不炸
  const bad = await (await get(base, '/admin/api/dirs?path=/definitely/not/here', cookie)).json()
  assert.deepEqual(bad.entries, [])
  assert.match(bad.error, /不存在|没有读取权限/)

  // 接口只给管理员
  assert.equal((await get(base, '/admin/api/dirs?path=/')).status, 401)

  // 手输：完全不在候选列表里的新目录，照样能保存并立即生效
  const manual = await tmpDir(t, 'ohmy-pick-manual-', { 'm.txt': 'manual' })
  assert.equal((await act({ action: 'save-default', default_dir: manual })).status, 303)
  assert.equal(await (await get(base, '/m.txt', cookie)).text(), 'manual')
})

test('子路径绑定：可以单独设账号密码（Basic 弹框，跟主站无关）', async (t) => {
  const main = await tmpDir(t, 'ohmy-auth-main-', { 'hello.txt': 'main' })
  const alpha = await tmpDir(t, 'ohmy-auth-alpha-', { 'a.txt': 'alpha secret' })
  const usersFile = path.join(await tmpDir(t, 'ohmy-auth-users-'), 'users.json')
  // 不加 --no-default-trusted：主站从本机访问是免认证的，用来验证独立账号不受它影响
  const { base } = await startServer(t, ['--pass', 'p', '--root', main, '--users-file', usersFile])
  const { cookie, act } = await adminSession(base)

  // 加一条带独立账号的绑定
  const added = await act({
    action: 'add-binding',
    bind_path: '/abc',
    bind_dir: alpha,
    bind_user: 'team',
    bind_pass: 'team-pass',
  })
  assert.equal(added.status, 303)

  // 没有凭据：401 + 浏览器 Basic 弹框（不是跳登录页）
  const denied = await get(base, '/abc/a.txt', cookie)
  assert.equal(denied.status, 401)
  assert.match(denied.headers.get('www-authenticate') || '', /^Basic realm="oh-my-http \/abc"/)

  // 密码错、账号错都不行
  const wrong = (username, password) =>
    fetch(`${base}/abc/a.txt`, { headers: { authorization: basicAuthHeader(username, password) } })
  assert.equal((await wrong('team', 'nope')).status, 401)
  assert.equal((await wrong('admin', 'p')).status, 401)

  // 用绑定自己的账号密码就能看
  const ok = await wrong('team', 'team-pass')
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), 'alpha secret')
  // 主站 Cookie 也能叠加（不影响）
  assert.equal((await fetch(`${base}/abc/a.txt`, {
    headers: { cookie, authorization: basicAuthHeader('team', 'team-pass') },
  })).status, 200)

  // 主站本身依旧是本机免认证（没被绑定账号带偏）
  assert.equal((await get(base, '/hello.txt')).status, 200)

  // 后台表格里能看到独立账号
  const page = await (await get(base, '/admin/bindings', cookie)).text()
  assert.match(page, /账号 \+ 密码/)
  assert.match(page, /team/)

  // 密码只存哈希，不落明文
  const saved = JSON.parse(await readFile(usersFile, 'utf8'))
  const stored = saved.settings.mounts.find((b) => b.mount === '/abc')
  assert.equal(stored.auth.username, 'team')
  assert.equal(stored.auth.algo, 'scrypt')
  assert.ok(stored.auth.salt && stored.auth.hash)
  assert.ok(!JSON.stringify(stored).includes('team-pass'), '不应保存明文密码')

  // 改密码：旧密码立即失效
  assert.equal(
    (await act({ action: 'set-binding-auth', bind_path: '/abc', bind_user: 'team', bind_pass: 'new-pass' })).status,
    303,
  )
  assert.equal((await wrong('team', 'team-pass')).status, 401)
  assert.equal((await wrong('team', 'new-pass')).status, 200)

  // 取消独立账号：回到跟随主站（本机直接可看）
  assert.equal((await act({ action: 'clear-binding-auth', bind_path: '/abc' })).status, 303)
  assert.equal(await (await get(base, '/abc/a.txt', cookie)).text(), 'alpha secret')
  const after = JSON.parse(await readFile(usersFile, 'utf8'))
  assert.equal(after.settings.mounts.find((b) => b.mount === '/abc').auth, undefined)
})

test('子路径绑定的独立账号：校验与后台页面隔离', async (t) => {
  const main = await tmpDir(t, 'ohmy-auth2-main-', { 'hello.txt': 'main' })
  const usersFile = path.join(await tmpDir(t, 'ohmy-auth2-users-'), 'users.json')
  const { base } = await startServer(t, [
    '--pass', 'p',
    '--no-default-trusted',
    '--root', main,
    '--users-file', usersFile,
  ])
  const { cookie, act } = await adminSession(base)

  const loc = async (fields) => (await act(fields)).headers.get('location')
  // 只填用户名不行（密码不能为空）
  assert.match(
    await loc({ action: 'add-binding', bind_path: '/u', bind_dir: main, bind_user: 'team' }),
    /err=bind_auth_pass/,
  )
  // 密码太短
  assert.match(
    await loc({ action: 'add-binding', bind_path: '/u', bind_dir: main, bind_user: 'team', bind_pass: '123' }),
    /err=bind_auth_pass/,
  )
  // 用户名非法
  assert.match(
    await loc({ action: 'add-binding', bind_path: '/u', bind_dir: main, bind_user: 'a b', bind_pass: 'team-pass' }),
    /err=bind_auth_user/,
  )

  // 两个页面各管各的动作：绑定动作不能从账号页提交
  const crossed = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: { cookie, ...FORM },
    body: form({ csrf: (await (await get(base, '/admin', cookie)).text()).match(/name="csrf" value="([^"]+)"/)[1], action: 'add-binding', bind_path: '/x', bind_dir: main }),
    redirect: 'manual',
  })
  assert.equal(crossed.headers.get('location'), '/admin?err=bad_request')

  // 页面结构：两个 tab 都在
  const bindingsHtml = await (await get(base, '/admin/bindings', cookie)).text()
  assert.match(bindingsHtml, /class="tab on" href="\/admin\/bindings"/)
  assert.match(bindingsHtml, /href="\/admin"/)
  const usersHtml = await (await get(base, '/admin', cookie)).text()
  assert.match(usersHtml, /class="tab on" href="\/admin"/)
  assert.match(usersHtml, /href="\/admin\/bindings"/)
  // 账号页里不再有绑定区块
  assert.doesNotMatch(usersHtml, /子路径绑定/)
})

test('只密码的绑定：?toke= 免输入、可当分享链接', async (t) => {
  const main = await tmpDir(t, 'ohmy-share-main-', { 'hello.txt': 'main' })
  const gp = await tmpDir(t, 'ohmy-share-gp-', { 'a.txt': 'gp secret', 'sub/b.txt': 'deep' })
  const usersFile = path.join(await tmpDir(t, 'ohmy-share-users-'), 'users.json')
  // 主站本机免认证，用来验证绑定口令是独立的一套
  const { base } = await startServer(t, ['--pass', 'p', '--root', main, '--users-file', usersFile])
  const { cookie, act } = await adminSession(base)

  // 只设密码（不带账号）
  const added = await act({ action: 'add-binding', bind_path: '/gp', bind_dir: gp, bind_pass: 's3cret-pw' })
  assert.equal(added.status, 303)
  const loc = added.headers.get('location')
  assert.match(loc, /ok=bound/)
  assert.match(loc, /share=/, '刚设完要能拿到分享链接')
  assert.match(loc, /days=3/, '分享链接默认 3 天')
  assert.ok(!loc.includes('s3cret-pw'), '链接里不能出现明文密码')

  // 没口令：给密码页，而不是 Basic 弹框
  const denied = await get(base, '/gp/a.txt', cookie)
  assert.equal(denied.status, 401)
  assert.equal(denied.headers.get('www-authenticate'), null)
  assert.match(await denied.text(), /name="ohmy_pass"/)

  // 表单输错密码
  const wrongForm = await fetch(`${base}/gp/a.txt`, {
    method: 'POST',
    headers: FORM,
    body: form({ ohmy_pass: 'nope' }),
    redirect: 'manual',
  })
  assert.equal(wrongForm.status, 401)
  assert.match(await wrongForm.text(), /密码不正确/)

  // 表单输对：种 Cookie 并跳回原地址
  const okForm = await fetch(`${base}/gp/a.txt`, {
    method: 'POST',
    headers: FORM,
    body: form({ ohmy_pass: 's3cret-pw' }),
    redirect: 'manual',
  })
  assert.equal(okForm.status, 303)
  assert.equal(okForm.headers.get('location'), '/gp/a.txt')
  const setCookie = okForm.headers.getSetCookie?.()[0] || okForm.headers.get('set-cookie') || ''
  assert.match(setCookie, /Path=\/gp/)
  const bindCookie = setCookie.split(';')[0]
  assert.equal(await (await get(base, '/gp/a.txt', bindCookie)).text(), 'gp secret')
  assert.equal(await (await get(base, '/gp/sub/b.txt', bindCookie)).text(), 'deep')

  // 分享链接：?toke=密码 → 303 + 种 Cookie + 地址栏去掉口令
  const viaUrl = await fetch(`${base}/gp/a.txt?toke=s3cret-pw`, { redirect: 'manual' })
  assert.equal(viaUrl.status, 303)
  assert.equal(viaUrl.headers.get('location'), '/gp/a.txt')
  const urlCookie = (viaUrl.headers.getSetCookie?.()[0] || '').split(';')[0]
  assert.ok(urlCookie.startsWith('ohmy_bind_'), '应发绑定专用 Cookie')
  assert.equal(await (await get(base, '/gp/a.txt', urlCookie)).text(), 'gp secret')
  // 打开绑定根路径也能直接进（分享 /gp?toke=… 这种）
  assert.equal((await fetch(`${base}/gp?toke=s3cret-pw`, { redirect: 'manual' })).status, 303)

  // 参数名兼容 token / pwd / key
  for (const name of ['token', 'pwd', 'key']) {
    const res = await fetch(`${base}/gp/a.txt?${name}=s3cret-pw`, { redirect: 'manual' })
    assert.equal(res.status, 303, `${name} 也应认`)
  }
  // 错的口令还是 401 密码页
  const badUrl = await fetch(`${base}/gp/a.txt?toke=nope`, { redirect: 'manual' })
  assert.equal(badUrl.status, 401)
  assert.match(await badUrl.text(), /密码不正确/)

  // 后台页面能显示分享链接（令牌，带有效期）
  const token = decodeURIComponent(/share=([^&]+)/.exec(loc)[1])
  const sharePage = await (
    await get(base, `/admin/bindings?share=${encodeURIComponent(token)}&mount=%2Fgp&days=3`, cookie)
  ).text()
  assert.ok(sharePage.includes(`/gp?toke=${token}`), '页面应给出带令牌的分享链接')
  assert.match(sharePage, /有效期至/)
  assert.ok(!sharePage.includes('s3cret-pw'), '页面不应回显明文密码')

  // 明文密码不落盘
  const saved = JSON.parse(await readFile(usersFile, 'utf8'))
  const stored = saved.settings.mounts.find((b) => b.mount === '/gp')
  assert.equal(stored.auth.username, '')
  assert.equal(stored.auth.algo, 'scrypt')
  assert.ok(!JSON.stringify(stored).includes('s3cret-pw'))

  // 主站不受影响
  assert.equal(await (await get(base, '/hello.txt')).text(), 'main')

  // 改成「账号 + 密码」后：URL 可以只给口令（用户名隐含），也可显式带 user
  assert.equal(
    (await act({ action: 'set-binding-auth', bind_path: '/gp', bind_user: 'team', bind_pass: 'team-pw' })).status,
    303,
  )
  assert.equal((await fetch(`${base}/gp/a.txt?toke=team-pw`, { redirect: 'manual' })).status, 303)
  assert.equal((await fetch(`${base}/gp/a.txt?toke=team-pw&user=team`, { redirect: 'manual' })).status, 303)
  assert.equal((await fetch(`${base}/gp/a.txt?toke=team-pw&user=someone`, { redirect: 'manual' })).status, 401)
  // 改过密码后，老 Cookie 失效（不会拿旧链接一直进）
  assert.equal((await get(base, '/gp/a.txt', bindCookie)).status, 401)
})

test('分享链接：自动生成口令、默认 3 天、重新生成即换密码', async (t) => {
  const main = await tmpDir(t, 'ohmy-link-main-', { 'hello.txt': 'main' })
  const gp = await tmpDir(t, 'ohmy-link-gp-', { 'a.txt': 'gp secret' })
  const usersFile = path.join(await tmpDir(t, 'ohmy-link-users-'), 'users.json')
  const { base } = await startServer(t, ['--pass', 'p', '--root', main, '--users-file', usersFile])
  const { cookie, act } = await adminSession(base)

  // 添加时默认勾选「自动生成口令」：不用手填密码，直接拿到分享链接
  const added = await act({ action: 'add-binding', bind_path: '/gp', bind_dir: gp, auto_auth: '1' })
  assert.equal(added.status, 303)
  const loc1 = added.headers.get('location')
  assert.match(loc1, /share=/)
  assert.match(loc1, /days=3/, '默认有效期 3 天')
  assert.ok(!/[?&]pw=/.test(loc1), '不应回显明文口令')

  const token1 = decodeURIComponent(/share=([^&]+)/.exec(loc1)[1])
  // 页面上没有手动设密码的入口
  const page = await (await get(base, '/admin/bindings', cookie)).text()
  assert.doesNotMatch(page, /name="bind_pass"/, '不应再有手填密码')
  assert.doesNotMatch(page, /auto-binding-auth/, '不应再有单独的设口令动作')
  assert.match(page, /重新生成分享链接/)

  // 链接可用：303 + Cookie，Cookie 有效期不超过 3 天
  const use = await fetch(`${base}/gp/a.txt?toke=${encodeURIComponent(token1)}`, { redirect: 'manual' })
  assert.equal(use.status, 303)
  const setCookie = use.headers.getSetCookie?.()[0] || ''
  const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1] || 0)
  assert.ok(maxAge > 0 && maxAge <= 3 * 24 * 3600, `Cookie 有效期应 ≤ 3 天，实际 ${maxAge}`)
  assert.equal(await (await get(base, '/gp/a.txt', setCookie.split(';')[0])).text(), 'gp secret')

  // 有效期可调（7 天），页面上显示到期时间
  const share7 = await act({ action: 'share-binding', bind_path: '/gp', share_days: '7' })
  assert.equal(share7.status, 303)
  const loc2 = share7.headers.get('location')
  assert.match(loc2, /days=7/)
  const token2 = decodeURIComponent(/share=([^&]+)/.exec(loc2)[1])
  const sharePage = await (
    await get(base, `/admin/bindings?share=${encodeURIComponent(token2)}&mount=%2Fgp&days=7`, cookie)
  ).text()
  assert.match(sharePage, /有效期至/)
  assert.ok(sharePage.includes(`/gp?toke=${token2}`))
  assert.equal((await fetch(`${base}/gp/a.txt?toke=${encodeURIComponent(token2)}`, { redirect: 'manual' })).status, 303)

  // 重新生成 = 换口令：旧链接立即失效，新链接可用
  assert.equal((await fetch(`${base}/gp/a.txt?toke=${encodeURIComponent(token1)}`, { redirect: 'manual' })).status, 401)
  assert.equal((await fetch(`${base}/gp/a.txt?toke=${encodeURIComponent(token2)}`, { redirect: 'manual' })).status, 303)

  // 有效期不合法
  assert.match((await act({ action: 'share-binding', bind_path: '/gp', share_days: '0' })).headers.get('location'), /err=bind_share_days/)
  assert.match((await act({ action: 'share-binding', bind_path: '/gp', share_days: '999' })).headers.get('location'), /err=bind_share_days/)
  assert.match((await act({ action: 'share-binding', bind_path: '/nope' })).headers.get('location'), /err=notfound/)

  // 有效期/结束时间会存到账号文件里，并在表格里显示出来
  const savedForShare = JSON.parse(await readFile(usersFile, 'utf8'))
  const shareEntry = savedForShare.settings.mounts.find((b) => b.mount === '/gp')
  assert.equal(shareEntry.share.days, 7)
  assert.ok(shareEntry.share.expiresAt > Date.now())
  assert.equal(shareEntry.share.token, token2)
  const tablePage = await (await get(base, '/admin/bindings', cookie)).text()
  assert.match(tablePage, /7 天/)
  assert.match(tablePage, /data-copy=/, '应能复制当前链接')
  assert.match(tablePage, /重新生成分享链接/)

  // 没过期但签名对不上（换了路径/口令）也不行
  const saved = JSON.parse(await readFile(usersFile, 'utf8'))
  const entry = saved.settings.mounts.find((b) => b.mount === '/gp')
  const signer = createSessionStore({ secret: Buffer.from(saved.sessionSecret, 'hex'), ttlMs: 1000 })
  const subject = `share:${entry.mount}:${entry.auth.hash.slice(0, 16)}`
  const expired = signer.issue(subject, Date.now() - 60_000, 1000)
  assert.equal((await fetch(`${base}/gp/a.txt?toke=${encodeURIComponent(expired)}`, { redirect: 'manual' })).status, 401)
  const otherPath = signer.issue('share:/other:' + entry.auth.hash.slice(0, 16), Date.now(), 60_000)
  assert.equal((await fetch(`${base}/gp/a.txt?toke=${encodeURIComponent(otherPath)}`, { redirect: 'manual' })).status, 401)

  // 没勾自动口令 → 跟随主站；第一次点分享链接会自动补上口令
  const pub = await tmpDir(t, 'ohmy-link-pub-', { 'p.txt': 'public' })
  assert.equal((await act({ action: 'add-binding', bind_path: '/pub', bind_dir: pub })).status, 303)
  assert.equal(await (await get(base, '/pub/p.txt', cookie)).text(), 'public')
  const sharePub = await act({ action: 'share-binding', bind_path: '/pub', share_days: '3' })
  assert.equal(sharePub.status, 303)
  const tokenPub = decodeURIComponent(/share=([^&]+)/.exec(sharePub.headers.get('location'))[1])
  assert.equal((await fetch(`${base}/pub/p.txt?toke=${encodeURIComponent(tokenPub)}`, { redirect: 'manual' })).status, 303)
})

test('子目录绑定：路径规范化与匹配规则', () => {
  assert.equal(normalizeBindPath('/abc/'), '/abc')
  assert.equal(normalizeBindPath(' /abc//def/ '), '/abc//def')
  assert.throws(() => normalizeBindPath('abc'), /必须以 \//)
  assert.throws(() => normalizeBindPath('/'), /根路径/)
  assert.throws(() => normalizeBindPath('/a/../b'), /不能包含/)
  assert.throws(() => normalizeBindPath('/a b'), /空格/)
  assert.throws(() => normalizeBindPath('/x?y'), /\? 或 #/)

  // ~ 展开与相对路径
  const binding = normalizeBinding({ mount: '/abc', root: '~' }, { verifyDir: false })
  assert.equal(binding.mount, '/abc')
  assert.equal(binding.root, os.homedir())
  assert.throws(() => normalizeBinding({ mount: '/admin/x', root: os.tmpdir() }), /内置接口/)

  const list = normalizeBindings([
    { mount: '/abc', root: '/tmp' },
    { mount: '/abc', root: '/var' }, // 重复路径丢掉
    { mount: 'bad', root: '/tmp' }, // 结构不对丢掉
    { mount: '/nested/deep', root: '/tmp' }, // 目录不存在也保留
  ])
  assert.deepEqual(list, [
    { mount: '/abc', root: '/tmp' },
    { mount: '/nested/deep', root: '/tmp' },
  ])

  // 最长前缀匹配，且不会误吃 /abcz
  const b = matchBinding('/abc/sub/x.txt', list)
  assert.equal(b.mount, '/abc')
  assert.equal(matchBinding('/abcz/x', list), null)
  assert.equal(matchBinding('/nested/deep', list).mount, '/nested/deep')
  assert.equal(matchBinding('/nested', list), null)
  assert.equal(matchBinding('/abc', []), null)

  // 默认目录：'/' 可以存进绑定表，作兜底；子路径最长前缀总能赢
  assert.deepEqual(normalizeBinding({ mount: '/', root: '/tmp' }, { allowRoot: true, verifyDir: false }), {
    mount: '/',
    root: '/tmp',
  })
  assert.throws(() => normalizeBinding({ mount: '/', root: '/tmp' }, { verifyDir: false }), /根路径/)
  const withRoot = normalizeBindings([
    { mount: '/', root: '/tmp' },
    { mount: '/abc', root: '/var' },
  ])
  assert.deepEqual(withRoot, [
    { mount: '/', root: '/tmp' },
    { mount: '/abc', root: '/var' },
  ])
  assert.equal(defaultBinding(withRoot).root, '/tmp')
  assert.equal(defaultBinding([]), null)
  assert.equal(matchBinding('/anything/else', withRoot).mount, '/')
  assert.equal(matchBinding('/abc/x', withRoot).mount, '/abc')
})
