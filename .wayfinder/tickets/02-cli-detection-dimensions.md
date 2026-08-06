# Ticket: CLI 检测维度设计

**类型**: `wayfinder:research` (AFK)
**状态**: Open / Unclaimed
**阻塞**: 无 (依赖 01 的结论，但可并行调研)

## Question

Claude Code 运行在终端/Node.js 环境中，check-cc 的 40+ 浏览器检测维度需要映射到系统级等价物。哪些维度对 Claude Code 场景有意义？

需要调研的维度映射：

| 浏览器端 (check-cc) | CLI/系统端 (cc-fix) |
|---|---|
| browser language | 系统语言 / LANG 环境变量 |
| Intl.Locale | Node.js locale / ICU 数据 |
| system timezone | 系统时区设置 |
| User-Agent | 不适用（CLI 无 UA） |
| 运行容器检测 | 不适用 / 改为检测 VM/沙箱 |
| IP 地区 | 出口 IP 地区（需要网络请求） |
| 浏览器字体 | 系统字体列表 |
| 屏幕分辨率 | 不适用 |

**关键问题**：
1. Claude Code 本身发送什么环境信息给 Anthropic？（API headers、telemetry）
2. Anthropic 服务端能看到哪些信号？（IP、时区、语言、OS）
3. 哪些信号不一致会导致封号？

**输出**：CLI 版检测维度清单 + 每个维度的检测方法和修复方式
