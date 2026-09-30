# oh-my-http

[![npm](https://img.shields.io/npm/v/oh-my-http.svg)](https://www.npmjs.com/package/oh-my-http)
[![license](https://img.shields.io/npm/l/oh-my-http.svg)](./LICENSE)

一个零依赖的极简 HTTP 服务：**绑定一个目录就能在浏览器里浏览/下载文件，可选用户名密码认证，内网 IP 自动免认证**。

适合把本机的目录、报表、内部接口快速暴露出来：外网访问要密码，局域网和本机直接放行。

```bash
npx oh-my-http .              # 把当前目录挂到 25250 端口，不启用认证
npx oh-my-http . --pass s3cret   # 加个密码
```

- **零依赖**：只用 Node 内置模块，不装任何第三方包
- **登录页认证**：表单登录 + HttpOnly Cookie 会话，**不弹浏览器的 Basic 认证框**；可勾选“记住我”保持长期登录
- **多账号 + 管理后台**：`/admin` 里加账号、改密码、设角色（管理员/成员）、禁用删除；账号存 `~/.oh-my-http/users.json`（scrypt 哈希，0600）
- **目录可指定**：位置参数或 `--root`，写 `.` 就是当前目录，不写默认也是当前目录
- **能浏览文件夹**：面包屑、`..` 上级、文件大小与修改时间，支持 `index.html` 优先
- **认证可选**：不配也能跑（会告警），配了就用登录页
- **内网免认证**：回环 / RFC1918 私网 / 链路本地 / IPv6 ULA / CGNAT 自动放行
- **安全的代理处理**：只有直连对端本身可信时才采信 `X-Forwarded-For`，外网伪造头部无法绕过认证

## 安装

```bash
# 直接用，无需安装
npx oh-my-http --pass s3cret

# 或全局安装
npm i -g oh-my-http
oh-my-http --pass s3cret
```

需要 Node.js >= 18.17。

## 快速开始

```bash
# 1. 最简用法：当前目录 + 25250 端口，不启用认证，直接可以访问
oh-my-http

# 2. `.` 就是当前目录（不写也一样）；也可以给绝对路径
oh-my-http .
oh-my-http ~/Downloads
oh-my-http /srv/files --port 9000

# 3. 开登录页（两种方式，选一个）
#    方式 A：命令行给个初始密码（只在第一次建号时生效，之后会被忽略）
oh-my-http . --pass s3cret
#    方式 B：只要认证、不要密码 —— 首次打开 /login 引导你创建管理员
oh-my-http . --require-auth
#   → 默认后台启动，命令立即返回
#   → 浏览器打开 http://127.0.0.1:25250/ 会自动跳到 /login
#   → 用 admin / s3cret 登录，然后到 /admin 里加更多账号

# 4. 想占着终端看日志（docker / systemd / 调试）
oh-my-http . --pass s3cret -f

# 5. 用环境变量（适合 systemd / docker / CI）
OHMY_PASS=s3cret OHMY_ROOT=/srv/files OHMY_PORT=9000 oh-my-http

# 6. 不在命令行留明文密码：用 sha256 摘要
printf %s 's3cret' | shasum -a 256
OHMY_PASS_SHA256=<64位十六进制> oh-my-http .

# 7. 强制要求密码（没密码就报错退出）
oh-my-http . --require-password

# 8. 想要老式的 Basic 弹窗
oh-my-http . --pass s3cret --auth basic

# 9. 只要内置接口，不暴露任何目录
oh-my-http --no-files
```

## 默认后台启动

不加参数就是后台运行，命令立刻返回，不占终端：

```
$ oh-my-http ~/Desktop/映客活动数据 --pass s3cret
已在后台启动（pid=11583）
  监听: http://0.0.0.0:25250
  目录: /Users/dds/Desktop/映客活动数据  →  /
  日志: /Users/dds/.oh-my-http/log-25250.log

  停止: oh-my-http stop
  重启: oh-my-http restart
  状态: oh-my-http status
```

| 情况 | 行为 |
| --- | --- |
| 默认 | 后台运行，日志写 `~/.oh-my-http/log-<端口>.log` |
| `-f` / `--foreground` / `OHMY_FOREGROUND=1` | 前台运行，日志打在终端，`Ctrl+C` 退出 |
| 容器（PID 1）或 `OHMY_CONTAINER=1` | **自动前台**，否则容器会以为进程退了 |
| systemd（`INVOCATION_ID`） | **自动前台**，配合 `Type=simple` |
| 同时给了 `-d -f` | 以前台为准（更安全） |

自动切前台时会打印一句提示；在容器里想强制后台就显式加 `-d`。

## stop / restart / status

不想开着一个终端窗口看着它就用后台模式 —— **不加参数默认就是后台**：

```bash
oh-my-http ~/Desktop/映客活动数据 --pass s3cret
```

```
已在后台启动（pid=71296）
  监听: http://0.0.0.0:25250
  目录: /Users/dds/Desktop/映客活动数据  →  /
  日志: /Users/dds/.oh-my-http/log-25250.log

  停止: oh-my-http stop
  重启: oh-my-http restart
  状态: oh-my-http status
```

| 命令 | 作用 |
| --- | --- |
| `oh-my-http status` | 列出实例：PID、端口、目录、认证方式、已运行时长、启动参数、日志路径 |
| `oh-my-http stop` | 先 `SIGTERM` 优雅退出（打印 `bye`）；等不到就提示你加 `--force` |
| `oh-my-http restart` | **用上次启动的参数**重启（工作目录、端口、`--root`、`--trusted` 等全部保留） |

多个实例时就指定端口，不带 `--port` 时会自动识别（只有一个就直接用）：

```bash
oh-my-http status
oh-my-http restart --port 9000
oh-my-http stop --port 9000 --force
```

### 它是怎么记住参数的

启动时会在 `~/.oh-my-http/`（`--state-dir` 可改）写下 `state-<端口>.json`，里面是 PID、端口、目录、工作目录、启动参数，日志则在 `log-<端口>.log`。

**密码不会落盘**：`--pass` / `--pass-sha256` 的值在写状态文件前会被换成 `<已隐藏>`，`restart` 时直接省略这个参数——因为账号已经存在账号文件里了，重启后旧密码照旧能用。

```bash
$ oh-my-http status
  ● :25250  pid=71296  运行中
  目录    : /Users/dds/Desktop/映客活动数据  →  /
  认证    : 登录页 /login（账号 3 个）
  已运行  : 2 小时 13 分钟
  启动参数: oh-my-http /Users/dds/Desktop/映客活动数据 --no-default-trusted --port 25250
  工作目录: /Users/dds
  日志    : /Users/dds/.oh-my-http/log-25250.log
```

安全细节：

- `stop` 不会乱杀：它会用 `ps` 确认那个 PID 确实是 oh-my-http 进程，且**永远不结束自己或父进程**；PID 被系统回收给别人时会拒绝操作并提示状态文件位置。
- 进程已经不在的陈旧记录，`status` 会标成“进程已不在”，`stop` 会顺手清理。
- 唯一不能自动重启的情况：密码是 `--pass` 传的、而且用了 `--users-file none`（账号只在内存里）——这时会明确报错让你手动启动，不会默默把认证搞丢。

启动后会打印监听地址、免认证网段和本机可达 URL：

```
oh-my-http: username/password protected HTTP service with intranet bypass
listening on http://0.0.0.0:25250 (realm="oh-my-http", user="admin")
  trusted: 127.0.0.1/8 (IPv4, /8)
  trusted: 192.168.0.0/16 (IPv4, /16)
  ...
  public paths: /healthz
  reachable at http://192.168.1.23:25250
```

## 内置路由

| 路由 | 说明 |
| --- | --- |
| `GET /` | 首页，显示你的地址与本次请求的认证方式 |
| `GET /login` | 登录页（`form` 模式；公共路径） |
| `GET /logout` | 退出登录，清掉会话 Cookie |
| `GET /admin` | 账号管理与登录保护设置（需管理员） |
| `GET /healthz` | 健康检查，默认无需认证（可用 `--public` 调整） |
| `GET /whoami` | 返回来源 IP、是否内网、认证方式、当前用户等 JSON |
| `POST /api/echo` | 回显 method / path / query / headers / body |
| `GET /**` | 浏览/下载绑定目录（默认直接挂在根路径，不需要前缀），目录页含面包屑、上级目录、大小与修改时间 |

```bash
# 免认证（内网）
curl http://192.168.1.23:25250/whoami

# 需要认证（外网 / 改过 --no-default-trusted）
curl -u admin:s3cret http://example.com:25250/whoami

# 下载绑定目录里的文件
curl -u admin:s3cret http://example.com:25250/report.pdf -O
```

## 命令行参数

| 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `[目录]` | `OHMY_ROOT` | `.` | 要绑定的目录（位置参数）；写 `.` 就是当前目录，不写默认也是当前目录 |
| `-r`, `--root <dir>` | `OHMY_ROOT` | `.` | 同上，二者只能给一个 |
| `--mount <path>` | `OHMY_MOUNT` | `/` | 挂载点；默认 `/`，即绑定目录直接挂在根路径，访问不需要任何前缀。写成 `/files` 就多一层前缀 |
| `--hidden` | – | 关 | 列出并允许访问以 `.` 开头的文件（默认隐藏，防误泄 `.env` / `.git`） |
| `--no-files` | – | 关 | 不绑定任何目录，只保留内置接口 |
| `-d`, `--daemon` | – | **开** | 后台运行（默认就是），日志写 `~/.oh-my-http/log-<端口>.log` |
| `-f`, `--foreground` | – | 关 | 前台运行，占着终端；容器 / systemd 环境会自动切前台 |
| `--state-dir <dir>` | `OHMY_STATE_DIR` | `~/.oh-my-http` | PID / 日志存放目录 |
| `--force` | – | 关 | 配合 `stop` / `restart`：等不到优雅退出就 SIGKILL |
| `--addr` | `OHMY_ADDR` | – | 等价于同时设置 `--host` 与 `--port`，支持 `[::1]:25250` |
| `--host` | `OHMY_HOST` | `0.0.0.0` | 监听地址 |
| `--port` | `OHMY_PORT` | `25250` | 监听端口 |
| `--realm` | `OHMY_REALM` | `oh-my-http` | Basic 认证提示的 realm |
| `--user` | `OHMY_USER` | `admin` | 引导管理员用户名（配合 `--pass`） |
| `--pass` | `OHMY_PASS` | – | 初始密码；**只在第一次建号时写入，账号已存在会被忽略**（不会覆盖你在 /admin 改的密码） |
| `--require-auth` | `OHMY_AUTH_REQUIRED=1` | 关 | 要求认证但不在命令行给密码：首次访问 `/login` 引导创建管理员 |
| `--reset-pass` | – | 关 | 配合 `--pass`：账号已存在时也强制改密码（默认忽略） |
| `--pass-sha256` | `OHMY_PASS_SHA256` | – | 密码的 sha256 十六进制摘要，优先于 `--pass` |
| `--users-file <path>` | `OHMY_USERS_FILE` | `~/.oh-my-http/users.json` | 账号文件；写 `none` 则不用文件（账号只在内存里） |
| `--auth <form\|basic>` | `OHMY_AUTH` | `form` | `form`＝登录页 + Cookie；`basic`＝传统弹窗；`form` 下 `curl -u` 仍可用 |
| `--session-days <n>` | `OHMY_SESSION_DAYS` | `7` | 不勾“记住我”时的登录保持天数 |
| `--remember-days <n>` | `OHMY_REMEMBER_DAYS` | `365` | 勾上“记住我”后的保持天数；`0` 则不提供这个选项 |
| `--secure-cookie` | – | 关 | 给会话 Cookie 加 `Secure`（HTTPS 必须；反代会自动探测 `X-Forwarded-Proto`） |
| `--require-password` | – | 关 | 没有密码也没有账号文件时直接报错退出 |
| `--allow-anonymous` | `OHMY_ALLOW_ANONYMOUS=1` | 关 | 强制关闭认证：已有账号也直接放行（慎用） |
| `--account-max-attempts <n>` | `OHMY_ACCOUNT_MAX_ATTEMPTS` | `3` | 同一账号连续失败几次锁定；`0` = 不锁。**显式传入时优先于后台设置** |
| `--ip-max-attempts <n>` | `OHMY_IP_MAX_ATTEMPTS` | `0` | 同一来源 IP 连续失败几次锁定；默认 `0` = 不锁（隧道/反代后面别开） |
| `--lockout-minutes <n>` | `OHMY_LOCKOUT_MINUTES` | `60` | 锁定时长（分钟）；`0` = 关闭全部锁定 |
| `--trusted` | `OHMY_TRUSTED` | – | **追加**免认证网段（在默认列表基础上加），可重复或用逗号分隔，支持裸 IP |
| `--no-default-trusted` | – | 关 | 清空默认免认证网段（此时除公共路径外全部要密码） |
| `--check-ip <ip>` | `OHMY_CHECK_IP` | – | 诊断：只打印来自该 IP 的请求会免认证还是需要密码，然后退出 |
| `--no-xff` | – | 关 | 即使对端可信也不采信 `X-Forwarded-For` |
| `--public` | `OHMY_PUBLIC` | `/healthz` | 免认证路径，可重复或用逗号分隔 |
| `-q`, `--quiet` | – | 关 | 不打印访问日志 |
| `-v`, `--version` | – | – | 打印版本 |
| `-h`, `--help` | – | – | 打印帮助 |

### 两种开启认证的方式

```bash
# A. 命令行给初始密码（方便脚本 / CI）
oh-my-http . --pass s3cret

# B. 只要认证，不要密码（推荐日常用）
oh-my-http . --require-auth
```

方式 B 启动后（还没有任何账号）：

```
  还没有任何账号 —— 浏览器打开 /login 创建第一个管理员
  初始化口令: c11f5e81
              （从非内网地址访问时需要填它，也可以用 oh-my-http status 再查）
```

浏览器打开 `/login` 会让你设第一个管理员的用户名和密码，**建完直接就是登录态**，之后就变成普通登录页了。

> 初始化口令是为了防止公网上有人抢先创建管理员：内网来源不需要，非内网来源必须填（在启动日志里，`oh-my-http status` 也能看到）。猜口令同样会被锁定（默认 3 次）。

**`--pass` 的语义**：只在第一次建号时写入。账号一旦存在（尤其是你在 `/admin` 里改过密码之后），启动时再给 `--pass` 会被**忽略**，不会把后台改的密码覆盖掉：

```
  账号: "admin" 已存在，忽略本次 --pass
        （想强制改回加 --reset-pass；改密码推荐去 /admin）
```

只有加了 `--reset-pass` 才会强制覆盖 —— 用于"密码忘了"的救援场景。

关于认证：

- **默认不加参数不需要密码就能访问**：没账号也没密码也没 `--require-auth` 时，认证就是关的。
- **一旦有过账号**（账号文件里有人），默认就要求登录；想让裸启动重新变成开放模式，用 `--allow-anonymous`。
- `--require-auth` 可以在一个账号都没有的情况下也要求认证（首次访问自建管理员）。
- 不放心就用 `--require-password`，没账号也没密码就直接退出（退出码 2）。
- 认证判定顺序：公共路径 → 未启用认证（全放行）→ 内网免认证 → 登录/Cookie 凭据 → 401。
- 已登录的会话不受登录锁定影响（否则输错几次密码会把同一出口下的管理员也锁在外面）。

## 防爆破（登录失败锁定）

默认：**只锁账号，不锁 IP** —— 同一个账号连续失败 3 次 → 锁 1 小时。

```
第 1 个错误密码 -> 401（还剩 2 次机会）
第 2 个错误密码 -> 401（还剩 1 次机会）
第 3 个错误密码 -> 429  retry-after: 3600
锁定期内：正确密码、curl -u、浏览器访问 全部 429
```

**为什么默认不锁 IP**：在 Cloudflare 隧道 / Nginx 反代 / 公司出口后面，所有人的来源 IP 都是同一个（或者同一条链路上的同一个地址），按 IP 锁会因为一个人的手误把一整片人一起锁掉。这个项目就是踩了这个坑才改的默认值。

几个关键设计：

- **只锁被登录的那个账号**：换个用户名不受影响（各自独立计数），所以你被锁了也能用别的账号进去。
- **表单登录和 `curl -u admin:xxx` 共用这把锁**。只锁登录页是没用的，脚本用 Basic 头照样能无限猜。
- **同一个错误密码重复提交只算一次**。浏览器如果缓存了过期的 Basic 凭据，一次页面加载会带着它发十几个请求——以前这一下就能把自己锁死，现在只算 1 次。
- **锁定期内再尝试不会续期**，否则攻击者能把它永久锁住。
- **光刷新页面不算失败**，只有真交了错误密码才计数。
- **内网免认证的来源不受影响**，被锁了也能从局域网直接进来。

### 在后台页里改，并看到锁定状态

打开 `/admin` 的「登录保护」区域：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| 同一账号失败几次锁定 | `3` | `0` = 不锁账号 |
| 同一 IP 失败几次锁定 | `0` | `0` = 不锁 IP（推荐；隧道 / 反代后面别开） |
| 锁定时长（分钟） | `60` | `0` = 关闭全部锁定 |

填完保存**立即生效并持久化**（写进账号文件）。

下面还有一块 **「当前锁定 / 失败记录」**，会列出来：

```
类型   对象     状态                                              操作
账号   admin    已锁定  将于 2026-09-30 10:47 自动解锁（还剩 59 分钟）   [立即解锁]
账号   bob      失败 1 次  再错 2 次就会锁定                            [清除记录]
```

- 能看到**谁被锁了、什么时候自动解锁**
- 可以**单独解锁**某个账号，也可以一键「立即解除所有锁定」
- **重置密码会自动解除该账号的锁定**（密码换了，针对旧密码的失败记录就没意义了）
- 删除账号同样会清掉它的锁定记录

优先级：**命令行显式传入 > 后台保存的设置 > 默认值**。也就是 `--account-max-attempts 5` 会覆盖后台设置（页面上会提示），不传命令行参数时以页面上保存的为准。

锁定状态只存在内存里 —— `oh-my-http restart` 会清空全部锁定，这也是最快的自救方式。

## 登录与账号

默认是 **表单登录 + 会话 Cookie**，不再弹浏览器那个 Basic 对话框。

```bash
oh-my-http ~/Desktop/映客活动数据 --pass s3cret
```

启动日志会告诉你：

```
  auth: 登录页 /login（会话 7 天，勾选“记住我”可保持 365 天），账号 1 个
  管理员界面: http://127.0.0.1:25250/admin（需管理员账号）
  账号文件: /Users/dds/.oh-my-http/users.json
```

- 浏览器打开任意页面 → 自动跳 `/login`（原来请求的地址会放在 `?next=`，登录后原路返回）
- 登录页有 **“记住我”** 勾选框：勾上用 `--remember-days`（默认 365 天），不勾用 `--session-days`（默认 7 天）
- 命令行 / 脚本用 `curl -u admin:s3cret` 依然可以，不会再弹窗（因为不返回 `WWW-Authenticate`）
- 想回到老式弹窗：`--auth basic`

### 长期保持登录

两个前提都满足才能“一直不用重新登录”：

1. **Cookie 时长**：勾选“记住我”（默认 365 天）；可用 `--remember-days 3650` 拉更长，或 `--session-days` 改默认时长。
2. **会话密钥持久化**：密钥存在账号文件里（`sessionSecret`），所以**重启服务不会把所有人踢下线**。如果把 `--users-file` 设成 `none`，密钥就只在内存里，重启即失效。

> 安全提醒：长期 Cookie 相当于一把长期钥匙。公共电脑上别勾，或者直接用 `--remember-days 0` 把选项关掉。

### 多账号与角色

账号存在 `--users-file`（默认 `~/.oh-my-http/users.json`）：

- 密码用 **scrypt 加盐哈希**，不存明文；文件权限 `0600`，写盘为原子替换
- 角色分 **管理员（admin）** 和 **成员（member）**：成员只能浏览文件，进不了 `/admin`
- 可以用 `--pass` 引导第一个管理员，之后在后台里加人；不传 `--pass` 也能直接用文件里已有的账号

## 管理后台

用管理员账号登录后打开 `http://127.0.0.1:25250/admin`（首页也会出现入口）：

| 能力 | 说明 |
| --- | --- |
| 添加账号 | 填用户名、密码、角色（成员 / 管理员） |
| 重置密码 | 直接给某个账号改密码，改完旧密码立即失效 |
| 改角色 | 设为管理员 / 降为成员 |
| 禁用 / 启用 | 临时停掉某个账号，不用删 |
| 删除账号 | 删了就登录不了了 |
| 登录保护 | 改“连续失败几次锁多久”（默认 3 次 / 60 分钟），并一键解除已有锁定 |

安全护栏：

- 至少保留一个可用管理员（不能把最后一个管理员降级 / 禁用 / 删除）
- 不能删除当前登录的自己
- 所有写操作都要带 **CSRF token**（与会话绑定，跨站伪造不了）
- 登录失败锁定：默认 3 次 / 1 小时，可在本页里改（见上面的「防爆破」）
- 用 `curl -u admin:密码` 也能直接调后台，方便脚本化

## 绑定目录

```bash
oh-my-http                 # 无参数 => 当前目录，直接挂在根路径 /
oh-my-http .               # 同上的显式写法
oh-my-http ./public        # 相对路径
oh-my-http ~/Downloads     # 绝对路径，浏览器直接开 http://ip:25250/
oh-my-http ~/Desktop/映客活动数据 --pass s3cret
oh-my-http ~/Downloads --mount /files    # 想要 /files 前缀的话
oh-my-http --no-files      # 不绑定目录
```

浏览器打开 `http://127.0.0.1:25250/` 就能看到绑定目录的内容：子目录可以逐级点开，每行都有大小和修改时间，有 `..` 回上一级，目录里有 `index.html` 时会优先展示它。

**不需要 `/files/` 这层前缀**：绑定目录默认就挂在 `/`。此时首页会被目录列表取代（`/whoami` 仍可看认证状态）；想让内置首页回来就 `--mount /files`。

## 免认证规则

默认信任以下网段，命中即跳过认证：

```
127.0.0.0/8        IPv4 回环
::1/128            IPv6 回环
10.0.0.0/8         RFC1918 私网
172.16.0.0/12      RFC1918 私网
192.168.0.0/16     RFC1918 私网
169.254.0.0/16     IPv4 链路本地
fe80::/10          IPv6 链路本地
fc00::/7           IPv6 ULA
100.64.0.0/10      RFC6598（k8s / CGNAT 常用）
```

判断顺序：**公共路径 → 匿名模式（未配密码）→ 内网/IP 免认证 → 用户名密码 → 401**。

注意：免认证与否**只看来源 IP 和路径**，跟其他参数无关。绑目录、`--mount`、`--port`、`--hidden` 都不会让任何人免掉密码。

### 追加自己的网段

`--trusted` 是**追加**，默认那 9 条依然生效；写 `--no-default-trusted` 才是清空重来。

```bash
# 公司的出口 IP / 家里网段也免认证，其余仍然要密码
oh-my-http ~/Desktop/映客活动数据 --pass s3cret \
  --trusted 203.0.113.0/24 --trusted 198.51.100.7

# 逗号分隔、环境变量都可以
OHMY_TRUSTED="203.0.113.0/24,198.51.100.7/32" oh-my-http . --pass s3cret

# 只信任指定网段，其他一律要密码（连本机也要）
oh-my-http . --pass s3cret --no-default-trusted --trusted 203.0.113.0/24
```

### 不确定某个 IP 会不会免认证？用 --check-ip

不改任何配置、也不启动服务，直接告诉你结果，并告诉你命中了哪条网段：

```bash
$ oh-my-http . --pass s3cret --check-ip 8.8.8.8
  结论: 来自 8.8.8.8 的请求 -> 需要用户名密码
  依据: 不在 9 条免认证网段内，需要用户名密码

  /          需要用户名密码（用户名 admin）
  /healthz   免认证 · 公共路径 /healthz
  /whoami    需要用户名密码（用户名 admin）
  ...
  提示: 想让 8.8.8.8 免认证，启动时追加 --trusted 8.8.8.8/32

$ oh-my-http . --pass s3cret --trusted 203.0.113.0/24 --check-ip 203.0.113.9
  结论: 来自 203.0.113.9 的请求 -> 免认证
  依据: 命中免认证网段 203.0.113.0/24
```

服务跑起来后，也可以直接访问 `/whoami` 看当前这次请求的判定（`authenticated_by` / `trusted`）。

### 本机怎么模拟其它 IP

回环地址本身在免认证列表里，所以本机可以用 `X-Forwarded-For` 假装成别的 IP——服务只有在直连对端可信时才采信这个头，本机刚好满足：

```bash
# 假装自己是公网 IP => 应该 401
curl -i -H 'X-Forwarded-For: 8.8.8.8' http://127.0.0.1:25250/whoami

# 假装自己在刚追加的网段里 => 应该 200 且 intranet-bypass
curl -s -H 'X-Forwarded-For: 203.0.113.9' http://127.0.0.1:25250/whoami
```

> 注意：如果服务通过隧道 / 端口映射暴露到公网，请确认客户端地址真的不在上述范围；
> 例如某些内网穿透工具会把请求从 `127.0.0.1` 转发进来，这会被判定为免认证。
> 这种情况用 `--no-default-trusted --trusted <你的代理网段>` 明确收窄。

### 关于 X-Forwarded-For

`X-Forwarded-For` 只在**直连对端本身可信**时才参与判断，并从右往左找到第一个不可信地址作为真实客户端：

```
直连对端可信 + XFF: 8.8.8.8        -> 客户端 = 8.8.8.8  -> 需要密码 ✅
直连对端不可信 + XFF: 127.0.0.1    -> XFF 被忽略        -> 需要密码 ✅
```

因此外网客户端无法通过伪造头部混进免认证通道。放在 Nginx / Caddy 后面时记得让代理传递
`X-Forwarded-For`，并保证代理本身在 `--trusted` 网段内。用 `--no-xff` 可以彻底关闭该逻辑。

## 作为库使用

```js
import { loadConfig, createServer, listen } from 'oh-my-http'

const cfg = loadConfig([], { OHMY_PASS: 's3cret', OHMY_PORT: '25250' })
const server = createServer(cfg, {
  logger: (entry) => console.log(entry.ip, entry.user, entry.method, entry.status, entry.path),
})
await listen(server, cfg)

// 运行时拿到账号存储与生效后的配置
const { store, cfg: effective } = server.ohmy
await store.create({ username: 'alice', password: 'alicepw', role: 'member' })
```

自己接账号存储（不启动内置服务）：

```js
import { createAccountStore, createSessionStore } from 'oh-my-http'

const store = createAccountStore({
  file: '/var/lib/myapp/users.json',
  bootstrap: { username: 'admin', password: 's3cret' }, // 只在文件不存在时写入
})
store.verify('admin', 's3cret')
await store.create({ username: 'bob', password: 'bobpw', role: 'member' })

// 会话 / CSRF 工具也可以单独用
const session = createSessionStore({ secret: store.sessionSecret, ttlMs: 365 * 24 * 3600 * 1000 })
const token = session.issue('bob')
```

也可以只复用判定逻辑，把它挂到自己的服务上：

```js
import http from 'node:http'
import { evaluateAccess, parsePrefix } from 'oh-my-http'

const cfg = {
  trusted: ['127.0.0.0/8', '10.0.0.0/8'].map(parsePrefix),
  publicPaths: ['/healthz'],
  username: 'admin',
  passHash: null,
  auth: 'basic',
}

http.createServer((req, res) => {
  const access = evaluateAccess(req, cfg)
  if (!access.allowed) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="my-app"' })
    return res.end('401')
  }
  res.end(`hello ${access.ip} (${access.method})`)
}).listen(25250)
```

### 导出的 API

| 导出 | 说明 |
| --- | --- |
| `loadConfig(argv?, env?)` | 解析参数与环境变量为配置对象 |
| `createServer(cfg, { logger, store }?)` | 创建 `http.Server`（尚未 listen）；`server.ohmy` 里有 `{ cfg, store }` |
| `listen(server, cfg)` | `server.listen` 的 Promise 包装 |
| `createHandler(cfg, { logger, store }?)` | 只取请求处理函数 |
| `evaluateAccess(req, cfg, { session, store }?)` | 单次请求的认证判定结果（含 `user`） |
| `authenticatedUser(req, cfg, { session, store }?)` | 当前请求的登录用户 |
| `explainAccess(ip, path, cfg)` | 纯函数版判定，`--check-ip` 就靠它 |
| `createAccountStore({ file, bootstrap })` | 账号存储（scrypt 哈希、原子写盘） |
| `createSessionStore({ secret, ttlMs })` / `createLoginThrottle()` | 会话签名 / 登录限速 |
| `verifyUserPass(u, p, cfg)` / `checkCredentials(req, cfg)` | 常数时间校验密码 / Basic 凭据 |
| `isAuthEnabled(cfg)` / `withAuthState(cfg, store)` | 认证是否启用 / 把账号状态写回配置 |
| `clientIP(req, opts)` / `peerIP(req)` | 解析真实客户端 IP |
| `isTrusted(ip, prefixes)` / `matchPrefix(ip, p)` / `parsePrefix(s)` / `prefixContains(p, ip)` | CIDR 工具 |
| `basicAuthHeader(user, pass)` / `safeNext(url)` / `parseCookies(header)` | 小工具 |
| `MIME` | 扩展名 → Content-Type 映射 |

类型定义见 `index.d.ts`。

## 本地测试

```bash
# 单元测试（node:test，零依赖，64 个用例）
npm test

# 端到端泳烟测试（158 项：真把 CLI 拉起来跑 http 请求）
npm run smoke

# 一键造一个示例目录并前台启动（方便看日志、Ctrl+C 退出）
npm run demo                      # admin / s3cret，登录后 /admin 可加账号

# 后台跑 + 子命令管理
npm start -- . --pass s3cret                 # 默认就是后台
npm run --silent start -- status
npm run --silent start -- restart
npm run --silent start -- stop

# 前台跑
npm start -- . --pass s3cret -f              # 日志打终端，Ctrl+C 退出
npm start -- . --auth basic                  # 老式弹窗
npm start -- .                               # 不启用认证（会告警）

# 浏览器打开 http://127.0.0.1:25250/，会被带到 /login
# 登录后：
#   http://127.0.0.1:25250/        文件列表
#   http://127.0.0.1:25250/admin   账号管理
#   http://127.0.0.1:25250/whoami  看当前登录用户与认证方式

# 想验证“必须登录”的场景（本机也不再免认证）
npm start -- . --pass s3cret --no-default-trusted
curl -i http://127.0.0.1:25250/                 # 401（不带 WWW-Authenticate）
curl -iu admin:s3cret http://127.0.0.1:25250/   # 200

# 换个干净账号文件，不影响你平时的账号
npm start -- . --pass s3cret --users-file /tmp/ohmy-users.json
```

打包后再装一遍，验证发布产物（不会真的发到 npm）：

```bash
npm pack                        # 生成 oh-my-http-0.1.0.tgz
mkdir -p /tmp/try && cd /tmp/try
npm i /path/to/oh-my-http-0.1.0.tgz
./node_modules/.bin/oh-my-http . --pass s3cret --port 25250
```

## 安全说明

- **登录表单的密码是明文表单 POST**，`basic` 模式则是 base64。**两者都不加密**，跨公网请务必套 HTTPS（Nginx / Caddy / Cloudflare 反代），并配 `--secure-cookie`（或让反代传 `X-Forwarded-Proto`，会自动识别）。
- **不配密码就是完全不认证**，任何能访问到端口的人都能浏览绑定目录。启动日志、首页、`/whoami` 都会标明；要强制要求账号用 `--require-password`，想反方向强制关闭认证用 `--allow-anonymous`。
- **防爆破**：默认**只锁账号**（同一账号失败 3 次锁 1 小时），表单和 `curl -u` 共用这把锁；IP 维度默认关闭，可在 `/admin` 里按需打开或调整，也可一键解锁。锁定状态在内存里，`oh-my-http restart` 会清空。
- `--pass` 会出现在进程命令行（`ps` 可见）。生产建议用 `OHMY_PASS` 环境变量，或先引导一次账号后直接靠账号文件。
- 账号密码用 **scrypt** 加盐哈希存盘（不是明文、也不是裸 sha256）；用户名密码比较是常数时间。
- 会话 Cookie 是 `HttpOnly` + `SameSite=Lax`，签名密钥存在账号文件里；**“记住我”默认 365 天**，公共电脑上请用 `--remember-days 0` 关掉。
- 已有登录失败限速（同一 IP 5 分钟 10 次）和 CSRF 防护，但仍然建议配合 fail2ban / 反代限流。
- 静态文件已做目录穿越防护，解析后的真实路径必须位于绑定目录之内。
- 默认绑定当前目录并且直接挂在根路径，在含敏感文件的项目里直接跑会把它们暴露到端口上；不放心就 `--no-files`，或用 `--root` 指定一个干净目录。
- 以 `.` 开头的文件（`.env`、`.git/`、`.ssh/`）默认既不列出也不可访问；确实要暴露时用 `--hidden`。
- 绑定目录里若存在名为 `login` / `logout` / `admin` / `whoami` / `healthz` / `api` 的文件，会被内置路由遮住（内置优先）。
- 该工具定位是「内网小工具」，不是通用 Web 框架；不要用它托管复杂业务。

## 开发

```bash
git clone <your-repo> && cd oh-my-http
npm test                       # node --test，26 个用例
npm start -- --pass s3cret --root .
```

## 发布到 npm

```bash
npm login                     # 已登录可跳过（npm whoami 看一下）
npm view oh-my-http version   # 404 表示名字还空着
npm test                      # 71 个用例
npm run smoke                 # 180 项端到端（可选，约 1 分钟）
npm pack --dry-run            # 预览打包内容
npm publish                   # 会先自动跑 npm test（prepublishOnly）
```

开了两步验证的账号，`npm publish` 会要一次性口令：直接跑它会打印一个
`https://www.npmjs.com/auth/cli/...` 链接，浏览器授权即可；也可以手动带上：

```bash
npm publish --otp=123456      # 手机 Authenticator 里那 6 位
```

发布后确认：

```bash
npm view oh-my-http version   # 应该输出 0.1.0
npx oh-my-http --version
```

发布计划：

- 包名 `oh-my-http`，MIT，零依赖，`engines: node >= 18.17`，ESM
- 打进包里的只有 `bin/`、`lib/`、`index.d.ts`（`files` 字段），测试与脚本不进包
- 发版流程：改 `package.json` 的 `version` + `lib/version.js` 里的 `VERSION`（有个用例会校验两者一致）→ `npm publish`

> 本机那个全局命令如果要用**已发布的版本**而不是源码，执行
> `npm rm -g oh-my-http && npm i -g oh-my-http`；想让它继续跟着源码走就用 `npm link`。

## License

MIT
