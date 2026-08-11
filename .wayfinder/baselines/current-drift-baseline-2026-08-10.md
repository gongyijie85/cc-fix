# CC-Fix 当前漂移基线（2026-08-10）

## 1. 范围与快照

- 基线提交：`main@d6679cb`，与 `origin/main` 一致。
- 盘点范围：代码行为、`CONTEXT.md`、ADR、`SPEC.md`、`README.md`、测试、版本、npm/GitHub Release、未跟踪实验材料、Windows 构建与安装链。
- 本文只记录事实、证据、风险和待决问题，不修改产品实现。
- 风险口径：P0 当前交付目标的硬阻断或不可逆数据风险；P1 产品语义/恢复/发布高风险；P2 可观测性、覆盖或一致性风险；P3 低风险完整性问题。
- 当前 P0 是 Windows 产品构建/安装/发布链尚不存在；P1 项必须在完整 Windows 安装包发布前闭环。

## 2. 执行摘要

当前仓库仍是一个依赖系统 Node.js 的 npm CLI 与本地 Web GUI，而已确认的目标产品是带私有 Node 24 LTS 运行时的 Tauri v2 Windows 桌面壳，并由 Inno Setup 生成 per-user 单 EXE 安装包。目标模型已经写入本地 `CONTEXT.md` 与 ADR 0004–0008，但这些文件尚未提交到 `main`；产品代码、测试、发布链也尚未落实这些决定。

最大风险集中在四处：

1. 当前 `persist on` 实际执行“深度保护”修改，却没有标准/深度选择，且状态仅由备份文件存在推断。
2. 持久化切换没有耐久事务、完整补偿、读回验证和原子提交；失败后可能出现配置已部分变化但 UI 报告 secure 的状态。
3. 地区偏好、当前生效地区与本次请求目标没有分离；GUI 复测固定使用 US，非 US 结果会被错误评分。
4. 公开版本、CLI 版本、安装脚本、README、SPEC 与真实行为及目标安装链均存在明显漂移，且没有 CI、安装器或发布门禁。

已确认的产品边界：VPN、路由器、路由表、网络适配器和 DNS 等外部网络配置只做检测、解释和提醒，不执行自动修改。当前 DNS/代理检测插件与终端提示符合此边界；后续 GUI、persist、安装器和推荐系统必须维持只读语义。该决定记录于 ADR 0009。

## 3. 代码行为与已确认模型的漂移

| 风险 | 事实 | 证据 | 影响 |
|---|---|---|---|
| P1 | 默认保护强度相反：没有强度参数，`persist on` 无条件修改 `LocaleName`、把语言列表压成单一目标并修改 `Culture`。 | `src/index.ts:49-56`；`src/fix/flow.ts:46-53,256-334`；目标定义见 `CONTEXT.md:22-25`、ADR 0004 | 用户选择默认路径时会发生未披露的系统语言/区域画像变化。 |
| P1 | 状态只以备份文件是否存在返回 daily/secure，没有 standard/deep、health、transaction 或 committed target。 | `src/platform/windows.ts:356-369,378-409`；ADR 0006 | 备份创建后即使执行失败，UI 仍可能报告已保护并禁用地区选择。 |
| P1 | `persist on` 是顺序写入，无 journal、逐项读回验证和提交点；锁仅记录 PID/时间，超过 5 分钟按年龄删除。 | `src/fix/flow.ts:159-219,264-366`；`src/platform/windows.ts:145-167`；ADR 0006 | 崩溃、超时或并发执行时无法可靠判断和恢复事务。 |
| P1 | on 的补偿不完整：系统时区读取/写入失败时不会完整恢复此前改过的语言列表和 Culture。 | `src/fix/flow.ts:337-380,630-656` | 失败返回后可能遗留部分保护画像。 |
| P1 | off 任一步失败立即停止，而不是尝试全部恢复项并保存进度。 | `src/fix/flow.ts:442-445,469-473,498-501,529-532,557-560,602-606` | 恢复过程不收敛，用户需要猜测哪些项已恢复。 |
| P1 | 原始 `LocaleName`/Culture 为 null，或语言列表为空时，off 的 truthy/非空判断会跳过恢复。 | `src/fix/flow.ts:478-563` | 日常原态无法被精确重建。 |
| P1 | 旧备份缺字段时使用当前系统值回填；当前值可能已是保护态。 | `src/fix/flow.ts:95-146`；`src/platform/windows.ts:205-226,306-317` | 迁移可能污染“原始日常快照”。 |
| P2 | 备份写入只有临时文件后 rename/copy，没有 fsync、校验和前代副本。 | `src/platform/windows.ts:34-50` | 掉电或文件损坏时缺乏可验证恢复点。 |

