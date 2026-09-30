import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
}

/** 单个目录最多列出的条目数，避免超大目录把页面撑爆。 */
const MAX_LISTING = 2000

function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`${text}\n`)
}

function escapeHTML(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

function humanSize(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function humanTime(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 把 URL 路径换算成绑定目录内的相对路径。
 * mount 为 '/' 时整站都指向该目录。
 */
export function relativeToMount(urlPath, mount) {
  if (mount === '/') return urlPath.replace(/^\/+/, '')
  return urlPath.slice(mount.length).replace(/^\/+/, '')
}

function urlFor(base, segments) {
  return base + segments.map((s) => encodeURIComponent(s)).join('/') + (segments.length ? '/' : '')
}

/**
 * 提供绑定目录下的静态文件与目录浏览。
 * 已做目录穿越防护（解析后的真实路径必须位于 cfg.root 之内）。
 */
export async function serveStatic(req, res, cfg, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
    return res.end('405 method not allowed\n')
  }

  const root = cfg.root
  const mount = cfg.mount || '/files'
  const base = mount === '/' ? '/' : `${mount}/`

  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return plain(res, 400, '400 bad request: 非法 URL 编码')
  }

  const rel = relativeToMount(decoded, mount)

  // 默认隐藏以 . 开头的文件，避免绑定目录后误泄 .env / .git / .ssh 等
  const segments = rel.split('/').filter(Boolean)
  if (!cfg.hidden && segments.some((s) => s.startsWith('.'))) {
    return plain(res, 404, '404 not found')
  }

  const target = path.resolve(root, rel)
  if (target !== root && !target.startsWith(root + path.sep)) {
    return plain(res, 403, '403 forbidden')
  }

  let info
  try {
    info = await stat(target)
  } catch {
    return plain(res, 404, '404 not found')
  }

  if (info.isDirectory()) {
    // 目录下的 index.html 优先，其次是目录列表
    const idx = path.join(target, 'index.html')
    try {
      const idxInfo = await stat(idx)
      return streamFile(req, res, idx, idxInfo)
    } catch {
      /* 没有 index.html，继续走目录列表 */
    }
    return renderListing(req, res, { base, urlPath: decoded, rel, target, hidden: cfg.hidden })
  }

  return streamFile(req, res, target, info)
}

async function renderListing(req, res, { base, urlPath, rel, target, hidden }) {
  const segments = rel.split('/').filter(Boolean)

  let dirents
  try {
    dirents = await readdir(target, { withFileTypes: true })
  } catch {
    return plain(res, 403, '403 forbidden')
  }
  if (!hidden) dirents = dirents.filter((d) => !d.name.startsWith('.'))

  dirents.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  )
  const truncated = dirents.length > MAX_LISTING
  const shown = dirents.slice(0, MAX_LISTING)

  const rows = await Promise.all(
    shown.map(async (d) => {
      const isDir = d.isDirectory()
      const name = d.name + (isDir ? '/' : '')
      const href = urlFor(base, segments) + encodeURIComponent(d.name) + (isDir ? '/' : '')
      let size = '-'
      let mtime = '-'
      try {
        const st = await stat(path.join(target, d.name))
        if (!isDir) size = humanSize(st.size)
        mtime = humanTime(st.mtime)
      } catch {
        /* 权限不足或符号链接失效，留空 */
      }
      return `<tr><td class="n"><a href="${escapeHTML(href)}">${escapeHTML(name)}</a></td><td class="s">${escapeHTML(size)}</td><td class="t">${escapeHTML(mtime)}</td></tr>`
    }),
  )

  // 面包屑兼标题：最后一缀是当前目录，不加链接，避免与上面的标题栏重复
  const crumbs = [`<a href="${escapeHTML(urlFor(base, []))}">${escapeHTML(base)}</a>`]
  segments.forEach((seg, i) => {
    const href = urlFor(base, segments.slice(0, i + 1))
    crumbs.push(
      i === segments.length - 1
        ? `<b>${escapeHTML(seg)}</b>`
        : `<a href="${escapeHTML(href)}">${escapeHTML(seg)}</a>`,
    )
  })
  // 只有根路径时，第一缀就是当前目录，也去掉链接
  if (segments.length === 0) crumbs[0] = `<b>${escapeHTML(base)}</b>`
  const crumbsHtml = `<div class="crumbs">${crumbs.join('<span>/</span>')}</div>`

  const parent =
    segments.length > 0
      ? `<tr><td class="n"><a href="${escapeHTML(urlFor(base, segments.slice(0, -1)))}">..</a></td><td class="s">-</td><td class="t">-</td></tr>`
      : ''

  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(urlPath)}</title>
<style>
body{font:15px/1.6 system-ui,-apple-system,sans-serif;max-width:56rem;margin:2.5rem auto;padding:0 1rem;color:#222}
.crumbs{margin:0 0 1.2rem;color:#888;font-size:1.1rem;font-weight:600}
.crumbs a{color:#0a7;text-decoration:none;font-weight:600}
.crumbs a:hover{text-decoration:underline}
.crumbs b{color:#222;font-weight:600}
.crumbs span{padding:0 .35rem;color:#bbb;font-weight:400}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #eee;white-space:nowrap}
th{color:#888;font-weight:500;font-size:.85rem}
td.n{width:100%}
td.s,td.t{color:#888;font-size:.85rem;text-align:right}
td.t{text-align:left}
a{color:#06c;text-decoration:none}
a:hover{text-decoration:underline}
tr:hover td{background:#fafafa}
.note{margin-top:1rem;color:#c60;font-size:.85rem}
@media (prefers-color-scheme:dark){
  body{background:#16181d;color:#e8eaee}
  .crumbs b{color:#e8eaee}
  th,td{border-color:#2b2f37}
  tr:hover td{background:#1b1e24}
}
</style>
${crumbsHtml}
<table>
<thead><tr><th>名称</th><th>大小</th><th>修改时间</th></tr></thead>
<tbody>${parent}${rows.join('\n') || '<tr><td class="n"><em>空目录</em></td><td class="s">-</td><td class="t">-</td></tr>'}</tbody>
</table>
${truncated ? `<p class="note">目录条目过多，仅显示前 ${MAX_LISTING} 项。</p>` : ''}
`
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
  })
  res.end(body)
}

function streamFile(req, res, file, info) {
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size,
    'last-modified': info.mtime.toUTCString(),
  })
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
