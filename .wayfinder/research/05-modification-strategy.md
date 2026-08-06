# CC-Fix 修改点清单与切换策略

## 一、所有修改点总览

按**影响范围**分三层：

### 第 1 层：进程级（仅影响 Claude Code 进程，关闭即恢复）

| # | 修改点 | 修改内容 | 对日常使用影响 | 风险权重 |
|---|---|---|---|---|
| P1 | TZ 环境变量 | `TZ="America/New_York"` | **零影响** — 仅当前进程 | 25 |
| P2 | LANG 环境变量 | `LANG="en_US.UTF-8"` | **零影响** — 仅当前进程 | 20 |
| P3 | LC_ALL 环境变量 | `LC_ALL="en_US.UTF-8"` | **零影响** — 仅当前进程 | 10 |
| P4 | Node.js Intl Locale | 继承自 LANG/LC_ALL | **零影响** — 仅当前进程 | 6 |

### 第 2 层：用户级持久化（新终端生效，不影响大多数 Windows 应用）

| # | 修改点 | 修改内容 | 对日常使用影响 | 风险权重 |
|---|---|---|---|---|
| U1 | 用户环境变量 LANG | `setx LANG "en_US.UTF-8"` | **几乎无影响** — Windows 原生应用不读此变量，仅影响 WSL/Git/Node 等开发工具 | 10 |
| U2 | 用户环境变量 LC_ALL | `setx LC_ALL "en_US.UTF-8"` | **几乎无影响** — 同上 | 5 |
| U3 | 用户环境变量 TZ | `setx TZ "America/New_York"` | **几乎无影响** — Windows 系统时钟不读 TZ 变量 | 5 |
| U4 | HTTP_PROXY/HTTPS_PROXY | 代理配置 | **可能影响** — 所有开发工具走代理 | 10 |

### 第 3 层：系统级（影响全局，日常使用会受影响）

| # | 修改点 | 修改内容 | 对日常使用影响 | 风险权重 |
|---|---|---|---|---|
| S1 | 系统时区 | `tzutil /s "Eastern Standard Time"` | **严重影响** — 系统时钟变化，所有应用时间显示改变 | 25 |
| S2 | 系统 Locale | `Set-WinSystemLocale` | **严重影响** — 需重启，影响所有应用的语言显示 | 10 |
| S3 | 系统代理 | 注册表 Internet Settings | **中等影响** — 浏览器等应用走系统代理 | 10 |
| S4 | Hosts 文件 | 编辑 hosts | **高风险** — 可能影响网站访问 | 5 |

---

## 二、切换策略设计

### 核心原则

1. **进程级注入是主力** — 覆盖最高权重信号，零日常影响
2. **用户级持久化可选** — 对开发工具一致性好，日常几乎无感
3. **系统级修改默认关闭** — 仅在用户明确要求时执行

### 命令设计

```
cc-fix check                    # 检测当前环境状态
cc-fix run                      # 进程级注入，启动安全 Claude Code
cc-fix run --shell              # 进程级注入，启动安全 shell
cc-fix persist on               # 开启用户级持久化（setx 环境变量）
cc-fix persist off              # 关闭用户级持久化（恢复原始值）
cc-fix persist status           # 查看持久化状态
cc-fix system on                # 系统级修改（需管理员，明确警告）
cc-fix system off               # 回滚系统级修改
cc-fix proxy check              # 检测出口 IP / 代理状态
```

---

## 三、各层详细方案

### 方案 A：进程级注入（默认，推荐）

**原理**：启动 Claude Code 时，注入环境变量覆盖系统设置

```bash
# 等价于：
cc-fix run claude
# ↓
TZ="America/New_York" \
LANG="en_US.UTF-8" \
LC_ALL="en_US.UTF-8" \
claude
```

**特点**：
- ✅ 零日常影响 — 关闭终端就恢复
- ✅ 无需管理员权限
- ✅ 无需备份/回滚
- ✅ 覆盖最高权重信号（时区 + 语言 + Locale）
- ❌ 不覆盖系统级检测（如果 Claude Code 直接读系统时区而非环境变量）

