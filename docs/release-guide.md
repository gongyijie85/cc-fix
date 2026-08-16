# CC-Fix 发布指南

发布语义与门禁见 [ADR-0010](adr/0010-windows-release-gates.md)。公开资产只能由干净 tag 的 CI 构建，本地构建不发布。

## 发布候选（RC）

1. 在 `package.json` 把版本改为 `X.Y.Z-rc.N`（例如 `0.2.0-rc.1`）。
2. 提交并推送，创建 tag：

   ```powershell
   git tag v0.2.0-rc.1
   git push origin v0.2.0-rc.1
   ```

3. 在 GitHub Actions 手动运行 **Draft Windows release**（`release.yml`）：

   - `tag`: `v0.2.0-rc.1`
   - `allow_unsigned_rc`: 没有 Authenticode 证书时选 `true`；有证书后保持 `false`

4. 工作流会跑完整门禁并创建**草稿** Release。先不要公开：
   - 下载全部资产，核对 SHA-256、SBOM、`build-info.json` 与 attestation；
   - 在真实 Windows 客户端完成 ADR-0010 要求的测试线（主/兼容/新设备/遗留）；
   - P0/P1 清零，release-blocking P2 清零。

5. 确认通过后，把草稿 Release 标记为 prerelease 并公开。记录批准人、时间、门禁证据与已知限制。

RC 后任何代码、依赖、构建配置、安装器或载荷变化都必须递增 RC 并重新走完流程。

## 晋级正式版（Stable）

最后一个通过全部门禁的 RC 才能晋级。

1. 在 GitHub Actions 手动运行 **Promote RC to stable**（`promote.yml`）：

   - `rc_tag`: 最后一个通过的 RC tag，例如 `v0.2.0-rc.5`
   - `stable_version`: 例如 `0.2.0`

2. 工作流会：
   - 校验 RC Release 已公开且为 prerelease；
   - 只把 `package.json` 版本改为 stable，提交并打 `v0.2.0` tag；
   - 跑完整门禁、构建、证据验证、npm pack/install 验证；
   - 创建不可变正式 Release。

3. 人工确认正式 Release 资产后公开。npm `latest` 发布当前是 TODO（等待 npm OIDC Trusted Publishing 凭据），配置完成后由 `promote.yml` 发布同一版本/提交的 tarball。

## 本地预检

CI 会跑全部门禁；本地至少先跑：

```powershell
pnpm install --frozen-lockfile
pnpm release:validate
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:integration
pnpm test:gui
cargo test --locked --manifest-path native-helper/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm release:bundle
pnpm verify:evidence
pnpm verify:npm
```

Windows 生命周期测试（`pnpm test:windows`）在 CI 的 `windows-2025` 上执行，本地可跑但需要完整客户端环境。

## 当前外部依赖

- **代码签名**：未配置 Authenticode 证书，RC 必须显式 `allow_unsigned_rc`。
- **npm 发布**：`promote.yml` 的 publish 步骤标注 TODO，等待 npm org 配置 Trusted Publishing（OIDC）。
- **真实客户端矩阵**：ADR-0010 的主/兼容/新设备/遗留测试线需要真实 Windows 客户端或可信 VM，CI runner 不能替代。

## 修正与撤回

公开资产不可覆盖。发现严重问题时不替换，先在 Release 顶部标明风险、对 npm 版本执行 `npm deprecate`，再发新 RC 或补丁版。只有凭据泄露、恶意载荷或法律要求等紧急情况才删除公开资产。