## 4. 地区状态与检测漂移

| 风险 | 事实 | 证据 | 影响 |
|---|---|---|---|
| P1 | 没有 `preferredRegion`；状态中的 `activeRegion` 直接来自备份。 | `src/platform/windows.ts:360,401`；ADR 0005 | 静态地区目录、用户偏好、生效地区和本次目标无法区分。 |
| P1 | `activeRegion` 在任何设置写入前补到备份中，且已有值永不更新。 | `src/fix/flow.ts:82`；`src/platform/windows.ts:135-143` | 地区并非成功后原子提交；跨地区重复 on 会出现配置与状态不一致。 |
| P1 | CLI 无参数重复 on 默认 US；实际设置会切换，状态仍保留首次地区。 | `src/index.ts:52`；`src/fix/flow.ts:148`；`src/platform/windows.ts:139` | 例如 US→JP 后配置为 JP、状态仍为 US；JP 状态下无参数又会切回 US。 |
| P1 | GUI 首检、刷新、修复后复测固定使用 US；地区下拉只传给修复端点。 | `src/gui/server.ts:122`；`src/gui/index.html:307,419,441` | EU/JP/SG 修复后按错误目标评分。 |
| P1 | recheck 只保存 before/after 裸分数，不保存目标地区。 | `src/gui/server.ts:59` | 不同目标之间仍会被直接比较。 |
| P1 | 非法地区静默回落 US；CLI 把原始非法值传入状态，GUI 则传规范化后的 `us`。 | `src/detection/regions.ts:40-43`；`src/index.ts:49-56`；`src/gui/server.ts:94-104` | 同一非法输入在 CLI/GUI 产生不同持久化事实，且没有明确错误。 |
| P2 | `CheckResponse.region` 始终是 `auto`，`matchedRegion` 始终 null，即使明确指定目标。 | `src/detection/runner.ts:19`；`src/detection/scoring.ts:151` | 检测结果无法说明使用了哪个目标。 |
| P2 | GUI 每次加载地区列表都重置到默认 US，并且只用 status 的 `enabled`，不恢复 active/preferred 地区。 | `src/gui/index.html:459-483` | 受保护为 JP/EU/SG 时仍显示禁用的 US。 |
| P2 | history 不记录请求地区、最终生效地区或目标来源。 | `src/fix/history.ts:6,60,74` | 无法审计失败切换是否保持旧目标。 |
| P2 | 一致性插件只实现 New York/US；Locale 仅比较主语言；Windows 区域插件忽略目标且会把目标 `en-SG` 判为 medium。 | `src/detection/plugins/consistency.ts:32`；`locale.ts:12`；`win-region.ts:21,40` | 四地区评分口径不自洽，US 默认值掩盖问题。 |

四地区的当前可预期结果：US 因默认值一致而遮蔽问题；EU 和 SG 的英语主语言可能误通过，但时区和浏览器画像按 US 误报；JP 的时区、语言、Locale 与策略都可能按 US 误报；SG 的目标 `en-SG` 还会被 Windows 区域插件自身判为 medium。

