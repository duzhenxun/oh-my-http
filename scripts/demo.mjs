#!/usr/bin/env node
/**
 * 创建一份示例目录并启动真实服务，方便用浏览器点着测。
 *
 *   npm run demo                    # 默认 127.0.0.1:25250，挂载在 /files/
 *   npm run demo -- --port 9000
 *   npm run demo -- --no-default-trusted    # 连本机也要密码
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.join(os.tmpdir(), 'oh-my-http-demo')
const bin = fileURLToPath(new URL('../bin/oh-my-http.js', import.meta.url))

const FILES = {
  'notes.txt': '这是一个纯文本文件，点开就能看。\n',
  '报告/Q4 总结.md': '# Q4 总结\n\n- 收入 +18%\n- 新增 3 个客户\n',
  '报告/数据.csv': '月份,收入\n10,120\n11,143\n12,160\n',
  '报告/2025/年终奖计算.txt': '自己算 🙂\n',
  '照片墙/index.html': '<!doctype html><meta charset="utf-8"><h1>这张 index.html 会优先于目录列表</h1>\n',
  '照片墙/说明.txt': '同级还有 index.html，所以直接打开这个目录看到的是它。\n',
  'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" rx="8" fill="#06c"/><text x="60" y="26" font-family="sans-serif" font-size="16" fill="#fff" text-anchor="middle">oh-my-http</text></svg>\n',
  'big.bin': Buffer.alloc(1024 * 1024, 7),
}

async function prepare() {
  await rm(root, { recursive: true, force: true })
  for (const [rel, content] of Object.entries(FILES)) {
    const target = path.join(root, rel)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  await mkdir(path.join(root, '空目录'), { recursive: true })
  await mkdir(path.join(root, '空目录/里面还有一层'), { recursive: true })
}

await prepare()

const args = [
  '--pass',
  's3cret',
  '--root',
  root,
  '--host',
  '127.0.0.1',
  // 演示要看得见日志、Ctrl+C 能退出，所以前台跑（正式用默认就是后台）
  '--foreground',
  // 演示用独立账号文件，别碰 ~/.oh-my-http/users.json
  '--users-file',
  path.join(root, '..', 'oh-my-http-demo-users.json'),
  ...process.argv.slice(2),
]
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '25250'
const mountIdx = args.indexOf('--mount')
const mount = mountIdx === -1 ? '/' : args[mountIdx + 1]
const browse = mount === '/' ? '/' : `${mount.replace(/\/+$/, '')}/`

console.log('示例目录已生成:', root)
console.log('里面放了一些文件、子目录、一张 1MB 的大文件和两个空目录。\n')
console.log('浏览器打开下面任一地址即可测试：')
console.log(`  http://127.0.0.1:${port}${browse}   目录浏览（绑定目录直接在根路径，不需要 /files）`)
console.log(`  http://127.0.0.1:${port}/admin            账号管理（用管理员登录后）`)
console.log(`  http://127.0.0.1:${port}/whoami            看来源 IP 与认证方式`)
console.log(`  http://127.0.0.1:${port}/                 首页（未登录会跳到 /login）`)
console.log('用户名 admin，密码 s3cret（用 --no-default-trusted 启动时会要求登录）\n')
console.log('登录后可以打开 /admin 添加更多账号。按 Ctrl+C 退出，目录可随时删除。\n')

const child = spawn(process.execPath, [bin, ...args], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
