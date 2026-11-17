#!/usr/bin/env node
/**
 * 一条命令发版：升版本 → 改 CHANGELOG → 打 tag → 推上去（Actions 自动发 npm）。
 *
 *   npm run release -- patch          # 0.4.0 → 0.4.1
 *   npm run release -- minor
 *   npm run release -- 1.2.3          # 指定版本
 *   npm run release -- minor --dry-run
 *   npm run release -- minor --no-push --skip-tests
 *
 * 做的检查：在 main 上、工作区干净、跟 origin/main 同步；默认先跑 npm test。
 * 推送后会打印 Actions 运行页和 npm 包页。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const dryRun = flags.has('--dry-run')
const noPush = flags.has('--no-push')
const skipTests = flags.has('--skip-tests')
const allowDirty = flags.has('--allow-dirty')

const log = (...parts) => console.log(...parts)
const fail = (message) => {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

/** 跑一个命令并返回 stdout（失败时把 stderr 带出来）。 */
function run(cmd, argv, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    if (allowFail) return null
    const detail = String(err.stderr || err.message || err).trim()
    fail(`${cmd} ${argv.join(' ')} 失败：${detail}`)
  }
}

function nextVersion(current, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current)
  if (!m) fail(`读不懂当前版本号：${current}`)
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (bump === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (bump === 'minor') {
    minor += 1
    patch = 0
  } else if (bump === 'patch') {
    patch += 1
  } else {
    fail(`未知的版本类型：${bump}（用 patch / minor / major 或具体版本号）`)
  }
  return `${major}.${minor}.${patch}`
}

// --- 0. 参数 ---
const bumpArg = positional[0]
if (!bumpArg) {
  fail('用法: npm run release -- <patch|minor|major|x.y.z> [--dry-run] [--no-push] [--skip-tests]')
}

const pkgFile = path.join(root, 'package.json')
const pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
const current = pkg.version
const explicit = /^\d+\.\d+\.\d+/.test(bumpArg) ? bumpArg.replace(/^v/, '') : null
const next = explicit || nextVersion(current, bumpArg)

log(`\n发版计划：${current} → ${next}`)
if (dryRun) log('（--dry-run：只检查，不改任何东西）')

// --- 1. 仓库状态 ---
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') {
  fail(`当前分支是 ${branch}，发版要在 main 上（git switch main 后重试）`)
}
const dirty = run('git', ['status', '--porcelain'])
if (dirty && !allowDirty) {
  fail(`工作区不干净，先提交或 stash：\n${dirty}`)
}
if (dirty && allowDirty) log('⚠ 工作区有未提交改动（--allow-dirty），它们不会进这次版本提交')

run('git', ['fetch', '--quiet', 'origin', 'main'], { allowFail: true })
const behind = Number(run('git', ['rev-list', '--count', 'HEAD..origin/main'], { allowFail: true }) || 0)
if (behind > 0) fail(`落后 origin/main ${behind} 个提交，先 git pull`)

const existingTag = run('git', ['tag', '--list', `v${next}`])
if (existingTag) fail(`tag v${next} 已经存在，换个版本号`)

// --- 2. 测试 ---
if (skipTests) {
  log('⚠ 跳过测试（--skip-tests）')
} else if (dryRun) {
  log('（dry-run 不跑测试）')
} else {
  log('跑测试 …')
  try {
    execFileSync('npm', ['test'], { cwd: root, stdio: 'inherit' })
  } catch {
    fail('测试没通过，已中止发版')
  }
}

// --- 3. CHANGELOG：把「未发布」改成版本号 ---
const changelogFile = path.join(root, 'CHANGELOG.md')
if (existsSync(changelogFile)) {
  const changelog = await readFile(changelogFile, 'utf8')
  if (/^##\s+未发布\s*$/m.test(changelog)) {
    log(`CHANGELOG：把「未发布」改成 ${next}`)
    if (!dryRun) {
      await writeFile(changelogFile, changelog.replace(/^##\s+未发布\s*$/m, `## ${next}`))
    }
  } else if (new RegExp(`^##\\s+v?${next.replace(/\./g, '\\.')}\\s*$`, 'm').test(changelog)) {
    log(`CHANGELOG：已有 ${next} 小节`)
  } else {
    log(`⚠ CHANGELOG 里既没有「未发布」也没有 ${next} 小节，Release 说明会退化成占位文案`)
  }
}

const notesFile = path.join(root, 'docs', 'releases', `${next}.md`)
if (!existsSync(notesFile)) {
  log(`提示：没有 docs/releases/${next}.md，Release 说明会用 CHANGELOG 里 ${next} 那一节`)
}

if (dryRun) {
  log('\n接下来会执行：')
  log(`  git add -A && git commit -m "release: v${next}"（如果没有其他改动）`)
  log(`  npm version ${explicit ? next : bumpArg} -m "v%s"`)
  log(`  git push origin main --follow-tags${noPush ? '（--no-push 已跳过）' : ''}`)
  log('\n✓ dry-run 通过\n')
  process.exit(0)
}

// --- 4. 提交 CHANGELOG 改动（npm version 要求工作区干净） ---
if (run('git', ['status', '--porcelain', 'CHANGELOG.md'])) {
  run('git', ['add', 'CHANGELOG.md'])
  run('git', ['commit', '-m', `docs: CHANGELOG ${next}`])
}

// --- 5. npm version：改两处版本号 + 打 tag ---
log(`升版本：${current} → ${next}`)
run('npm', ['version', explicit ? next : bumpArg, '-m', 'v%s'])

// --- 6. 推送（触发 Actions 发布） ---
if (noPush) {
  log(`\n✓ 已提交并打 tag v${next}（--no-push，未推送）`)
  log(`  推送后触发发布：git push origin main --follow-tags`)
  process.exit(0)
}

log('推送到 origin …')
run('git', ['push', 'origin', 'main', '--follow-tags'])

const repo = String(pkg.repository?.url || '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '')
const slug = repo.replace(/^https:\/\/github\.com\//, '')
log(`\n✓ 已推送 v${next}，GitHub Actions 会自动发布`)
log(`  Actions : https://github.com/${slug}/actions`)
log(`  Release : https://github.com/${slug}/releases/tag/v${next}`)
log(`  npm     : https://www.npmjs.com/package/${pkg.name}/v/${next}（发布后有 1~2 分钟延迟）`)
