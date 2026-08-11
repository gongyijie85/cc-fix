# Windows RC 与正式公开版采用分层、可追溯且不可变的发布门禁

CC-Fix 首个 Windows 产品版本为 `0.2.0`：候选版从 `0.2.0-rc.1` 开始，正式版为 `0.2.0`，不再公开发布当前未发布的 `0.1.1`。Windows 单 EXE 是 GitHub Release 的主要入口，npm CLI 是使用相同 SemVer 和同一源码提交的兼容渠道。

公开发布资产只能由干净 tag 的受控 CI 构建。本地构建用于开发验证，不能上传公开 Release。RC 由 CI 生成草稿并经轻量人工批准后公开；正式版必须从最后一个通过全部门禁的 RC 晋级，并经过独立人工批准。

## Release channels and version identity

RC 使用 `X.Y.Z-rc.N`，npm dist-tag 为 `next`；正式版使用 `X.Y.Z`，npm dist-tag 为 `latest`。GitHub Release 先完成草稿资产校验、人工批准并公开，随后使用 OIDC Trusted Publishing 发布完全相同版本和提交的 npm tarball。npm 失败只允许重试已验证的相同 tarball，不得改内容或复用版本号。

最后一个 RC 后只允许变更版本元数据与发布说明。任何应用代码、依赖、构建配置、安装器脚本、内嵌运行时或 WebView2 载荷变化，都必须递增 RC 编号并重新通过门禁。正式 tag 与 npm 包必须能追溯到该晋级关系。

## Supported Windows test lines

- **主测试线**：Windows 11 25H2 x64。每个 RC 与正式版执行完整自动化/可重复的安装生命周期矩阵。
- **兼容测试线**：Windows 11 24H2 x64。RC 至少执行安装与核心功能验收，正式版执行安装、升级、核心保护与卸载验收。
- **新设备冒烟线**：Windows 11 26H1 x64。正式版发布前在真实客户端或可信 VM 上执行人工安装、启动、CLI、核心保护与卸载冒烟。
- **遗留兼容线**：Windows 10 22H2 x64。明确标注 Microsoft 已结束常规支持；RC 与正式版仍验证普通用户安装、核心功能和卸载，但不宣称操作系统仍受 Microsoft 常规支持。

Windows Server CI runner 不能替代 Windows 客户端验收。发布说明必须写明各测试线和遗留兼容限制。

## Required public assets

每个公开 GitHub Release 至少包含：

1. 版本化的 Windows x64 单 EXE 安装包。
2. `SHA256SUMS.txt`，覆盖全部公开下载资产。
3. CycloneDX JSON SBOM。
4. `THIRD-PARTY-NOTICES` 与许可证清单。
5. `build-info.json`，记录版本、tag、提交、构建时间、固定 Node/Rust/Tauri/Inno 工具链、锁文件摘要、签名状态和载荷清单摘要。
6. GitHub artifact attestation；workflow 必须在发布前实际执行验证，而不是只生成证明。

GitHub Release 使用 draft→上传全部资产→校验→人工批准→公开的顺序，并启用 Immutable Releases。tag、Release 和附件公开后不得移动、覆盖或用不同内容重发；任何修正使用新的 RC 或补丁版本。

## Signing and SmartScreen

代码签名证书可用时，所有 CC-Fix 自有 PE（桌面壳、特权助手、安装器和安装器生成的自有可执行组件）必须在生成公开校验和前完成 Authenticode 签名。使用 SHA-256 文件摘要和 RFC 3161 SHA-256 时间戳，验证签名有效、时间戳有效且发布者一致后才进入证据包。

官方 Node.js 私有运行时和 WebView2 安装器不由 CC-Fix 重签；构建入口必须验证其固定 SHA-256 与官方签名，再打入载荷。

没有证书不阻止 RC 或正式版，但 `build-info.json`、Release notes、安装说明和下载页面必须明确标记 unsigned，并解释 SmartScreen 可能出现的提示及 SHA-256/来源证明验证方法。签名也不能承诺 SmartScreen 永不提示，因此 SmartScreen 是否出现不作为确定性门禁。

同一版本不得在发布后由 unsigned 替换为 signed；取得证书后发布新版本。

## Reproducible build gate

所有构建依赖使用锁文件或固定版本，CI 记录来源 URL、摘要和工具链版本。RC 证明单次干净构建可追溯；正式版必须在两个独立干净环境中构建并比较可重复载荷：

- 单文件未签名核心 bundle 哈希一致；
- 私有 Node runtime 和受管程序文件的路径、大小与哈希清单一致；
- 依赖锁摘要一致；
- CycloneDX SBOM 的规范化依赖集合一致。

最终 Inno 安装包因构建元数据、Authenticode 和时间戳可不同，不要求逐字节一致。差异必须限于预先声明的非确定字段；受管载荷差异阻断正式发布。

## Automated and client lifecycle gates

所有现有及新增的类型检查、单元、集成、CLI、GUI、平台状态、事务恢复、桌面壳与安装器测试必须通过。测试不稳定按失败处理，不允许依靠重跑将红灯变绿。

主测试线的完整生命周期至少覆盖：

