# npm 发布准备与操作

仓库提供两个 GitHub Actions：

- `CI`：在 `main` push 和 Pull Request 上运行类型检查、测试、全部版本 bump 模式验证，以及三个包的 `npm publish --dry-run`。
- `Release npm packages`：只能手动触发。默认 `dry_run=true`，会完成版本 bump、测试和发布 dry-run，但不会发布、提交或创建 tag。

## 首次发布前需要准备

1. npm 账号开启双因素认证。
2. 确认你拥有 npm scope `@pi-extensions`：
   - npm 用户名为 `pi-extensions`；或
   - 你是 npm organization `pi-extensions` 中具有发布权限的成员。
3. 创建 npm granular access token：
   - Packages and scopes：允许读写 `@pi-extensions`；
   - Organizations：选择 `pi-extensions`（如果使用 organization）；
   - Expiration：设置合适的短有效期；
   - 如果 npm 账号要求发布时使用 2FA，需要为自动化 token 启用允许发布的 2FA bypass 选项。
4. 在 GitHub 仓库 `Settings → Secrets and variables → Actions` 新建 repository secret：
   - Name：`NPM_TOKEN`
   - Secret：上一步创建的 npm token
5. 在 GitHub 仓库 `Settings → Actions → General → Workflow permissions` 允许工作流具有读写权限。若 `main` 有分支保护，还需允许 GitHub Actions bot 推送 release commit 和 tag。

`GITHUB_TOKEN` 由 GitHub Actions 自动提供，不需要手动创建。它用于将版本提交和 tag 推回仓库；`NPM_TOKEN` 只用于 npm 发布。

## 2026 年 8 月 16 日首次测试

先打开 GitHub 仓库的 `Actions → Release npm packages → Run workflow`：

1. Branch 选择 `main`。
2. Package 选择 `all`。
3. Bump 选择 `patch`。
4. Dist tag 选择 `latest`。
5. 保持 `Dry run` 为选中状态。

确认所有步骤通过后，再运行一次相同配置并取消选中 `Dry run`。首次正式发布会把三个包从 `0.1.0` bump 到 `0.1.1`，发布后提交三个 package.json，并创建格式为 `@pi-extensions/包名@版本` 的 Git tag。

## 后续发布

- 正式修复：`patch`
- 向后兼容功能：`minor`
- 破坏性变更：`major`
- 预发布：选择 `prepatch`、`preminor`、`premajor` 或 `prerelease`，并将 dist tag 设置为 `beta`、`next` 或 `alpha`

三个包可一起发布，也可以单独发布。正式发布失败后可以用相同选项重新运行；脚本会跳过 npm registry 中已经存在的同版本包，继续完成剩余包和 Git 提交。

## 本地验证

```bash
pnpm install
pnpm check
pnpm test
pnpm release:verify-bump
pnpm release:dry-run
```

本地 dry-run 不需要 npm token，也不会修改版本或发布包。不要把 npm token 写入 `.npmrc`、代码、日志或提交历史。
