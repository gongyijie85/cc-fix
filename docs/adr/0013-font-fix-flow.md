# 字体修复流独立于修复事务，经特权助手执行

中文字体信号是唯一需要**破坏性操作**才能消除的检测项：移除系统字体文件会让中文界面缺字，且写入 C:\Windows\Fonts 与 HKLM 需要提升权限。本 ADR 决定：字体备份/移除/还原构成独立的**字体修复流**，不并入 persist 修复事务；备份落在状态根目录，破坏性操作一律经特权助手以固定形状脚本执行。

## 背景

- 检测插件按文件名模式扫描 C:\Windows\Fonts（msyh/simsun/… 等中文字体）。
- 移除字体不可逆风险高，必须可还原；还原材料（文件 + HKLM Fonts 注册表项）必须与移除同批保存。
- 运行中的 GUI 是非提升进程：删除 Fonts 目录文件与写 HKLM（含 PendingFileRenameOperations）都需要管理员权限；项目已有特权助手概念（CONTEXT 词汇表），但现有 Rust helper 只支持 compare-delete。
- persist 事务的备份快照语义（不可覆盖的日常原值）不适用于字体：字体不是「切换」，而是「移除」，且产品明确不把字体纳入 persist 还原范围。

## 决策

1. **独立字体修复流**：新模块 src/fonts/，唯一事实源 catalog.ts（中文字体文件名模式与白名单校验）；检测插件 detection/plugins/fonts.ts 改为从目录派生。
2. **备份位置**：%APPDATA%\cc-fix\font-backup\<时间戳>\，含字体文件副本、manifest（名称/大小/SHA-256）、HKLM Fonts 注册表导出与还原脚本；备份幂等，已存在则不重复创建。
3. **提权执行**：移除/还原经特权助手——固定形状 PowerShell 脚本（随 bundle 内嵌，运行时写入状态根目录）+ 严格白名单校验（文件名仅允许字母数字点横线，扩展名 ttf/ttc）+ 路径强制锚定 $env:SystemRoot\Fonts + Start-Process -Verb RunAs 触发 UAC 确认；结果经完成标记文件回传（成功/失败/待重启列表）。
4. **占用文件**：无法立即删除的字体登记 PendingFileRenameOperations（HKLM Session Manager）重启后删除；GUI 经 fonts-done 事件展示待重启列表。
5. **GUI 与日志**：端点 GET /api/fonts/status、POST /api/fonts/remove、POST /api/fonts/restore；面板按钮复用 busy 门与 SSE step 事件；操作日志新增 font-remove / font-restore。
6. **还原范围**：字体还原只由字体修复流承担（复制回文件 + 重新导入注册表），persist 一键还原不涉及字体（与既有语义一致）。

## Consequences

- 消除字体信号有了产品内安全路径（备份在前、可还原、UAC 显式确认）。
- 特权面保持最小：固定脚本、白名单、锚定路径，不接受任意命令。
- 字体目录成为检测与修复流的共同事实源，新增模式只改一处。