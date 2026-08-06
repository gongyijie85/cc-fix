# CC-Fix 日常场景覆盖与最终方案

## 一、用户日常使用场景全景

### 场景矩阵

| # | 场景 | 用户做什么 | 涉及的运行环境 | 环境信号来源 |
|---|---|---|---|---|
| 1 | **终端写代码** | PowerShell/CMD 里运行 `claude` | Node.js CLI | 环境变量 > 系统设置 |
| 2 | **IDE 写代码** | Cursor / VS Code / Windsurf 里用 AI | Electron/IDE 进程 | 继承启动环境 |
| 3 | **桌面端对话** | 打开 Claude Desktop 聊天 | Electron 应用 | 继承启动环境 |
| 4 | **Git 操作** | `git commit` / `push` 触发 AI 辅助 | Git 进程 | 继承终端环境 |
| 5 | **npm 脚本** | `npm run` / `pnpm run` 调用 AI | Node.js 进程 | 继承终端环境 |
| 6 | **浏览器** | 打开 claude.ai 使用 | Chrome/Edge | 浏览器 API（不在范围） |
| 7 | **日常办公** | 看时间、写文档、开会 | Windows 原生应用 | 系统设置 |

### 每个场景的环境信号

| 场景 | 时区信号来源 | 语言信号来源 | 进程级注入有效？ | persist 有效？ |
|---|---|---|---|---|
| 1. 终端 CLI | TZ env > 系统时区 | LANG > 系统 Locale | ✅ | ✅ |
| 2. IDE | TZ env > 系统时区 | LANG > 系统 Locale | ⚠️ IDE 已启动 | ✅ |
| 3. Desktop | TZ env > 系统时区 | LANG > 系统 Locale | ⚠️ 需包装启动 | ✅ |
| 4. Git | 继承终端 TZ/LANG | 继承终端 | ✅ | ✅ |
| 5. npm | 继承终端 TZ/LANG | 继承终端 | ✅ | ✅ |
| 6. 浏览器 | 系统时区 + JS API | 浏览器设置 | ❌ | ❌ |
| 7. 日常办公 | 系统时区（注册表） | 系统 Locale | 不影响 | 不影响 |

---

## 二、关键发现

### 环境变量优先级（Node.js / Electron）

```
TZ 环境变量  >  系统时区（注册表）  >  默认系统时区
LANG 环境变量 > 系统 Locale（注册表） > 默认系统 Locale
```

**Node.js 和 Electron 优先读环境变量**，这意味着：
- 设了用户级环境变量后，**所有新启动的开发工具自动继承**
- Windows 原生应用（时钟、Office、Teams）**不读这些环境变量**

### `persist on` 对日常办公的影响

| 日常操作 | 是否受影响 | 原因 |
|---|---|---|
| 看系统时间 | ❌ 不影响 | Windows 时钟读注册表时区，不读 TZ 变量 |
| Outlook/Teams 会议 | ❌ 不影响 | Office 读系统时区设置，不读 TZ 变量 |
| 文件修改时间 | ❌ 不影响 | 文件系统用 UTC，显示用系统时区 |
| 浏览器网页时间 | ❌ 不影响 | 浏览器有自己的时区处理 |
| Git 提交时间 | ⚠️ 微影响 | Git 日志时间会显示为目标时区（但这正是我们想要的） |
| 终端 `date` 命令 | ⚠ 微影响 | 显示为目标时区（开发工具场景，可接受） |
| Windows 设置界面 | ❌ 不影响 | 设置界面读注册表，不读环境变量 |

**结论：`persist on` 对日常办公零影响，可以放心长期保留。**

---

## 三、最终方案：以 persist 为核心

### 策略调整

之前的设计以 `cc-fix run`（进程级注入）为核心，现在调整为：

| 层级 | 定位 | 命令 | 适用场景 |
|---|---|---|---|
| **核心** | 用户级持久化 | `cc-fix persist on` | 覆盖所有日常场景（CLI/IDE/Desktop/Git） |
| **补充** | 进程级注入 | `cc-fix run` | 临时使用 / 不想持久化时 |
| **可选** | 系统级修改 | `cc-fix system on` | 极端场景，默认不推荐 |

