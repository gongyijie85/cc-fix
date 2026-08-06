# CC-Fix: Claude Code 环境安全检测与修复 CLI 工具

## Problem Statement

使用 Claude Code / Claude Desktop / Cursor 等 AI 开发工具时，用户的运行环境（时区、语言、Locale 等）可能与账号注册地区不一致，触发 Anthropic 的风控系统，导致账号受限或封禁。

目前存在的问题：
- 用户不知道自己的环境哪些信号存在风险
- 没有工具能一键检测并修复这些风险
- 现有的 check-cc 是浏览器端工具，无法覆盖 CLI/桌面端场景
- 修改系统设置（如时区）会影响日常办公（看时间、开会等）
- 用户需要在"安全环境"和"日常使用"之间频繁切换，体验差

## Solution

构建一个 CLI 工具 `cc-fix`，基于 check-cc 开源项目的检测逻辑，适配 Node.js/CLI 场景。核心策略是**用户级环境变量持久化**——只修改用户级环境变量（`TZ`、`LANG`、`LC_ALL`），不修改系统设置。这样：
- 所有 Node.js/Electron 应用（Claude CLI、Cursor、Claude Desktop）自动继承安全环境
- Windows 原生应用（系统时钟、Office、Teams）不受影响，因为它们读注册表而非环境变量
- 用户无需频繁切换，`persist on` 一次设置即可长期生效

## User Stories

### 检测相关
1. As a Claude Code 用户, I want to 检测当前环境的风险信号, so that 我知道哪些设置可能导致封号
2. As a Claude Code 用户, I want to 看到每个信号的风险等级和权重, so that 我能优先处理高风险项
3. As a Claude Code 用户, I want to 看到综合风险评分, so that 我能快速判断整体安全程度
4. As a Claude Code 用户, I want to 检测出口 IP 的国家和 ASN, so that 我知道网络层是否安全
5. As a Claude Code 用户, I want to 检测各信号之间的一致性, so that 我知道环境画像是否矛盾
6. As a Claude Code 用户, I want to 用 JSON 格式输出检测结果, so that 其他工具可以消费检测数据
7. As a Claude Code 用户, I want to 检测 ANTHROPIC_BASE_URL 是否包含敏感域名, so that 我知道代理配置是否安全
8. As a Claude Code 用户, I want to 检测系统字体中是否存在中文字体, so that 我了解字体层面的风险

### 修复相关
9. As a Claude Code 用户, I want to 一键开启环境安全保护, so that 我不需要手动修改多个设置
10. As a Claude Code 用户, I want to 一键恢复原始环境, so that 我可以随时取消修改
11. As a Claude Code 用户, I want to 修复过程自动备份原始设置, so that 修改出错时可以回滚
12. As a Claude Code 用户, I want to 修复不影响日常办公（看时间、开会）, so that 我可以长期保持安全设置
13. As a Claude Code 用户, I want to 指定目标地区（默认美国）, so that 环境信号与我的代理地区一致
14. As a Claude Code 用户, I want to 用进程级注入临时启动 Claude, so that 我不想持久化设置时也能安全使用

### 多场景覆盖
15. As a 终端用户, I want to 在 PowerShell/CMD 中运行 claude 时自动使用安全环境, so that 我不需要每次手动设置
16. As a Cursor/VS Code 用户, I want to IDE 中的 AI 功能自动使用安全环境, so that 我不需要额外配置
17. As a Claude Desktop 用户, I want to Desktop 应用自动使用安全环境, so that 我不需要用包装命令启动
18. As a Git 用户, I want to git commit 时使用安全环境, so that 提交记录不会暴露真实时区

### 代理检测
19. As a Claude Code 用户, I want to 检测出口 IP 是否正常, so that 我知道代理是否生效
20. As a Claude Code 用户, I want to 检测代理环境变量是否配置正确, so that 我知道 HTTP_PROXY/HTTPS_PROXY 是否设置

### 状态查看
21. As a Claude Code 用户, I want to 查看当前持久化状态, so that 我知道哪些环境变量已被修改
22. As a Claude Code 用户, I want to 看到修复建议, so that 我知道下一步该做什么

## Implementation Decisions

### 技术选型
- **语言**: TypeScript（与 check-cc 一致，便于复用）
- **CLI 框架**: commander.js（轻量、社区活跃）
- **终端输出**: chalk（颜色）+ cli-table3（表格）+ ora（loading 动画）
- **打包**: tsup（输出 ESM + CJS）
- **测试**: vitest
- **运行时**: Node.js >= 20

### 架构分层

三层修复策略，按优先级排列：

1. **核心层 — 用户级持久化**（`persist on/off`）
   - 通过 `setx` 设置用户级环境变量：`TZ`、`LANG`、`LC_ALL`
   - 无需管理员权限
   - Windows 原生应用不读这些变量，日常办公零影响
   - 所有 Node.js/Electron 应用自动继承
   - 自动备份旧值，`persist off` 时恢复

2. **补充层 — 进程级注入**（`run`）
   - 启动命令时注入环境变量：`TZ=... LANG=... claude`
   - 仅影响当前进程，关闭即恢复
   - 适合临时使用或不想持久化的场景
   - 支持包装启动 Claude Desktop（`--desktop`）

3. **可选层 — 系统级修改**（暂不实现）
   - 修改系统时区、Locale 等
   - 需要管理员权限，影响日常使用
   - 默认不推荐，仅在用户明确要求时考虑

### 检测模块

18 个检测维度，分三个优先级：

