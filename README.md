<div align="center">

# 🛡️ cc-fix

**Claude Code 环境安全检测与一键修复 CLI 工具**

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/cc-fix.svg)](https://www.npmjs.com/package/cc-fix)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6.svg)](https://www.typescriptlang.org/)

[中文](#中文) | [English](#english)

</div>

---

<a id="中文"></a>

## 📖 项目简介

使用 **Claude Code / Claude Desktop / Cursor** 等 AI 开发工具时，你的运行环境（时区、语言、Locale、出口 IP 等）可能与账号注册地区不一致，**触发 Anthropic 风控系统，导致账号被限制或封禁**。

`cc-fix` 是一个命令行工具，帮你：

- 🔍 **一键检测** 18 个维度的环境风险信号
- 📊 **量化评分** 直观展示综合风险等级
- 🔧 **一键修复** 通过用户级环境变量持久化，零影响日常使用
- 🔄 **安全回滚** 自动备份原始设置，随时恢复

> **核心原理**：只修改用户级环境变量（`TZ`、`LANG`、`LC_ALL`），Windows 原生应用（系统时钟、Office、Teams）读注册表，不受影响；而 Node.js / Electron 应用（Claude CLI、Cursor、Claude Desktop）自动继承安全环境。

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🌍 环境检测 | 时区、系统语言、UTC 偏移、Node Locale、DNS、字体等 18 个维度 |
| 🌐 IP 检测 | 出口 IP 国家、ASN、代理环境变量检查 |
| 📈 风险评分 | 加权评分模型，0-100 分直观展示风险等级 |
| 🔐 一键持久化 | `persist on` 设置用户级环境变量，新终端自动生效 |
| ↩️ 安全回滚 | `persist off` 自动恢复备份的原始设置 |
| 🚀 进程注入 | `run claude` 临时注入安全环境，关闭即恢复 |
| 🖥️ Desktop 支持 | `run --desktop` 包装启动 Claude Desktop |
| 🎯 多地区 | 支持指定目标地区（默认美国，可扩展） |
| 📦 JSON 输出 | `check --json` 供其他工具消费 |

---

## 🚀 快速开始

### 安装

```bash
# 使用 npm
npm install -g cc-fix

# 使用 pnpm
pnpm add -g cc-fix
```

### 三步走

```bash
# 第一步：检测当前环境风险
cc-fix check

# 第二步：一键开启安全环境（用户级持久化）
cc-fix persist on

# 第三步：正常使用 Claude Code，环境已自动安全
claude
```

### 不想持久化？用进程级注入

```bash
# 临时以安全环境启动 Claude Code
cc-fix run claude

# 临时启动 Claude Desktop
cc-fix run --desktop
```

---

## 🐣 小白快速上手（零基础教程）

> 完全不懂命令行？别担心，跟着做就行。

### 方式一：双击运行（最简单）

1. 下载项目：点击 GitHub 页面绿色 **Code** 按钮 → **Download ZIP**
2. 解压后进入 `cc-fix` 文件夹
3. 双击 `scripts\cc-fix.bat` 文件
4. 看到菜单后，输入数字选择功能，回车确认

```
  ========================================
    cc-fix - Claude Code 环境安全工具
  ========================================

    1. 检测环境风险
    2. 一键修复环境（安全模式）
    3. 恢复原始环境（日常模式）
    4. 查看持久化状态
    5. 检测出口 IP / 代理
    6. 安全模式启动 Claude Code
    7. 安全模式启动 Claude Desktop
    0. 退出
```

> 💡 前提：电脑已安装 [Node.js](https://nodejs.org)（选 LTS 版本，一路下一步即可）

### 方式二：PowerShell 一键安装

打开 **PowerShell**（按 Win 键，搜索 `PowerShell`），粘贴以下命令：

```powershell
npm install -g cc-fix
```

安装完成后，随时运行：

```powershell
cc-fix check          # 看看你的环境安不安全
cc-fix persist on     # 一键修复
```

### 方式三：不安装直接运行

```powershell
npx cc-fix check
```

> `npx` 会自动下载并运行，用完即走，不占空间。

### 日常使用流程

```
┌─────────────────────────────────────────────────┐
│  第一次使用                                      │
│                                                  │
│  ① cc-fix check        → 看看风险评分            │
│  ② cc-fix persist on   → 一键修复               │
│  ③ 正常用 Claude Code  → 环境已安全              │
│                                                  │
│  日常使用                                        │
│                                                  │
│  • persist on 后不用管，新终端自动生效            │
│  • 系统时钟、Office、Teams 不受影响              │
│  • 想恢复？ cc-fix persist off 即可              │
│                                                  │
│  临时使用（不想持久化）                          │
│                                                  │
│  • cc-fix run claude   → 安全环境临时启动        │
│  • 关闭后自动恢复，不留痕迹                      │
└─────────────────────────────────────────────────┘
```

---

## 📋 命令参考

### `cc-fix check`

检测当前环境的所有风险信号。

```bash
cc-fix check              # 终端彩色表格输出
cc-fix check --json       # JSON 格式，供其他工具消费
cc-fix check --region us  # 指定目标地区（默认 us）
```

输出示例：

```
┌─────────────────────────────────────────────────────────┐
│  cc-fix 环境风险检测报告                                │
├──────────────────┬──────────┬────────┬──────────────────┤
│ 检测项           │ 当前值   │ 风险   │ 权重             │
├──────────────────┼──────────┼────────┼──────────────────┤
│ 系统时区         │ Asia/... │ 🔴 高  │ 25               │
│ 出口 IP 国家     │ US       │ 🟢 低  │ 25               │
│ 系统语言         │ en-US    │ 🟢 低  │ 20               │
│ ...              │ ...      │ ...    │ ...              │
├──────────────────┴──────────┴────────┴──────────────────┤
│ 综合风险评分：23 / 100（中风险）                         │
└─────────────────────────────────────────────────────────┘
```

### `cc-fix persist`

管理用户级环境变量持久化。

```bash
cc-fix persist on              # 开启持久化（默认目标地区 us）
cc-fix persist on --region us  # 指定目标地区
cc-fix persist off             # 关闭持久化，恢复原始设置
cc-fix persist status          # 查看当前持久化状态
```

**工作原理：**
- `persist on`：通过 Windows `setx` 命令设置用户级环境变量 `TZ`、`LANG`、`LC_ALL`
- 自动备份原始值到 `%APPDATA%\cc-fix\persist-backup.json`
- `persist off`：根据备份恢复，无需手动操作

### `cc-fix run`

以安全环境启动任意命令（进程级注入）。

```bash
cc-fix run claude              # 安全环境启动 Claude Code
cc-fix run --desktop           # 安全环境启动 Claude Desktop
cc-fix run --region eu node    # 指定目标地区
```

### `cc-fix proxy check`

检测出口 IP 和代理状态。

```bash
cc-fix proxy check
```

输出：

```
出口 IP 信息:
  IP: 1.2.3.4
  国家: US
  地区: California
  城市: Los Angeles
  ASN: AS13335
  组织: Cloudflare
  时区: America/Los_Angeles

✅ 出口 IP 地区正常
```

---

## 🎯 支持地区

| 代码 | 地区 | 时区 | 语言 |
|------|------|------|------|
| `us` | 美国（默认） | America/New_York | en-US |
| `eu` | 欧洲 | Europe/London | en-GB |
| `jp` | 日本 | Asia/Tokyo | ja-JP |

> 可通过 `--region` 参数指定，更多地区持续添加中。

---

## 🛡️ 风险评分模型

| 分数区间 | 风险等级 | 建议 |
|---------|---------|------|
| 0 – 20 | 🟢 低风险 | 可正常使用 |
| 21 – 50 | 🟡 中风险 | 建议运行 `persist on` |
| 51 – 70 | 🟠 高风险 | 强烈建议修复环境 |
| 71 – 100 | 🔴 极高风险 | 立即修复，账号可能已被标记 |

**高权重检测项（共 85 分）：**
- 系统时区（25 分）— Claude Code 已知主动检测
- 出口 IP 国家（25 分）— 约 60% 封号原因
- 系统语言（20 分）— 第二高权重信号
- 信号一致性（15 分）— 多信号矛盾触发风控

---

## 🔧 技术架构

```
cc-fix
├── detection/     检测模块（18 个插件，加权评分）
├── platform/      平台抽象层（Windows setx / 备份恢复）
├── proxy/         出口 IP 检测（ipinfo.io）
├── run/           进程级环境变量注入
└── output/        终端渲染（chalk + cli-table3 + ora）
```

**技术栈：**
- TypeScript 5.6 + Node.js 20+
- commander.js（CLI 框架）
- tsup（打包）
- vitest（测试）

---

## 📌 注意事项

> ⚠️ **重要提示**

1. **本工具不修改系统设置**，只操作用户级环境变量，无需管理员权限
2. **本工具不提供代理**，只检测出口 IP 状态，代理需自行配置
3. **Windows 原生应用不受影响**（系统时钟、Office、Teams 读注册表，不读环境变量）
4. **Claude Code 可能直接读注册表时区**，如遇此情况，`persist on` 可能不完全生效，请关注项目更新
5. **Anthropic 风控策略可能变化**，本工具持续跟进更新检测规则

---

## 🙏 来源声明

本项目的检测逻辑参考并改编自以下开源项目：

- **[check-cc](https://github.com/yacuo/check-cc)** — 浏览器端 Claude Code 环境风险检测工具（[checkcc.org](https://checkcc.org)）
  - 复用了其检测维度设计、评分模型、地区配置等核心逻辑
  - 感谢 check-cc 作者的逆向分析工作和开源贡献

- **Claude Code 社区** — 环境检测逆向分析的社区贡献者们

本项目是 check-cc 的 **CLI 扩展实现**，将浏览器端检测能力延伸到命令行场景，并新增了环境修复、持久化管理、进程注入等实用功能。

---

## 🤝 参与贡献

欢迎提交 Issue 和 Pull Request！

```bash
# 开发模式
git clone https://github.com/gongyijie85/bookrank.git
cd bookrank
pnpm install
pnpm dev    # watch 模式，修改自动编译

# 运行测试
pnpm test

# 类型检查
pnpm typecheck
```

---

## 📄 开源协议

本项目基于 [MIT License](./LICENSE) 开源。

---

<a id="english"></a>

## English

### What is cc-fix?

`cc-fix` is a CLI tool that detects and fixes environment risk signals that may trigger Anthropic's risk control system when using Claude Code, Claude Desktop, or Cursor.

### Quick Start

```bash
npm install -g cc-fix

# Detect environment risks
cc-fix check

# Fix environment (user-level env vars, no admin required)
cc-fix persist on

# Or run Claude with temporary safe environment
cc-fix run claude
```

### How It Works

The tool sets user-level environment variables (`TZ`, `LANG`, `LC_ALL`) via Windows `setx`. This approach:
- ✅ Makes Node.js/Electron apps (Claude CLI, Cursor, Claude Desktop) inherit the safe environment
- ✅ Does NOT affect Windows native apps (system clock, Office, Teams) — they read the registry, not env vars
- ✅ Requires no administrator privileges
- ✅ Automatically backs up original values for easy rollback

### Credits

Detection logic adapted from [check-cc](https://github.com/yacuo/check-cc) by yacuo. This project extends check-cc's browser-based detection into a full CLI tool with environment repair, persistence management, and process-level injection capabilities.

---

<div align="center">

**如果这个项目帮到了你，欢迎给个 ⭐ Star 支持一下！**

</div>
