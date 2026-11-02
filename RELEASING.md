# 发布（维护者）

打包发布走 GitHub Actions：**推一个 `v*` tag 就自动发到 npm**，不需要本地 `npm login`，
也不需要把 npm token 存到 secrets 里（用 npm 的 Trusted Publishing + OIDC）。

## 一次性配置（在 npmjs.com 上）

1. 打开 https://www.npmjs.com/package/oh-my-http/access
2. 找到 **Trusted Publisher** → **Select your publisher** → **GitHub Actions**，填：

   | 字段 | 值 |
   | --- | --- |
   | Organization or user | `duzhenxun` |
   | Repository | `oh-my-http` |
   | Workflow filename | `publish.yml`（只写文件名，不带 `.github/workflows/`） |
   | Environment name | 留空 |

3. 保存。之后来自这个仓库、这个工作流的运行就能免 token 发布，并自动带上 provenance。

> 前提：仓库是公开的；`package.json` 里的 `repository.url` 指向该仓库（已满足）。
> 工作流里 `permissions: id-token: write` 必须保留，否则 OIDC 拿不到凭据。

## 发版流程

```bash
git checkout main && git pull

# 1. 改版本号：会自动 commit + 打 tag（patch / minor / major 按需）
npm version minor -m "v%s"

# 2. 把提交和 tag 一起推上去 → 触发 publish 工作流
git push --follow-tags
```

发版前把 `CHANGELOG.md` 里的 `## 未发布` 改成版本号（不改也能发，Release 说明会自动退回那一节）。

工作流（`.github/workflows/publish.yml`）会：

1. 校验 tag 和 `package.json` 的版本是否一致（不一致直接失败，不会发错版本）
2. `npm test`（单元测试，`prepublishOnly` 也会再跑一次）
3. `npm publish --provenance --access public`

发布完成后：
- 包页面：https://www.npmjs.com/package/oh-my-http
- 产物里有 `bin/`、`lib/`、`index.d.ts`、`CHANGELOG.md`、`README.md`、`LICENSE`（见 `package.json` 的 `files`）。
- npm 页面会显示 **Provenance**，能追溯到这次 GitHub Actions 运行。

日常提交（不打 tag）由 `.github/workflows/ci.yml` 跑测试 + 冒烟（Node 20 / 22 / 24）。

## 常见问题

**tag 和版本号不一致**：工作流会报错。用 `npm version <patch|minor|major>` 而不是手动 `git tag`，
它会把两边的版本一起改好。

**想重发同一个版本**：npm 不允许覆盖已发布版本。只能发新版本号（`npm version patch`）。

**删掉打错的 tag**：

```bash
git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0
```

如果工作流已经跑完并发布成功，只能发新版本或 `npm deprecate` 旧版本。

**备用方案：token 发布**（没配 Trusted Publisher 时）
在 npmjs 建一个 Granular Access Token（读+写该包），存到仓库 secrets 的 `NPM_TOKEN`，
然后取消 `.github/workflows/publish.yml` 里发布步骤的注释：

```yaml
      - name: 发布到 npm
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: npm publish --provenance --access public
```

**本地手动发布**（应急）

```bash
npm test
npm publish --access public --otp=<6 位验证码>
```
