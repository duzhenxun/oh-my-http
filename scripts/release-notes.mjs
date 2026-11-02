#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里抽出当前版本那一节，输出成 GitHub Release 的说明。
 *
 *   node scripts/release-notes.mjs > /tmp/notes.md
 *
 * 找不到对应小节时退化成一句提示 + npm 链接，不会失败。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const changelog = await readFile(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8')

const lines = changelog.split('\n')
const exact = new RegExp(`^##\\s+v?${pkg.version.replace(/\./g, '\\.')}\\s*$`)
// 没改「未发布」小节名时退回它，避免发出去的 Release 说明是空的
let start = lines.findIndex((line) => exact.test(line.trim()))
if (start < 0) start = lines.findIndex((line) => /^##\s+未发布\s*$/.test(line.trim()))

let body = ''
if (start >= 0) {
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s/.test(line))
  body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

if (!body) body = `发布 ${pkg.name}@${pkg.version}。详细变更见 CHANGELOG.md。`

console.log(body)
console.log('')
console.log('---')
console.log('')
console.log(`- npm: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`)
console.log(`- 安装：\`npm i -g ${pkg.name}@${pkg.version}\``)
const repo = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
console.log(`- 变更日志：https://github.com/${repo.replace('https://github.com/', '')}/blob/v${pkg.version}/CHANGELOG.md`)
