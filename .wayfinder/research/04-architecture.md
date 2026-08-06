# CC-Fix CLI 架构方案

## 技术选型

| 项 | 决策 |
|---|---|
| 项目结构 | 单包（TypeScript + commander.js） |
| CLI 框架 | commander.js |
| 终端输出 | chalk（颜色）+ cli-table3（表格）+ ora（loading） |
| 打包 | tsup（输出 ESM + CJS） |
| 目标地区 | 默认 en-US / America/New_York，`--region` 可切换 |
| 交互模式 | 批处理 + `--json` 输出，`--interactive` 预留 |

## 命令设计

```
cc-fix check              # 检测环境风险（默认命令）
cc-fix check --json       # JSON 格式输出
cc-fix fix                # 自动修复（先备份再修复）
cc-fix fix --dry-run      # 预览修复内容，不实际修改
cc-fix rollback           # 回滚到最近一次备份
cc-fix rollback <file>    # 回滚到指定备份
```

## 项目结构

```
cc-fix/
├── src/
│   ├── index.ts              # CLI 入口（commander 定义命令）
│   ├── detection/
│   │   ├── types.ts          # 类型定义（复用 check-cc）
│   │   ├── scoring.ts        # 评分引擎（复用 check-cc）
│   │   ├── runner.ts         # 检测运行器（适配 Node.js）
│   │   ├── config/           # 检测配置（复用 check-cc）
│   │   ├── regions/          # 地区画像（复用 check-cc）
│   │   └── plugins/          # 检测插件（适配 Node.js 数据源）
│   │       ├── timezone.ts
│   │       ├── language.ts
│   │       ├── locale.ts
│   │       ├── ip-geo.ts
│   │       ├── consistency.ts
│   │       ├── proxy-env.ts
│   │       ├── dns-config.ts
│   │       ├── base-url.ts
│   │       └── fonts.ts
│   ├── fixers/
│   │   ├── index.ts          # 修复编排器（备份→修复→验证）
│   │   ├── timezone.ts       # 时区修复
│   │   ├── env-vars.ts       # 环境变量修复（LANG/LC_ALL/TZ）
│   │   ├── locale.ts         # Locale 修复
│   │   └── proxy.ts          # 代理配置修复
│   ├── platform/
│   │   ├── adapter.ts        # PlatformAdapter 接口
│   │   ├── windows.ts        # Windows 实现
│   │   ├── macos.ts          # macOS 实现（预留）
│   │   └── linux.ts          # Linux 实现（预留）
│   ├── backup/
│   │   └── index.ts          # 备份/回滚管理
│   └── output/
│       ├── text.ts           # 终端表格/彩色输出
│       └── json.ts           # JSON 输出
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

## 检测流程

```
cc-fix check
  ├─ 1. 采集系统信息（os/env/Intl）
  ├─ 2. 运行检测插件（并行）
  ├─ 3. 加权评分 → 风险等级
  └─ 4. 输出结果（表格/JSON）
```

## 修复流程

```
cc-fix fix
  ├─ 1. 先运行 check 确认问题
  ├─ 2. 创建备份（时区/环境变量/locale/代理）
  ├─ 3. 分级执行修复
  │    ├─ 用户级修复（无需管理员）：环境变量、locale
  │    └─ 管理员修复（需提示）：时区、系统代理
  └─ 4. 验证修复结果 + 提示重启终端
```

## 依赖清单

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

## 评分模型

| 维度 | 权重 | 说明 |
|---|---|---|
| 系统时区 | 25 | Claude Code 已知主动检测 |
| 出口 IP 国家 | 25 | 60% 封号原因 |
| 系统语言 | 20 | 第二高权重信号 |
| 信号一致性 | 15 | 多信号矛盾触发风控 |
| 中优先级维度 | 15 | UTC偏移/locale/代理/DNS/字体等 |
| **总分** | **100** | |

风险等级：0-20 低（绿）/ 21-50 中（黄）/ 51-70 高（橙）/ 71-100 极高（红）