## 5. 文档与真实行为漂移

| 风险 | 事实 | 证据 |
|---|---|---|
| P1 | `SPEC.md` 一处称不改其余语言/区域系统项，并把系统时区/Locale 列为暂不实现或 out of scope；代码实际修改系统时区、LocaleName、语言列表和 Culture。SPEC 自身另一处又包含 `tzutil`。 | `SPEC.md:18-19,78-96,243-250`；`src/fix/flow.ts:256-384` |
| P1 | README 同时声称系统时钟会受影响和“不受影响”，又称只操作用户级环境变量。 | `README.md:31,155,212,325,327,402` |
| P1 | README 的 persist 说明只披露 env、时区和浏览器策略；ADR 0003 仍写“系统语言列表暂不改动”。 | `README.md:208-212`；`docs/adr/0003-browser-policies-in-persist.md:3` |
| P2 | README 同时宣称 18 个检测维度和 11 个插件；runner 实际组装 11 个。 | `README.md:26,39,306`；`src/detection/runner.ts:7-17,33-47` |
| P2 | 支持地区正文列 us/eu/jp/sg，表格漏 sg。 | `README.md:47,273-281` |
| P2 | SPEC 示例包含不存在或位置错误的 `persist --region us`、`run --shell`。 | `SPEC.md:142,145`；`src/index.ts:49-56,144-165` |
| P1 | 三态、原子地区、耐久事务、桌面壳和安装器决策只存在于当前未提交的 `CONTEXT.md` 与 ADR 0004–0008，不属于 `main`。 | 当前 `git status`；`docs/adr/0004-*` 至 `0008-*` |

## 6. 测试与门禁基线

已验证：TypeScript 类型检查通过；15 个测试文件、105 个测试全部通过；标准用户与提升权限环境下 `npm run build` 均可通过。一次沙箱内 build 因无权删除 `dist` 出现 EPERM，属于执行环境 ACL，不是已复现的产品构建缺陷。

通过并不代表目标语义已经覆盖：

- flow 测试全部 mock `windows.js`，没有 `src/platform/windows.test.ts`；真实备份写入、schema 迁移、锁、注册表与 PowerShell 编解码均未覆盖。
- 没有 CLI 命令集成、GUI server/API、GUI 浏览器、Windows 桌面壳、安装器、升级/修复/卸载或发布流水线测试。
- 没有 standard/deep/default、跨地区转换、committed target/health、journal/崩溃恢复、读回验证、完整补偿、null/空值精确恢复和幂等重试测试。
- off 测试没有语言列表或 Culture 恢复断言。
- `regions.test.ts:21` 主动固定了 unknown→US；`runner.test.ts:92` 主动固定了 response.region=`auto`；`flow.test.ts:456-511` 把不完整补偿序列当作预期。
- 没有覆盖率阈值、CI 或 GitHub Actions；pre-commit 只运行 typecheck/test，不运行 build、package、文档/版本一致性或安装测试。

## 7. 版本、构建与公开发布漂移

