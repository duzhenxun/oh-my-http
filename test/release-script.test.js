import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)

/** 造一个最小可发版的仓库（带 release 脚本与版本同步钩子）。 */
async function makeRepo(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmy-release-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'scripts'), { recursive: true })
  await mkdir(path.join(dir, 'lib'), { recursive: true })
  await mkdir(path.join(dir, 'docs', 'releases'), { recursive: true })

  for (const f of ['scripts/release.mjs', 'scripts/set-version.mjs', 'lib/version.js']) {
    await writeFile(path.join(dir, f), await readFile(path.join(repoRoot, f), 'utf8'))
  }
  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'oh-my-http',
        version: '0.1.0',
        type: 'module',
        scripts: {
          version: 'node scripts/set-version.mjs && git add lib/version.js',
          release: 'node scripts/release.mjs',
        },
        repository: { type: 'git', url: 'git+https://github.com/duzhenxun/oh-my-http.git' },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(path.join(dir, 'CHANGELOG.md'), '# 更新日志\n\n## 未发布\n\n### 新功能\n\n- 测试用\n')

  const git = (...argv) => execFileSync('git', argv, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  // CI 里 git 的默认分支可能是 master，这里显式切成 main（发版脚本只认 main）
  const branch = git('symbolic-ref', '--short', 'HEAD')
  if (branch !== 'main') git('branch', '-m', branch, 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { dir, git }
}

function release(dir, args) {
  try {
    const stdout = execFileSync('node', ['scripts/release.mjs', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout }
  } catch (err) {
    return { code: err.status || 1, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') }
  }
}

test('release --dry-run 只检查、不改任何东西', async (t) => {
  const { dir, git } = await makeRepo(t)
  const before = git('rev-parse', 'HEAD')

  const out = release(dir, ['patch', '--dry-run'])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /发版计划：0\.1\.0 → 0\.1\.1/)
  assert.match(out.stdout, /dry-run 通过/)

  assert.equal(git('rev-parse', 'HEAD'), before, '不该产生提交')
  assert.equal(git('tag', '--list'), '', '不该打 tag')
  assert.match(await readFile(path.join(dir, 'CHANGELOG.md'), 'utf8'), /## 未发布/)
})

test('release：升版本 + 改 CHANGELOG + 打 tag（--no-push --skip-tests）', async (t) => {
  const { dir, git } = await makeRepo(t)

  const out = release(dir, ['patch', '--skip-tests', '--no-push'])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /已提交并打 tag v0\.1\.1/)

  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '0.1.1')
  const versionJs = await readFile(path.join(dir, 'lib', 'version.js'), 'utf8')
  assert.match(versionJs, /VERSION = '0\.1\.1'/, 'lib/version.js 要同步')
  assert.match(await readFile(path.join(dir, 'CHANGELOG.md'), 'utf8'), /## 0\.1\.1/)
  assert.equal(git('tag', '--list'), 'v0.1.1')
  assert.match(git('log', '-1', '--format=%s'), /v0\.1\.1/)
})

test('release：工作区不干净 / 版本号重复 / 非 main 都会拦住', async (t) => {
  const { dir, git } = await makeRepo(t)

  // 脏工作区
  await writeFile(path.join(dir, 'dirty.txt'), 'x')
  let out = release(dir, ['patch', '--skip-tests', '--no-push'])
  assert.notEqual(out.code, 0)
  assert.match(out.stderr, /工作区不干净/)
  await rm(path.join(dir, 'dirty.txt'))

  // 非 main
  git('checkout', '-qb', 'feat/x')
  out = release(dir, ['patch', '--skip-tests', '--no-push'])
  assert.notEqual(out.code, 0)
  assert.match(out.stderr, /发版要在 main 上/)
  git('checkout', '-q', 'main')

  // tag 已存在
  git('tag', 'v0.1.1')
  out = release(dir, ['patch', '--skip-tests', '--no-push'])
  assert.notEqual(out.code, 0)
  assert.match(out.stderr, /tag v0\.1\.1 已经存在/)
})
