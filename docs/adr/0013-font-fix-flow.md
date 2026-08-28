# 字体修复流独立于修复事务，经特权助手执行

中文字体信号是唯一需要**破坏性操作**才能消除的检测项：移除系统字体文件会让中文界面缺字，且写入 C:\Windows\Fonts 与 HKLM 需要提升权限。本 ADR 决定：字体备份/移除/还原构成独立的**字体修复流**，不并入 persist 修复事务；备份落在状态根目录，破坏性操作一律经特权助手以固定形状脚本执行。

## 背景

- 检测插件按文件名模式扫描 C:\Windows\Fonts（msyh/simsun/… 等中文字体）。
- 移除字体不可逆风险高，必须可还原；还原材料（文件 + HKLM Fonts 注册表项）必须与移除同批保存。
- 运行中的 GUI 是非提升进程：删除 Fonts 目录文件与写 HKLM（含 PendingFileRenameOperations）都需要管理员权限；项目已有特权助手概念（CONTEXT 词汇表），但现有 Rust helper 只支持 compare-delete。
- persist 事务的备份快照语义（不可覆盖的日常原值）不适用于字体：字体不是「切换」，而是「移除」，且产品明确不把字体纳入 persist 还原范围。

## 决策

1. **独立字体修复流**：新模块 src/fonts/，唯一事实源 catalog.ts（中文字体文件名模式与白名单校验）；检测插件 detection/plugins/fonts.ts 改为从目录派生。自 2026-08-26 起，系统字体存在仅作为信息展示，权重保留用于 schema 兼容但 score/contribution 恒为 0、risk 为 low。
2. **备份位置**：%APPDATA%\cc-fix\font-backup\<时间戳>\，含字体文件副本、manifest（名称/大小/SHA-256）与 HKLM Fonts 注册表材料；用户显式备份保持幂等，但每次真正移除前必须创建当前字体版本的新备份。任一字体文件或注册表材料读取失败即删除半成品并阻止移除。
3. **提权执行（issue #49 安全强化）**：脚本与参数经 `-EncodedCommand`（base64 UTF-16LE）编入命令行快照——磁盘上**不存在**可被同用户恶意软件替换的 font-helper.ps1 / font-helper-args.json。提权链：非提权 powershell（-Command 携带启动语句，当前约 21KB，低于 CreateProcess 32K 上限并由测试门禁限制在 28KB 内）→ `Start-Process -Verb RunAs` → 提权 powershell（-EncodedCommand 携带完整脚本）。签名方案取舍：Authenticode 对个人开发者无现实渠道（CA 基本停发个人 OV、EV 需组织主体），且"释放签名脚本再执行"仍存在释放-执行篡改窗口；零落盘方案窗口更小且零外部依赖。
4. **提权端纵深防御**：备份目录与注册表 JSON 必须 `GetFullPath` 后锚定 `font-backup` 子树（拒绝 `..` 与前缀碰撞）；备份内容拒绝 reparse point（符号链接逃逸）；删除名单来自刚完成备份的 manifest 并内嵌于只读命令行快照，提权端重新枚举 catalog 命中项且要求两份清单精确相等，避免备份与删除之间的目录竞态；注册表还原弃 `reg.exe import`（任意 HKLM 写入），改为白名单 JSON 逐值 `New-ItemProperty` 写回固定键（值名/数据形状校验，数据含路径时前缀必须为 Fonts 目录）。
5. **注册表材料格式**：备份时非提权读 HKLM Fonts 键，过滤中文字体相关项存 `fonts-hklm.json`（version 1，entries 键值表）；旧版 `reg.exe export` 备份在还原时自动转换（Node 端解析 REGEDIT5，同样过滤）。
6. **结果标记防伪造**：marker 写入随机文件名（`font-helper-result-<uuid>.json`），内容携带一次性 256 位 nonce；Node 端校验 nonce 匹配，伪造 marker 被忽略；pendingReboot 逐项过文件名白名单、error 截断 500 字符，防止内容注入 GUI。
7. **占用文件与完成验证**：无法立即删除的字体登记 PendingFileRenameOperations（HKLM Session Manager）重启后删除；提权端先读取现有队列，只把本次实际新增的精确删除对写入 `scheduledDeleteNames`，还原时仅撤销 marker 中这些自有条目，保留预先存在及其他软件的重启操作。复制与注册表写回后调用 GDI 字体资源函数并广播 `WM_FONTCHANGE`，Node 端再按 manifest SHA-256/大小及注册表逐项读回验证，验证成功后才清空 marker。
8. **GUI 与日志（2026-08-26 安全暂停）**：保留 GET /api/fonts/status 与 POST /api/fonts/restore；POST /api/fonts/remove 固定返回 410，GUI 移除破坏性按钮，仅保留已有备份的还原入口。在系统内置字体与风险语义重新设计、客户端矩阵通过前，不重新开放移除入口。
9. **还原范围**：字体还原只由字体修复流承担（复制回文件 + 白名单写回注册表），persist 一键还原不涉及字体（与既有语义一致）。

## Consequences

- 现阶段字体信号仅用于检测和解释；产品默认路径不再提供系统字体移除。已有备份仍可在 UAC 确认后还原。
- 特权面保持最小：固定脚本、白名单、锚定路径，不接受任意命令。
- issue #49 强化后：UAC 提权代理攻击面关闭——脚本/参数零落盘（无替换窗口）、注册表写回被白名单约束在 Fonts 键合法形状内、结果标记不可盲目伪造；同用户恶意软件要突破必须具备运行时读取他进程命令行/内存的能力（该能力下直接注入主进程更省事，超出本威胁模型）。
- 代价：UAC 弹窗仍显示 powershell.exe（无自有签名 exe 时无法改善）；marker 的 nonce 对能读提权进程命令行的攻击者不保密——属可接受残余风险（伪造 marker 的收益仅为骗取"成功"提示）。
- 字体目录成为检测与修复流的共同事实源，新增模式只改一处。
