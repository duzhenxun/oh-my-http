#!/usr/bin/env node
/**
 * 把 package.json 的 version 同步到 lib/version.js。
 *
 * 由 npm 的 version 生命周期自动调用（见 package.json 的 scripts.version），
 * 所以发版只需要 `npm version patch|minor|major`，不会出现两处版本号不一致。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const pkgFile = fileURLToPath(new URL('../package.json', import.meta.url))
const versionFile = fileURLToPath(new URL('../lib/version.js', import.meta.url))

const { version } = JSON.parse(await readFile(pkgFile, 'utf8'))
const source = await readFile(versionFile, 'utf8')
const next = source.replace(/export const VERSION = '[^']*'/, `export const VERSION = '${version}'`)

if (next === source) {
  console.log(`lib/version.js 已经是 ${version}`)
} else {
  await writeFile(versionFile, next)
  console.log(`lib/version.js 已同步为 ${version}`)
}
