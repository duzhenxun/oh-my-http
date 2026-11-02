/**
 * 界面文案的中英文词典。
 *
 * - 语言来源：账号文件里的 settings.lang（'zh' | 'en' | 'auto'），auto 时看请求的 Accept-Language
 * - 默认 zh：没配置、也不带 Accept-Language 的请求（curl / 测试）仍然拿中文
 * - 写法：'key': { zh: '…', en: '…' }，用 {name} 占位
 */

export const LANGS = ['zh', 'en']

const strings = {
  // --- 通用 / 导航 ---
  'nav.files': { zh: '文件', en: 'Files' },
  'nav.status': { zh: '状态', en: 'Status' },
  'nav.logout': { zh: '退出登录', en: 'Sign out' },
  'nav.accounts': { zh: '账号管理', en: 'Accounts' },
  'nav.bindings': { zh: '目录绑定', en: 'Directory bindings' },
  'nav.language': { zh: '语言', en: 'Language' },
  'common.save': { zh: '保存', en: 'Save' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.delete': { zh: '删除', en: 'Delete' },
  'common.copy': { zh: '复制', en: 'Copy' },
  'common.copyLink': { zh: '复制链接', en: 'Copy link' },
  'common.copied': { zh: '已复制', en: 'Copied' },
  'common.copyFailed': { zh: '复制失败', en: 'Copy failed' },
  'common.browse': { zh: '浏览…', en: 'Browse…' },
  'common.days': { zh: '{n} 天', en: '{n} days' },
  'common.none': { zh: '—', en: '—' },
  'common.admin': { zh: '管理员', en: 'admin' },
  'common.member': { zh: '成员', en: 'member' },
  'common.localSession': { zh: '本机免登录', en: 'local, no login' },
  'common.you': { zh: '你', en: 'you' },
  'common.enabled': { zh: '正常', en: 'active' },
  'common.disabled': { zh: '已禁用', en: 'disabled' },
  'common.public': { zh: '公开', en: 'Public' },

  // --- 登录 ---
  'login.title': { zh: '登录 · {realm}', en: 'Sign in · {realm}' },
  'login.sub': { zh: '请输入用户名和密码', en: 'Enter your username and password' },
  'login.username': { zh: '用户名', en: 'Username' },
  'login.password': { zh: '密码', en: 'Password' },
  'login.remember': {
    zh: '记住我，{days} 天内不用重新登录',
    en: 'Remember me for {days} days',
  },
  'login.submit': { zh: '登录', en: 'Sign in' },
  'login.foot': { zh: 'oh-my-http · 默认可保持登录 {days} 天', en: 'oh-my-http · stays signed in for {days} days by default' },

  // --- 首次创建管理员 ---
  'setup.title': { zh: '创建管理员', en: 'Create the administrator' },
  'setup.sub': {
    zh: '还没有任何账号，先创建一个管理员。这个账号可以进 /admin 继续加人。',
    en: 'No accounts yet. Create the first administrator — you can add more people from /admin.',
  },
  'setup.username': { zh: '管理员用户名', en: 'Administrator username' },
  'setup.password': { zh: '密码（至少 6 位）', en: 'Password (at least 6 characters)' },
  'setup.confirm': { zh: '再输一次', en: 'Repeat the password' },
  'setup.token': { zh: '初始化口令', en: 'Setup token' },
  'setup.tokenHint': { zh: '见启动日志 / oh-my-http status', en: 'see the startup log / oh-my-http status' },
  'setup.tokenInfo': {
    zh: '你不是从内网访问的，为防止别人抢先创建管理员，需要填启动时打印的初始化口令。',
    en: 'You are not on the local network, so enter the setup token printed at startup to stop someone else from creating the first account.',
  },
  'setup.submit': { zh: '创建并登录', en: 'Create and sign in' },
  'setup.foot': { zh: 'oh-my-http · 创建后这个页面就不再出现', en: 'oh-my-http · this page disappears once an account exists' },

  // --- 锁定 ---
  'locked.title': { zh: '尝试次数过多', en: 'Too many attempts' },
  'locked.sub': {
    zh: '这个地址已被暂时锁定，请在 {mins} 分钟后再试。',
    en: 'This address is temporarily locked. Try again in {mins} minutes.',
  },
  'locked.info': {
    zh: '账号 {user} 连续输错密码会触发锁定（{attempts} 次锁 {minutes} 分钟）。可在服务器上执行 oh-my-http restart 清空锁定，或让管理员在 /admin 里点“解除锁定”。',
    en: 'Account {user} is locked after {attempts} wrong passwords ({minutes} minutes). Run oh-my-http restart on the server to clear it, or unlock it from /admin.',
  },

  // --- 子路径口令页 ---
  'pw.title': { zh: '需要密码', en: 'Password required' },
  'pw.sub': {
    zh: '路径 {path}/ 设置了独立口令，输入密码即可进入。',
    en: 'The path {path}/ has its own password. Enter it to continue.',
  },
  'pw.label': { zh: '密码', en: 'Password' },
  'pw.submit': { zh: '进入', en: 'Enter' },
  'pw.wrong': { zh: '密码不正确', en: 'Incorrect password' },
  'pw.foot': { zh: 'oh-my-http · 也可以直接用带口令的分享链接访问', en: 'oh-my-http · you can also open the share link directly' },

  // --- 首页 ---
  'index.youAre': { zh: '你的地址 {ip}，{who}。', en: 'Your address is {ip}, {who}.' },
  'index.loggedIn': { zh: '已登录为 {user}（{role}）', en: 'signed in as {user} ({role})' },
  'index.authMethod': { zh: '认证方式：{method}', en: 'auth method: {method}' },
  'index.warn': {
    zh: '注意：未启用认证，任何能访问到该端口的人都可以浏览这些文件。用 --user admin --pass <密码> 开启。',
    en: 'Warning: authentication is off — anyone who can reach this port can browse these files. Start with --user admin --pass <password> to enable it.',
  },
  'index.routeHealthz': { zh: '公共健康检查', en: 'public health check' },
  'index.routeWhoami': { zh: '查看来源 IP 与认证状态', en: 'source IP and auth status' },
  'index.routeEcho': { zh: '回显请求', en: 'echo the request' },
  'index.routeFiles': { zh: '浏览/下载绑定目录', en: 'browse/download the bound directory' },
  'index.routeBindings': { zh: '子目录绑定', en: 'sub-path binding' },
  'index.routeAdmin': { zh: '账号管理', en: 'accounts' },
  'index.routeAdminDesc': { zh: '添加/删除账号、重置密码', en: 'add/remove accounts, reset passwords' },

  // --- 认证未启用 / 无权访问 ---
  'disabled.title': { zh: '认证未启用', en: 'Authentication is off' },
  'disabled.sub': { zh: '当前没有配置密码，任何人都能访问，因此账号管理已关闭。', en: 'No password is configured, so anyone can access this server and account management is disabled.' },
  'disabled.hint': { zh: '用以下方式启动即可创建管理员账号：', en: 'Start it like this to create an administrator:' },
  'disabled.back': { zh: '返回首页', en: 'Back to home' },
  'forbidden.title': { zh: '无权访问', en: 'Access denied' },
  'forbidden.sub': { zh: '当前账号 {actor} 不是管理员。', en: 'The current account {actor} is not an administrator.' },
  'forbidden.home': { zh: '返回首页', en: 'Back to home' },

  // --- 账号管理页 ---
  'admin.title': { zh: '账号管理', en: 'Accounts' },
  'admin.who': { zh: '{realm} · 当前登录 {actor}（管理员）', en: '{realm} · signed in as {actor} (administrator)' },
  'admin.addUser': { zh: '添加账号', en: 'Add an account' },
  'admin.username': { zh: '用户名', en: 'Username' },
  'admin.password': { zh: '密码', en: 'Password' },
  'admin.passwordHint': { zh: '至少 {min} 位', en: 'at least {min} characters' },
  'admin.role': { zh: '角色', en: 'Role' },
  'admin.roleMemberOption': { zh: '成员（只能看文件）', en: 'member (read-only files)' },
  'admin.roleAdminOption': { zh: '管理员（可管理账号）', en: 'administrator (can manage accounts)' },
  'admin.create': { zh: '创建', en: 'Create' },
  'admin.protection': { zh: '登录保护', en: 'Login protection' },
  'admin.accountMax': { zh: '同一账号失败几次锁定', en: 'Lock an account after N failures' },
  'admin.ipMax': { zh: '同一 IP 失败几次锁定', en: 'Lock an IP after N failures' },
  'admin.lockout': { zh: '锁定时长（分钟）', en: 'Lockout duration (minutes)' },
  'admin.policy': {
    zh: '当前策略：同一账号失败 {attempts} 次锁 {minutes} 分钟；{ip}。填 0 表示该维度不锁。',
    en: 'Current policy: an account is locked after {attempts} failures for {minutes} minutes; {ip}. 0 disables that dimension.',
  },
  'admin.ipLocked': { zh: '同一 IP 失败 {n} 次也锁', en: 'an IP is locked after {n} failures too' },
  'admin.ipLockOff': {
    zh: '按 IP 锁定已关闭（0，推荐：隧道 / 反代 / 公司出口后面大家共用一个 IP，开了会误伤整片人）',
    en: 'IP locking is off (0, recommended: behind a tunnel/proxy/office NAT everyone shares one IP)',
  },
  'admin.lockShared': {
    zh: '表单登录和 curl -u 共用这把锁；同一个错误密码重复提交只算一次；锁定期间连正确密码也会被拒。当前被锁的键：{count} 个。',
    en: 'Form login and curl -u share this lock; the same wrong password counts once; while locked, even the right password is rejected. Currently locked keys: {count}.',
  },
  'admin.unlockAll': { zh: '立即解除所有锁定（{count} 个）', en: 'Unlock everything now ({count})' },
  'admin.sourceCli': {
    zh: '当前值是本次启动的命令行参数（--account-max-attempts / --ip-max-attempts / --lockout-minutes）指定的，会覆盖这里的设置；去掉命令行参数后以本页为准。',
    en: 'These values come from this run\u2019s CLI flags (--account-max-attempts / --ip-max-attempts / --lockout-minutes) and override this page; drop the flags to make this page authoritative.',
  },
  'admin.sourceDefault': {
    zh: '当前用的是默认值（3 次 / 60 分钟）。保存一次后就会持久化到这个账号文件里。',
    en: 'Defaults are in use (3 attempts / 60 minutes). Save once to persist them into the account file.',
  },
  'admin.trustedNote': { zh: '内网免认证的来源不受影响，即使被锁也能从局域网直接进来。', en: 'Trusted intranet sources are unaffected — they can still connect from the LAN even while locked.' },
  'admin.locksTitle': { zh: '当前锁定 / 失败记录', en: 'Current locks / failures' },
  'admin.thType': { zh: '类型', en: 'Type' },
  'admin.thTarget': { zh: '对象', en: 'Subject' },
  'admin.thState': { zh: '状态', en: 'State' },
  'admin.tagAccount': { zh: '账号', en: 'account' },
  'admin.tagIp': { zh: 'IP', en: 'IP' },
  'admin.tagLocked': { zh: '已锁定', en: 'locked' },
  'admin.lockUntil': {
    zh: '将于 {time} 自动解锁（还剩 {mins} 分钟）',
    en: 'auto-unlocks at {time} (in {mins} min)',
  },
  'admin.lockFails': { zh: '失败 {n} 次，再错 {left} 次就会锁定', en: '{n} failures; {left} more will lock it' },
  'admin.unlockNow': { zh: '立即解锁', en: 'Unlock now' },
  'admin.clearRecord': { zh: '清除记录', en: 'Clear record' },
  'admin.locksNote': {
    zh: '锁定是按账号（默认）或来源 IP（可选）计的，存在内存里：重置密码会自动解除该账号的锁定，重启服务会清空全部锁定。',
    en: 'Locks are counted per account (default) or per source IP (optional) and kept in memory: changing a password clears that account\u2019s lock, restarting clears all locks.',
  },
  'admin.usersTitle': { zh: '共 {count} 个账号', en: '{count} accounts' },
  'admin.thUser': { zh: '用户名', en: 'Username' },
  'admin.thRole': { zh: '角色', en: 'Role' },
  'admin.thState': { zh: '状态', en: 'State' },
  'admin.thCreated': { zh: '创建时间', en: 'Created' },
  'admin.thLastLogin': { zh: '最近登录', en: 'Last sign-in' },
  'admin.legacyHash': { zh: '旧哈希', en: 'legacy hash' },
  'admin.legacyHint': { zh: '由 --pass-sha256 引导创建，建议重置密码', en: 'bootstrapped via --pass-sha256; consider resetting the password' },
  'admin.resetPassword': { zh: '重置密码', en: 'Reset password' },
  'admin.newPassword': { zh: '新密码', en: 'new password' },
  'admin.setAdmin': { zh: '设为管理员', en: 'Make admin' },
  'admin.setMember': { zh: '降为成员', en: 'Make member' },
  'admin.disable': { zh: '禁用', en: 'Disable' },
  'admin.enable': { zh: '启用', en: 'Enable' },
  'admin.selfDelete': { zh: '不能删除自己', en: 'cannot delete yourself' },
  'admin.deleteConfirm': { zh: '确定删除账号 {user} ？', en: 'Delete account {user}?' },
  'admin.noUsers': { zh: '还没有账号', en: 'No accounts yet' },
  'admin.storage': {
    zh: '账号保存在 {storage}，密码用 scrypt 加盐哈希存储，文件权限 0600。会话密钥也保存在这里，所以登录状态在服务重启后依旧有效；把该文件删掉才会让所有人重新登录。',
    en: 'Accounts live in {storage}; passwords are scrypt-hashed with a salt and the file is 0600. The session secret is stored there too, so sign-ins survive restarts — delete the file to force everyone to sign in again.',
  },
  'admin.storageMemory': { zh: '未启用账号文件（本进程内的临时账号）', en: 'no account file (in-memory accounts only)' },

  // --- 目录绑定页 ---
  'bindings.title': { zh: '目录绑定', en: 'Directory bindings' },
  'bindings.defaultDir': { zh: '默认目录（挂在 /）', en: 'Default directory (mounted at /)' },
  'bindings.dirLabel': { zh: '目录', en: 'Directory' },
  'bindings.defaultPlaceholder': { zh: '/Users/you/site 或 ~/Downloads', en: '/Users/you/site or ~/Downloads' },
  'bindings.current.none': { zh: '未设置', en: 'not set' },
  'bindings.current.noneHint': { zh: '内置首页，除内置接口外不提供任何文件', en: 'built-in home page; no files besides the built-in routes' },
  'bindings.current.admin': { zh: '后台设置，优先于命令行', en: 'set here, overrides the CLI' },
  'bindings.current.cli': { zh: '来自命令行 {flag}；可在上面改成后台设置', en: 'from the CLI ({flag}); save above to move it here' },
  'bindings.clear': { zh: '清除', en: 'Clear' },
  'bindings.clearConfirm': { zh: '清除后台设置的默认目录？文件不会被删，会回到命令行绑定或内置首页', en: 'Clear the default directory set here? Files are not deleted; it falls back to the CLI binding or the built-in home page.' },
  'bindings.currentLabel': { zh: '当前默认目录：', en: 'Current default directory: ' },
  'bindings.subpaths': { zh: '子路径绑定', en: 'Sub-path bindings' },
  'bindings.path': { zh: '访问路径', en: 'Path' },
  'bindings.dir': { zh: '本地目录', en: 'Local directory' },
  'bindings.dirPlaceholder': { zh: '/Users/you/project 或 ~/Downloads', en: '/Users/you/project or ~/Downloads' },
  'bindings.autoAuth': { zh: '自动生成访问口令（不用手填密码）', en: 'Generate an access password automatically (no typing)' },
  'bindings.bind': { zh: '绑定', en: 'Bind' },
  'bindings.auth': { zh: '访问口令', en: 'Access' },
  'bindings.authPublic': { zh: '跟随主站', en: 'follows main auth' },
  'bindings.authPassword': { zh: '仅密码', en: 'password only' },
  'bindings.authBoth': { zh: '账号 + 密码', en: 'user + password' },
  'bindings.expiry': { zh: '有效期', en: 'Validity' },
  'bindings.endTime': { zh: '结束时间', en: 'Expires' },
  'bindings.expired': { zh: '已过期', en: 'expired' },
  'bindings.generate': { zh: '生成分享链接', en: 'Create share link' },
  'bindings.regenerate': { zh: '重新生成分享链接', en: 'Regenerate share link' },
  'bindings.daysTitle': { zh: '有效期（天）', en: 'validity (days)' },
  'bindings.deleteConfirm': { zh: '确定取消绑定 {mount} ？文件不会被删', en: 'Remove the binding {mount}? Files are not deleted.' },
  'bindings.empty': { zh: '还没有子路径绑定', en: 'No sub-path bindings yet' },
  'bindings.addHint': {
    zh: '勾选「自动生成访问口令」时，系统会直接生成一个随机口令（与主站账号、内网免认证无关），不用自己想密码；生成后立刻给出分享链接（默认 3 天有效）。不勾选则这条路径跟随主站认证。之后想换密码不用找设置项：点「重新生成分享链接」就会换一个新口令，旧链接立刻失效。',
    en: 'With “Generate an access password automatically”, a random password is created for you (independent of the main accounts and intranet bypass) and a share link is issued right away (3 days by default). Leave it unchecked to follow the main auth. To change the password later, just regenerate the share link — the old one stops working immediately.',
  },
  'bindings.shareTitle': { zh: '分享链接', en: 'Share link' },
  'bindings.shareNote': {
    zh: '把这个链接发出去，对方打开就能直接看，之后会种一个同有效期的 Cookie，点进子目录也不用再输。',
    en: 'Send this link to anyone — opening it grants access directly, and a cookie with the same lifetime keeps sub-directories open too.',
  },
  'bindings.shareExpires': {
    zh: '有效期至 {time}（{days} 天），到期自动失效。',
    en: 'valid until {time} ({days} days), then it stops working.',
  },
  'bindings.shareNoPassword': {
    zh: '链接里是签名令牌，不含密码。需要换密码时再点一次「重新生成分享链接」，旧链接立即失效。',
    en: 'The link contains a signed token, not the password. Regenerate the share link to rotate the password; the old link stops working at once.',
  },
  'bindings.notes.1': {
    zh: '保存后立即生效，不用重启：默认目录决定 / 下看到什么；子路径把 /abc 这种前缀单独指到另一个目录。目录可以点「浏览…」在弹窗里挑，也可以直接手输（绝对路径或 ~/xxx）。',
    en: 'Changes apply immediately, no restart: the default directory decides what / shows, and a sub-path points a prefix like /abc at another directory. Pick a directory with “Browse…”, or type an absolute path or ~/xxx.',
  },
  'bindings.notes.2': {
    zh: '路径按最长前缀匹配，可以绑多层（/abc/logs），子路径总是赢过默认目录；/admin、/login、/healthz、/whoami、/api 这些内置接口不能占用。',
    en: 'Paths match by longest prefix, so you can nest them (/abc/logs); sub-paths always win over the default directory. Built-in routes (/admin, /login, /healthz, /whoami, /api) cannot be taken.',
  },
  'bindings.notes.3': {
    zh: '目录暂时不存在时该路径返回 404，绑定不会被删掉（外挂盘没挂上时很实用）。独立口令的密码用 scrypt 加盐哈希保存，连错同样会被锁定，可在「账号管理 → 当前锁定 / 失败记录」里解锁。分享链接形如 http://这台机器/路径?toke=令牌（也认 token / pwd / key），令牌带过期时间（默认 3 天，行内可改），验证通过后种一个同有效期的 Cookie 并跳到不带令牌的干净地址；旧版直接把密码拼在 URL 里的写法仍然兼容。',
    en: 'If a directory disappears the path returns 404 and the binding is kept (handy for removable disks). Passwords are scrypt-hashed; repeated failures are locked and can be cleared from Accounts → Current locks / failures. Share links look like http://host/path?toke=token (token / pwd / key also work); the token expires (3 days by default, adjustable per row), and a successful visit sets a cookie with the same lifetime and redirects to a clean URL. The old style of putting the password in the URL still works.',
  },
  'bindings.persist.file': {
    zh: '绑定表保存在 {file} 的 settings.mounts 里，重启后依旧有效。',
    en: 'Bindings are stored in settings.mounts inside {file} and survive restarts.',
  },
  'bindings.persist.memory': {
    zh: '当前没有使用账号文件（--users-file none），绑定只会存在内存里，重启后丢失。',
    en: 'No account file is in use (--users-file none), so bindings live in memory only and are lost on restart.',
  },
  'bindings.shareDays': { zh: '{n} 天', en: '{n} days' },

  // --- 目录浏览弹窗 ---
  'dir.title': { zh: '选择项目文件夹', en: 'Choose a folder' },
  'dir.name': { zh: '名称', en: 'Name' },
  'dir.size': { zh: '大小', en: 'Size' },
  'dir.kind': { zh: '类型', en: 'Kind' },
  'dir.date': { zh: '修改日期', en: 'Date modified' },
  'dir.search': { zh: '搜索', en: 'Search' },
  'dir.empty': { zh: '（没有内容）', en: '(empty)' },
  'dir.noMatch': { zh: '没有匹配的项目', en: 'No matching items' },
  'dir.reading': { zh: '读取中…', en: 'Loading…' },
  'dir.loadFail': { zh: '读取失败，请重试', en: 'Could not read the folder, try again' },
  'dir.tooMany': { zh: '条目太多，只显示前 300 个；可直接手输完整路径', en: 'Too many items — showing the first 300. Type the full path instead.' },
  'dir.folder': { zh: '文件夹', en: 'Folder' },
  'kind.text': { zh: '文本', en: 'Text' },
  'kind.code': { zh: '代码', en: 'Code' },
  'kind.image': { zh: '图片', en: 'Image' },
  'kind.video': { zh: '视频', en: 'Video' },
  'kind.audio': { zh: '音频', en: 'Audio' },
  'kind.archive': { zh: '压缩包', en: 'Archive' },
  'kind.pdf': { zh: 'PDF', en: 'PDF' },
  'kind.sheet': { zh: '表格', en: 'Spreadsheet' },
  'kind.doc': { zh: '文档', en: 'Document' },
  'kind.slides': { zh: '演示', en: 'Presentation' },
  'kind.file': { zh: '文件', en: 'file' },
  'dir.up': { zh: '上一级', en: 'Up one level' },
  'dir.pick': { zh: '选取', en: 'Choose' },
  'dir.group.favorite': { zh: '个人收藏', en: 'Favourites' },
  'dir.group.location': { zh: '位置', en: 'Locations' },
  'dir.group.binding': { zh: '已绑定', en: 'Bindings' },
  'dir.home': { zh: '家目录', en: 'Home' },
  'dir.desktop': { zh: '桌面', en: 'Desktop' },
  'dir.downloads': { zh: '下载', en: 'Downloads' },
  'dir.documents': { zh: '文稿', en: 'Documents' },
  'dir.applications': { zh: '应用程序', en: 'Applications' },
  'dir.music': { zh: '音乐', en: 'Music' },
  'dir.movies': { zh: '影片', en: 'Movies' },
  'dir.pictures': { zh: '图片', en: 'Pictures' },
  'dir.cwd': { zh: '工作目录', en: 'Working directory' },
  'dir.root': { zh: '根目录 /', en: 'Macintosh HD' },
  'dir.bound': { zh: '绑定 {mount}', en: 'Binding {mount}' },
  'dir.notDir': { zh: '这个路径不是目录', en: 'That path is not a directory' },
  'dir.noAccess': { zh: '这个目录不存在，或没有读取权限', en: 'That directory does not exist, or cannot be read' },
  'listing.badEncoding': { zh: '非法 URL 编码', en: 'Invalid URL encoding' },
  'auth.needBindingPassword': { zh: '这个路径需要单独的账号密码', en: 'This path needs its own username and password' },
  'auth.needCredentials': { zh: '需要有效凭据，或从内网访问', en: 'Valid credentials (or intranet access) are required' },
  'auth.remaining': {
    zh: '（还剩 {left} 次机会，超过会锁定 {minutes} 分钟）',
    en: ' ({left} attempts left before a {minutes}-minute lock)',
  },

  // --- 目录列表（静态文件页） ---
  'listing.name': { zh: '名称', en: 'Name' },
  'listing.size': { zh: '大小', en: 'Size' },
  'listing.modified': { zh: '修改时间', en: 'Modified' },
  'listing.empty': { zh: '空目录', en: 'Empty folder' },
  'listing.tooMany': { zh: '目录条目过多，仅显示前 {n} 项。', en: 'Too many entries — showing the first {n}.' },
  'listing.parent': { zh: '上一级', en: 'Parent folder' },

  // --- 后台提示信息 ---
  'login.error.wrong': { zh: '用户名或密码不正确', en: 'Incorrect username or password' },
  'login.error.remaining': {
    zh: '（还剩 {left} 次机会，超过会锁定 {minutes} 分钟）',
    en: ' ({left} attempts left before a {minutes}-minute lock)',
  },
  'login.error.locked': {
    zh: '失败次数过多，已锁定，请在 {mins} 分钟后再试',
    en: 'Too many failures — locked, try again in {mins} minutes',
  },
  'login.error.lockedFor': {
    zh: '失败次数过多，已锁定 {minutes} 分钟',
    en: 'Too many failures — locked for {minutes} minutes',
  },
  'login.error.body': { zh: '请求体过大或无法解析', en: 'Request body too large or unreadable' },
  'setup.error.throttle': { zh: '尝试过多，请 {mins} 分钟后再试', en: 'Too many attempts — try again in {mins} minutes' },
  'setup.error.tokenLocked': {
    zh: '初始化口令错误次数过多，请 {mins} 分钟后再试',
    en: 'Too many wrong setup tokens — try again in {mins} minutes',
  },
  'setup.error.tokenWrong': {
    zh: '初始化口令不正确（见启动日志里的「初始化口令」）',
    en: 'Incorrect setup token (see the one printed in the startup log)',
  },
  'setup.error.badUser': {
    zh: '用户名只能包含字母、数字、. _ -，长度 1-32',
    en: 'Username may only contain letters, digits, . _ - and be 1-32 characters',
  },
  'setup.error.badPass': { zh: '密码至少 {min} 位', en: 'Password must be at least {min} characters' },
  'setup.error.mismatch': { zh: '两次输入的密码不一致', en: 'The two passwords do not match' },
  'ok.created': { zh: '账号已创建', en: 'Account created' },
  'ok.deleted': { zh: '账号已删除', en: 'Account deleted' },
  'ok.password': { zh: '密码已重置', en: 'Password reset' },
  'ok.role': { zh: '角色已更新', en: 'Role updated' },
  'ok.enabled': { zh: '账号已启用', en: 'Account enabled' },
  'ok.disabled': { zh: '账号已禁用', en: 'Account disabled' },
  'ok.settings': { zh: '登录保护设置已保存并立即生效', en: 'Login protection saved and applied' },
  'ok.unlocked': { zh: '已解除所有锁定', en: 'All locks cleared' },
  'ok.unlocked_one': { zh: '已解除该锁定', en: 'Lock cleared' },
  'ok.bound': { zh: '子路径绑定已添加，立即生效（不用重启）', en: 'Binding added and applied immediately (no restart)' },
  'ok.unbound': { zh: '子路径绑定已删除，立即生效', en: 'Binding removed and applied immediately' },
  'ok.default_bound': { zh: '默认目录已设置，立即生效（挂在 /，优先于命令行绑定）', en: 'Default directory set and applied (mounted at /, overrides the CLI)' },
  'ok.default_cleared': { zh: '后台设置的默认目录已清除，回到命令行绑定 / 内置首页', en: 'Default directory cleared — back to the CLI binding or the built-in home page' },
  'ok.share': { zh: '分享链接已生成（旧链接立即失效）', en: 'Share link created (old links stop working)' },
  'ok.binding_auth': { zh: '独立账号已保存，访问该路径会弹框要求输入', en: 'Password saved — the path now asks for it' },
  'ok.binding_public': { zh: '已取消独立账号，该路径改回跟随主站认证', en: 'Password removed — the path follows the main auth again' },
  'ok.lang': { zh: '界面语言已切换', en: 'Language switched' },
  'err.exists': { zh: '该用户名已存在', en: 'That username already exists' },
  'err.invalid_user': { zh: '用户名不合法（字母、数字、. _ -，1-32 位）', en: 'Invalid username (letters, digits, . _ -, 1-32 chars)' },
  'err.invalid_password': { zh: '密码至少 {min} 位', en: 'Password must be at least {min} characters' },
  'err.invalid_role': { zh: '角色不合法', en: 'Invalid role' },
  'err.last_admin': { zh: '至少要保留一个可用的管理员账号', en: 'Keep at least one usable administrator' },
  'err.self_delete': { zh: '不能删除当前登录的账号', en: 'You cannot delete the account you are signed in with' },
  'err.notfound': { zh: '账号不存在', en: 'Account not found' },
  'err.not_locked': { zh: '该记录已经不存在了（可能已自动解锁）', en: 'That record no longer exists (it may have expired)' },
  'err.csrf': { zh: '安全校验失败，请刷新页面重试', en: 'Security check failed — reload the page and try again' },
  'err.bad_request': { zh: '请求格式不正确', en: 'Malformed request' },
  'err.invalid_settings': { zh: '设置不合法：失败次数 0-100，锁定时长 0-10080 分钟', en: 'Invalid settings: attempts 0-100, lockout 0-10080 minutes' },
  'err.bind_exists': { zh: '该路径已经绑定过了，先删掉旧的再绑', en: 'That path is already bound — remove the old one first' },
  'err.bind_root': { zh: '根路径 / 请在「默认目录」里设置（子路径绑定要写 /abc 这种前缀）', en: 'Set / in “Default directory”; sub-path bindings need a prefix like /abc' },
  'err.bind_invalid': { zh: '路径不合法：必须以 / 开头，例如 /abc（不能含空格、?、#、..）', en: 'Invalid path: must start with /, e.g. /abc (no spaces, ?, #, ..)' },
  'err.bind_reserved': { zh: '这个路径被内置接口占用（/admin、/login、/logout、/healthz、/whoami、/api）', en: 'That path is reserved by built-in routes (/admin, /login, /logout, /healthz, /whoami, /api)' },
  'err.bind_missing': { zh: '本地目录不存在或不是目录，请检查路径（支持绝对路径与 ~/xxx）', en: 'The local directory does not exist or is not a directory (absolute paths and ~/xxx are supported)' },
  'err.bind_auth_user': { zh: '独立账号用户名只能是字母、数字、. _ -，1-32 位', en: 'Password username must be letters, digits, . _ -, 1-32 chars' },
  'err.bind_auth_pass': { zh: '独立口令的密码不能为空，且至少 6 位', en: 'The password cannot be empty and needs at least 6 characters' },
  'err.bind_auth_incomplete': { zh: '要设独立口令，至少要填密码（账号可选）', en: 'A password is required (the username is optional)' },
  'err.bind_share_days': { zh: '有效期请填 1-365 天', en: 'Validity must be 1-365 days' },
  'err.bind_no_auth': { zh: '这条路径还没有口令，先点「生成分享链接」', en: 'This path has no password yet — create a share link first' },
  'err.default': { zh: '操作完成', en: 'Done' },
}

/** 规范化语言值：'zh' | 'en' | 'auto' */
export function normalizeLang(raw, fallback = 'auto') {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return fallback
  if (v === 'auto' || v === 'system') return 'auto'
  if (LANGS.includes(v)) return v
  if (v.startsWith('zh')) return 'zh'
  if (v.startsWith('en')) return 'en'
  return fallback
}

/** 决定这次请求用哪种语言：显式设置 > Accept-Language > 中文。 */
export function pickLang(saved, acceptLanguage) {
  const explicit = normalizeLang(saved)
  if (explicit !== 'auto') return explicit
  const header = String(acceptLanguage || '').toLowerCase()
  if (!header) return 'zh'
  // 按 q 值粗略判断：出现中文就用中文，否则出现英文就用英文
  if (/zh\b|zh-/.test(header)) return 'zh'
  if (/en\b|en-/.test(header)) return 'en'
  return 'zh'
}

/**
 * 生成翻译函数：t('nav.files') / t('common.days', { n: 3 })
 * @param {'zh'|'en'} lang
 */
export function createT(lang) {
  const active = lang === 'en' ? 'en' : 'zh'
  return function t(key, vars) {
    const entry = strings[key]
    if (!entry) return key
    let text = entry[active] ?? entry.zh
    if (vars) {
      text = text.replace(/\{(\w+)\}/g, (match, name) =>
        vars[name] === undefined || vars[name] === null ? match : String(vars[name]),
      )
    }
    return text
  }
}

/** 供测试/工具读取词典。 */
export function hasKey(key) {
  return Object.hasOwn(strings, key)
}