**覆盖信号**：P1 + P2 + P3 + P4

---

### 方案 B：用户级持久化（可选增强）

**原理**：通过 `setx` 设置用户级环境变量，新终端自动继承

```bash
cc-fix persist on
# ↓ 执行：
setx LANG "en_US.UTF-8"
setx LC_ALL "en_US.UTF-8"
setx TZ "America/New_York"
```

**对日常使用的影响分析**：

| 环境变量 | Windows 原生应用 | 开发工具 | 结论 |
|---|---|---|---|
| LANG | 不读取 | Git/WSL/Node 读取 | **可保留** |
| LC_ALL | 不读取 | Git/WSL/Node 读取 | **可保留** |
| TZ | 系统时钟不读取 | Node.js/Python/开发工具读取 | **可保留** |

> Windows 系统时钟走的是注册表时区设置，**不读 TZ 环境变量**。
> 所以设置 TZ 用户环境变量不会改变系统时间显示。

**切换机制**：
```bash
cc-fix persist on     # 设置环境变量（自动备份旧值）
cc-fix persist off    # 恢复旧值（或删除新增的变量）
```

**覆盖信号**：P1-P4 + U1-U3

---

### 方案 C：系统级修改（不推荐，仅特殊场景）

**原理**：直接修改系统时区、语言等设置

**对日常使用的影响**：

| 修改项 | 影响 | 是否可接受 |
|---|---|---|
| 系统时区 | 时钟变化，所有应用时间改变 | ❌ 不可接受 |
| 系统 Locale | 需重启，UI 语言变化 | ❌ 不可接受 |
| 系统代理 | 浏览器走代理 | ⚠️ 看需求 |

**切换机制**：
```bash
cc-fix system on      # 修改系统设置（自动备份）
cc-fix system off     # 恢复系统设置
# 需要管理员权限
```

**覆盖信号**：全部

---

## 四、推荐组合

### 日常使用（推荐）

```
方案 A（进程级注入）= 覆盖 4 个高权重信号
+ 用户自行配置代理 = 覆盖 IP 信号
```

**效果**：
- 日常使用零影响
- Claude Code 环境一致性高
- 无需切换，`cc-fix run` 启动即可

### 增强模式（可选）

```
方案 A + 方案 B（用户级持久化）
```

**效果**：
- 日常使用几乎无影响（仅开发工具环境变为英文 locale）
- 所有终端/开发工具环境一致
- `cc-fix persist on` 一次设置，长期有效

### 完整模式（不推荐）

```
方案 A + B + C（含系统级修改）
```

**效果**：
- 日常使用有明显影响（时钟、语言）
- 需要频繁切换
- 仅在检测到严格环境校验时使用

---

## 五、字体问题的处理

| 场景 | 字体是否被检测 | 是否需要处理 |
|---|---|---|
| Claude Code CLI | **否** — CLI 不渲染 UI，无法检测字体 | 不需要 |
| claude.ai 浏览器 | **是** — Canvas 字体探测 | 不在本工具范围 |

**结论**：CLI 场景下字体风险可忽略，不需要修改系统字体。

---

## 六、最终命令设计（更新）

```
cc-fix check                    # 检测环境（显示所有信号 + 风险等级）
cc-fix run [command]            # 进程级注入启动（默认 claude）
cc-fix run --shell              # 启动安全环境 shell
cc-fix run --region us          # 指定目标地区（默认 us）
cc-fix persist on               # 开启用户级持久化
cc-fix persist off              # 关闭用户级持久化
cc-fix persist status           # 查看持久化状态
cc-fix proxy check              # 检测出口 IP / 代理
```

**不再需要**：
- ~~cc-fix fix~~ → 改为 `persist on`（用户级）和 `run`（进程级）
- ~~cc-fix rollback~~ → 改为 `persist off`