**高优先级（必须检测）**：
- 系统时区（权重 25）— Claude Code 已知主动检测
- 出口 IP 国家（权重 25）— 约 60% 封号原因
- 系统语言（权重 20）— 第二高权重信号
- 信号一致性（权重 15）— 多信号矛盾触发风控

**中优先级（建议检测）**：
- UTC 偏移量、Node.js Intl Locale、代理配置、DNS 配置、IP ASN、BASE_URL 域名、Windows 系统区域格式、系统字体

**低优先级（可选）**：
- 主机名/用户名、厂商字体、制造商信息、键盘布局、Node.js 版本、环境变量完整性

### 评分模型

总分 100，各维度加权求和：
- 0-20: 低风险（绿色）
- 21-50: 中风险（黄色）
- 51-70: 高风险（橙色）
- 71-100: 极高风险（红色）

### 命令设计

```
cc-fix check                    # 检测环境风险
cc-fix check --json             # JSON 输出
cc-fix persist on               # 开启用户级持久化
cc-fix persist off              # 关闭，恢复原始环境
cc-fix persist status           # 查看持久化状态
cc-fix persist --region us      # 指定目标地区
cc-fix run [command]            # 进程级注入启动
cc-fix run --desktop            # 包装启动 Claude Desktop
cc-fix run --shell              # 启动安全环境 shell
cc-fix run --region eu          # 指定目标地区
cc-fix proxy check              # 检测出口 IP / 代理
```

### 代码复用策略

从 check-cc 复用：
- **直接复用**（~40%）：types.ts、scoring.ts、config/*、regions/index.ts、部分插件
- **适配后复用**（~35%）：client-engine.ts（浏览器 → Node.js）、插件数据源替换
- **不可复用**（~25%）：React/Next.js UI 组件、页面、样式
- **全新开发**：修复功能、终端 UI、持久化管理、代理检测

### 数据流

```
check 命令:
  采集系统信息 → 运行检测插件（并行） → 加权评分 → 终端输出

persist on 命令:
  备份旧值 → setx 设置环境变量 → 验证生效 → 输出结果

run 命令:
  构造环境变量 → 包装目标命令启动 → 继承环境运行
```

### 备份与回滚

- 备份存储在 `%APPDATA%\cc-fix\persist-backup.json`
- 记录每个环境变量的原始值（不存在记为 null）
- `persist off` 时根据备份恢复：有值则恢复，null 则删除

### 平台支持

- **Phase 1**: Windows（用户当前环境）
- **Phase 2**: macOS（Claude Code 主流平台）
- **Phase 3**: Linux（服务器场景）

通过 PlatformAdapter 接口抽象平台差异。

### 项目结构

```
cc-fix/
├── src/
│   ├── index.ts              # CLI 入口
│   ├── detection/            # 检测模块（复用 check-cc）
│   │   ├── types.ts
│   │   ├── scoring.ts
│   │   ├── runner.ts
│   │   ├── config/
│   │   ├── regions/
│   │   └── plugins/
│   ├── persist/              # 持久化管理（备份/恢复）
│   ├── run/                  # 进程级注入启动
│   ├── proxy/                # 代理检测
│   ├── platform/             # 平台抽象层
│   │   ├── adapter.ts
│   │   └── windows.ts
│   └── output/               # 终端输出（表格/JSON）
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Testing Decisions

### 测试策略
- 只测试外部行为，不测试实现细节
- 优先测试高风险逻辑（评分计算、备份/恢复、环境变量操作）

### 测试模块
1. **评分引擎**：输入信号 → 输出评分和风险等级（纯函数，易测试）
2. **检测插件**：mock 系统信息 → 验证检测结果
3. **持久化管理**：mock 注册表操作 → 验证备份/恢复逻辑
4. **进程级注入**：验证环境变量构造是否正确
5. **CLI 集成**：端到端测试命令执行和输出

### 测试工具
- vitest（单元测试）
- 集成测试通过 mock child_process 验证命令调用

## Out of Scope

- **浏览器场景**：claude.ai 的浏览器指纹检测不在本工具范围
- **系统级修改**：修改系统时区、Locale 等影响日常使用的操作
- **IP/代理切换**：工具检测代理状态，但不负责切换代理节点
- **字体修改**：CLI 场景下字体不会被检测，不需要修改
- **自动更新**：不提供自动更新机制
- **GUI 界面**：纯 CLI 工具，不做桌面 GUI
- **macOS/Linux 实现**：Phase 1 仅支持 Windows，但预留 PlatformAdapter 接口

## Further Notes

### 依赖清单
```json
{
  "dependencies": {
    "commander": "^12",
    "chalk": "^5",
    "cli-table3": "^0.6",
    "ora": "^8"
  },
  "devDependencies": {
    "typescript": "^5",
    "tsup": "^8",
    "vitest": "^2",
    "@types/node": "^20"
  }
}
```

### 关键风险
1. **Claude Code 可能直接读注册表时区**：如果 Claude Code 不走标准 API 而是直接读 Windows 注册表时区，环境变量注入会失效。需要在实施时验证。
2. **Anthropic 检测策略变化**：Anthropic 可能增加新的检测维度或改变现有策略，工具需要可扩展。
3. **环境变量对某些应用不生效**：部分应用可能硬编码了地区信息，环境变量无法覆盖。

### 参考资料
- check-cc 开源项目：https://github.com/yacuo/check-cc
- check-cc 在线检测：https://checkcc.org
- Claude Code 环境检测逆向分析（社区）