### 用户使用流程

```
首次使用：
  1. cc-fix check              ← 看看当前环境风险
  2. cc-fix persist on         ← 一键开启，长期有效
  3. 正常使用 claude / Cursor / Desktop ← 全部自动生效

日常使用：
  - 无需任何操作，环境变量持久生效
  - 日常办公（看时间、开会、写文档）零影响

临时切换（如需要）：
  - cc-fix persist off         ← 关闭持久化，恢复原始环境
  - cc-fix run claude          ← 一次性安全启动

检测代理：
  - cc-fix proxy check         ← 检查出口 IP 是否正常
```

---

## 四、命令设计（最终版）

```
cc-fix check                    # 检测环境风险（显示所有信号 + 评分）
cc-fix check --json             # JSON 输出

cc-fix persist on               # 开启用户级持久化（核心功能）
cc-fix persist off              # 关闭，恢复原始环境变量
cc-fix persist status           # 查看当前持久化状态
cc-fix persist --region us      # 指定目标地区（默认 us）

cc-fix run [command]            # 进程级注入启动（临时使用）
cc-fix run --desktop            # 包装启动 Claude Desktop
cc-fix run --shell              # 启动安全环境 shell
cc-fix run --region eu          # 指定目标地区

cc-fix proxy check              # 检测出口 IP / 代理状态
```

---

## 五、persist on 具体做什么

### 设置的环境变量（用户级，无需管理员）

```powershell
setx LANG "en_US.UTF-8"
setx LC_ALL "en_US.UTF-8"
setx TZ "America/New_York"
```

### 自动备份旧值

```json
// 存储在 %APPDATA%\cc-fix\persist-backup.json
{
  "timestamp": "2026-08-06T12:00:00Z",
  "previous": {
    "LANG": null,           // 原来不存在
    "LC_ALL": null,
    "TZ": null
  }
}
```

### persist off 恢复

```powershell
# 删除新增的环境变量（原来不存在的）
reg delete "HKCU\Environment" /v LANG /f
reg delete "HKCU\Environment" /v LC_ALL /f
reg delete "HKCU\Environment" /v TZ /f
```

---

## 六、check 输出设计

```
$ cc-fix check

╔══════════════════════════════════════════════════╗
║  CC-Fix 环境检测报告                              ║
╠══════════════════════════════════════════════════╣
║  风险评分: 35/100 (中风险 🟡)                      ║
╠══════════════════════════════════════════════════╣

  信号              当前值              状态    权重
  ─────────────────────────────────────────────────
  系统时区          Asia/Shanghai       ❌ 高风险  25
  系统语言          zh-CN               ❌ 高风险  20
  出口 IP 国家      US                  ✅ 正常   25
  Intl Locale       zh-CN               ❌ 高风险  6
  UTC 偏移          +8:00               ❌ 异常   4
  代理配置          https://127.0.0.1   ✅ 已配置  5
  信号一致性        矛盾                ❌ 异常   15

  ─────────────────────────────────────────────────
  建议: 运行 `cc-fix persist on` 一键修复高风险信号
```

---

## 七、场景覆盖验证

| 场景 | persist on 后效果 | 日常影响 |
|---|---|---|
| 终端运行 `claude` | ✅ TZ/LANG 已注入 | 无 |
| Cursor / VS Code | ✅ 继承环境变量 | 无 |
| Claude Desktop | ✅ 继承环境变量 | 无 |
| `git commit` | ✅ 提交时间使用目标时区 | 无（或期望行为） |
| `npm run` | ✅ Node.js 使用目标 locale | 无 |
| 看系统时间 | ❌ 不受影响 | 正常 |
| Outlook 会议 | ❌ 不受影响 | 正常 |
| Windows 设置 | ❌ 不受影响 | 正常 |
| 浏览器 claude.ai | ❌ 不受影响 | 正常（不在范围） |