| 风险 | 事实 | 证据 |
|---|---|---|
| P1 | 三个版本源不一致：package 为 0.1.1，CLI 与安装脚本为 0.1.0。 | `package.json:3`；`src/index.ts:20-23`；`scripts/install.ps1:5-8` |
| P1 | npm 最新版仍为 0.1.0；GitHub 只有 v0.1.0 Release，且无发布资产。Release notes 仍写 20 tests。 | npm registry 与 GitHub Release 于 2026-08-10 的公开状态 |
| P1 | 当前 `tsup` 输出是 Node 20 ESM，依赖 `commander`、`chalk` 等外部包；不是带私有 Node 24 runtime 的独立产品包。 | `package.json:6-16,39-48`；`tsup.config.ts:3-16`；`dist/index.js` imports |
| P1 | `src/run/injector.ts` 在 ESM 内使用 `require("node:fs")`，release bundle 仍需修正。 | `src/run/injector.ts:42` |
| P1 | 当前 `scripts/install.ps1` 要求预装 Node 20+，执行全局 npm 安装后创建桌面快捷方式。 | `scripts/install.ps1:12-69`；`README.md:55-63,117-125` |
| P0 | main 没有 Tauri production shell、Inno Setup、私有 runtime、WebView2 策略、稳定 AppId、开始菜单、精确 PATH 维护、升级/修复/卸载流程。 | 仓库文件清单；ADR 0007/0008 目标 |
| P0 | 仓库没有 `.github` 工作流，GitHub Actions workflow/run 均为 0；package scripts 也没有 installer/package/sign/checksum/release pipeline。 | `package.json:9-16`；GitHub API 与仓库文件清单 |
| P1 | 当前 `main` 比公开 v0.1.0 tag 多 29 个提交，但没有与这些变化对应的 Windows asset、checksum 或 Release。 | `main@d6679cb`；`v0.1.0@d63cb24f`；GitHub Release assets=[] |

当前 `npm pack --dry-run` 可成功，包约 83 KB（解包约 331 KB），只包含 README、LICENSE、dist、package 和 prepare hooks，且不捆绑依赖。它只能证明 npm CLI 包结构可发布，不能证明 Windows 产品包可安装或离线运行。

公开事实入口：

- npm：<https://www.npmjs.com/package/cc-fix>
- GitHub v0.1.0 Release：<https://github.com/gongyijie85/cc-fix/releases/tag/v0.1.0>

## 8. 未跟踪材料与工作树

- `.wayfinder/temp` 当前约 372 个文件、58.4 MB，包含截图、JSON、一次性脚本、上游克隆、Playwright harness、`node_modules`、字体和说明文档。
- `.wayfinder/worktrees/desktop-shell-prototype` 是已推送的抛弃式桌面壳原型工作树；外部还有 Windows 工具链研究工作树。
- `.gitignore` 只覆盖 `.wayfinder/temp/check-cc/` 与少量 e2e 模式，没有为大部分临时证据或嵌套 worktree 建立分类规则。
- 这些材料属于用户/Wayfinder 证据，本任务不删除或移动。后续需要明确“保留为正式证据、归档、忽略、清理”的边界，避免误提交和工作树噪音。

## 9. 后续任务必须回答的问题

以下问题不在本基线中替用户作决定，需由后续发布门禁和实施规格任务闭环：

1. 哪些 P1 漂移是进入 Windows 安装包构建前的硬阻断项，哪些可以进入明确标注的预览版？
2. 如何把未提交的 ADR 0004–0008 与 `CONTEXT.md` 作为实现和验收的唯一语义基线，并处理 ADR 0003、SPEC、README 的冲突？
3. 哪些旧测试需要先改为目标契约，才能避免“测试全绿但语义错误”？
4. Windows 测试矩阵如何覆盖 standard/deep、四地区、事务中断恢复、WebView2、安装/升级/修复/卸载与离线运行？
5. 版本、源码提交、安装器、校验和、签名、SBOM、GitHub Release 与 npm 兼容包之间如何建立可追溯的一致性门禁？
6. `.wayfinder/temp` 和原型工作树中哪些材料需要正式归档，哪些应加入忽略规则，哪些可在用户明确授权后清理？

已决事项不再列为待决问题：VPN、路由器和 DNS 相关业务维持“只提醒、不修改”，不进入自动修复范围。

## 10. 基线结论

当前 `main` 的 CLI 构建与现有单元测试是健康的，但它们验证的是旧产品语义。完整 Windows 安装包还没有可发布实现；在进入实现前，应先以 ADR 0004–0008 为准统一领域状态、事务、地区和安装生命周期契约，再建立发布门禁。否则继续在现有 flow 和安装脚本上增量打包，会把已知的恢复、状态和地区漂移固化进公开安装包。