1. 无系统 Node.js、网络断开、普通用户权限下的 fresh install。
2. WebView2 已存在与完全缺失；缺失时使用内嵌 x64 Evergreen 离线安装器。
3. 安装后重新探测 WebView2；返回待重启或仍不可用时不自动重启、不启动 CC-Fix，并返回稳定结果。
4. GUI 首启、单实例、本地服务回收、CLI PATH 和新终端调用。
5. daily→standard→daily 与 daily→deep→daily 的完整、读回验证转换。
6. us/eu/jp/sg 四地区在检测、转换、状态、复测和历史中的一致性。
7. 同版本修复安装、RC→正式版升级；首版之后覆盖 N-1 正式版→当前版升级。
8. 日常状态普通卸载、保护状态完整还原后卸载、明确选择保留恢复数据的逃生卸载。
9. 安装失败的受管文件回退，以及事务活动/需恢复状态阻止升级或普通卸载。
10. PATH、快捷方式、用户恢复数据和安装注册在安装/修复/升级/卸载后的所有权边界。
11. 全流程不写入 VPN、路由器、路由表、网络适配器或 DNS 配置；相关结果只提醒。

兼容、新设备和遗留测试线执行前述规定子集，但 fresh install、GUI/CLI 启动、一次标准保护完整还原和卸载是所有测试线的最低共同门槛。

## Security, license and defect gates

- RC 和正式版均不得有开放的 P0/P1 缺陷。
- 正式版不得有影响安装、恢复、用户数据、权限边界、签名、供应链或外部网络只读边界的开放 P2。
- 纯展示或非关键诊断 P2 只有在人工批准并写入已知问题后才能随版本发布。
- 发布载荷中的已知 critical/high 运行时漏洞必须为零，不允许正式版例外。
- medium 漏洞需要书面影响分析、责任人和修复截止版本；开发依赖只有证明不进入载荷后才可降级。
- 未识别许可证、缺失第三方声明或未完成的分发义务阻断发布。Copyleft 依赖逐项审查，不作脱离许可证条款的机械禁用。
- secret scan、依赖审计、SBOM 生成、签名验证、哈希验证和 attestation 验证均必须在发布工作流中实际执行。

## Required documentation and approvals

缺失发布文档即阻断公开。每个版本的 Release notes/用户文档至少说明：支持矩阵、安装、手动升级、修复、卸载、保护状态预检、恢复数据保留、SHA-256 与 attestation 验证、签名状态和 unsigned SmartScreen 提示、已知问题，以及 VPN/路由器/DNS 只检测提醒的边界。

RC 公开批准记录批准人、时间、自动门禁证据、签名状态和已知限制。正式版使用独立完整检查表，除 RC 证据外还确认双构建、全部客户端测试线、版本晋级差异、Release/npm 编排和回退说明。

## Withdrawal and correction

发布后发现严重问题时，不静默替换资产。立即在 Release 顶部标明风险，对对应 npm 版本执行 deprecate，并发布新的 RC 或补丁版。只有凭据泄露、恶意载荷或法律要求等紧急情况才删除公开资产；删除时仍保留公开事件说明、受影响版本、原因和替代版本。

自动更新不在本轮。升级由用户下载新安装包手动执行，安装器依照 ADR 0008 的状态预检、原位升级与失败回退语义。

## Testable invariants

1. 同一公开版本的 Windows、npm、证据包和 Release 元数据指向同一源码提交。
2. 任何公开资产都能通过 SHA-256 和 GitHub attestation 验证；有证书时还能验证一致发布者和有效时间戳。
3. 公开版本的 tag 和资产从不被覆盖；内容变化必然产生新版本。
4. 正式版的可重复载荷通过两次独立干净构建比对。
5. 没有预装 Node.js、没有网络和没有预装 WebView2 时仍能完成受控安装或返回明确待重启状态。
6. 所有 Windows 测试线至少完成安装、启动、标准保护完整还原和卸载。
7. 活动事务或需恢复状态不能被升级、修复或普通卸载跨越。
8. 发布流程不会修改 VPN、路由、网卡或 DNS 配置。
9. RC 后任何非允许差异都会产生新 RC，不会直接晋级正式版。
10. npm 发布失败不会导致用不同内容重用已存在版本。

## Consequences

用户可以从版本、源码提交、签名状态、SBOM、哈希和来源证明完整追溯公开安装包，并在无代码签名证书阶段获得明确风险说明。代价是正式版发布需要真实 Windows 客户端矩阵、双构建、离线 WebView2 验收和人工批准，发布速度低于只上传 npm tarball 的旧流程。

## Official references

- Windows 生命周期：<https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information>
- Windows 10 结束支持：<https://learn.microsoft.com/en-us/lifecycle/announcements/windows-10-end-of-support>
- WebView2 分发：<https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution>
- Authenticode 时间戳：<https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures>
- SmartScreen reputation：<https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation>
- GitHub artifact attestations：<https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>
- GitHub immutable releases：<https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases>
- npm Trusted Publishing：<https://docs.npmjs.com/trusted-publishers/>
- Node.js release schedule：<https://nodejs.org/en/about/previous-releases>
