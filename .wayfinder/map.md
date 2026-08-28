# Wayfinder Map: CC-Fix 性能收尾（GUI/SSE · 桌面壳启动链 · npm 安装体积）✅ 已完成（2026-08-28）

> 全部 9 个 ticket 已关闭（#81-#89）。三雾项毕业：npm -33%、GUI 首事件 -99.4%、Tauri 启动链判定无瓶颈。
> 会话末基线：typecheck 0 错、77 文件 / 746 用例、E2E 13 过。

## Destination

将 #65 地图未毕业的三个性能雾项毕业为**可测量、可决策**的优化路径：① GUI 渲染与 SSE 推送效率；② Tauri 桌面壳启动链耗时分布；③ npm 发布包安装体积构成。目标产物：每个雾项的实测数据 + 明确的优化决策/方案（不直接实施）。

## Notes

- 领域：CC-Fix Windows 环境检测与修复工具性能收尾（TypeScript + Tauri/Rust）。
- 每会话先读 CONTEXT.md、CLAUDE.md 与相关 ADR；技能：perf-profile。
- 三个雾项均以 research 起步：先测量、再决策；不改变产品行为与公开契约。
- 延续 #65 的边界：不做网络配置修改、macOS/Linux 支持、自动更新、Electron 重写。

## Decisions so far

- [测量 Tauri 桌面壳启动链耗时分布](https://github.com/gongyijie85/cc-fix/issues/83#issuecomment-5442817015) — sidecar ready ~110.5ms（Node 启动 68ms 固有 + loopback bind 42ms）；bundle 导入近免费；无 sleep/port-probe；**判定无代码级瓶颈、不开优化票**；WebView2 级需真桌面验证。
- [测量 npm 发布包安装体积构成与可优化空间](https://github.com/gongyijie85/cc-fix/issues/81#issuecomment-5442827331) — tarball 594.5KB；sourcemap 51.7%（815,991B）为最大削减杠杆（-33%→398.5KB 实测）；字体必需（npm GUI 渠道运行时使用）；files 不支持子路径排除 → 决策移交 #84。
- [确定 npm 发布 sourcemap 策略](https://github.com/gongyijie85/cc-fix/issues/84#issuecomment-5448331596) — 用户确认发布期剥离：构建期保留 sourcemap（本地调试），prepack 钩子删 dist/*.map（pnpm pack 与 npm publish 同受益）。实施：#85。
- [实施 npm 发布 sourcemap 剥离（prepack 钩子）](https://github.com/gongyijie85/cc-fix/issues/85#issuecomment-5448391285) — prune-dist-maps.mjs + prepack 钩子；tarball 580.6→389.6 KiB（-33%）；verify-npm OK；构建期 maps 保留（build 恢复 796.9KB）；740 用例全过。
- [测量 GUI 渲染与 SSE 推送性能瓶颈](https://github.com/gongyijie85/cc-fix/issues/82#issuecomment-5448407700) — 首屏 40ms FCP（字体本地 4ms 非瓶颈）；SSE 首事件 344ms（fetchIpIntelligence 阻塞广播）；首启 status 223ms（运行时懒初始化）；detect-done 整树重渲染+冗余 refetch。毕业决策票 #86/#87。
- [确定 GUI 检测启动时序优化（IP 情报与 202 广播）](https://github.com/gongyijie85/cc-fix/issues/86#issuecomment-5448427782) — 确认 1/1：提前广播+启动预取；TTL 60s 会话缓存、失败不缓存。实施 #88。
- [实施 GUI 检测启动时序优化（提前广播 + IP 情报 TTL 缓存预取）](https://github.com/gongyijie85/cc-fix/issues/88#issuecomment-5448682597) — fetchIpIntelligence TTL 60s + in-flight 去重；attachSse 预取 + 早期 phase 广播（冒烟：phase 344ms→2ms）；746 用例全过。
- [确定 GUI 首启初始化与渲染收敛方案](https://github.com/gongyijie85/cc-fix/issues/87#issuecomment-5448692547) — 确认 1/1/1：server ready 后后台预热运行时；detect-done 局部补丁 + regions/status/history 去重 + 保留 regionSelect；与 #64 视觉门禁先行瘦身增量。实施 #89。
- [实施 GUI 首启预热与 detect-done 渲染收敛](https://github.com/gongyijie85/cc-fix/issues/89#issuecomment-5448819133) — server ready 后台预热运行时（#44 语义保持）；detect-done 局部补丁 + regions 会话缓存 + 保留 regionSelect；补强：fix 后复测刷新 status（fix-synced 清位）；746 单测 + 13 E2E 全过。

## Not yet specified

（三个雾项均已毕业为子票：npm 体积 #81、GUI/SSE #82、Tauri 启动链 #83；新雾随研究结果浮现）

## Out of scope

- 修改 VPN/路由/网卡/DNS/hosts/DoH 配置。
- macOS / Linux 平台支持。
- 自动更新机制。
- 重写为 Electron 或其他框架。
- 新增产品功能或检测维度。
