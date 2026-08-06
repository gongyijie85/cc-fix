# CLI 检测维度设计报告

> **调研日期**：2026-08-06
> **数据来源**：check-cc 开源代码（GitHub yacuo/check-cc）、checkcc.org、Claude Code 官方文档、社区逆向分析

---

## 1. 检测维度映射表

### 1.1 check-cc 浏览器端信号 → CLI/系统端等价物

| # | 浏览器端 (check-cc) | 权重 | CLI/系统端 (cc-fix) | 检测方法 | 修复方式 |
|---|---|---|---|---|---|
| 1 | **系统时区** `Intl.DateTimeFormat().resolvedOptions().timeZone` | 26 | **系统时区** | Windows: `Get-TimeZone` / `tzutil /g`；macOS: `date +%Z`；Linux: `timedatectl` / `$TZ` | Windows: `Set-TimeZone` / `tzutil /s`；macOS/Linux: `sudo systemsetup -settimezone` / `timedatectl set-timezone` |
| 2 | **浏览器语言** `navigator.languages` | 20 | **系统语言 / LANG 环境变量** | Windows: `Get-WinSystemLocale` / `Get-WinUserLanguageList`；macOS: `defaults read NSGlobalDomain AppleLanguages`；Linux: `$LANG` / `$LANGUAGE` | Windows: `Set-WinUserLanguageList`；Linux/macOS: 修改 `$LANG` / `$LC_ALL` |
| 3 | **Intl Locale** `Intl.DateTimeFormat().resolvedOptions().locale` | 6 | **Node.js ICU Locale / 系统 Locale** | Node.js: `Intl.DateTimeFormat().resolvedOptions().locale`；系统: Windows `Get-Culture`；Linux `$LC_*` | 修改系统区域设置 / 环境变量 |
| 4 | **中文变体** `zh-CN` vs `zh-TW` | 12 | **系统语言标签** | 同 #2，检查语言列表中的变体标签 | 同 #2 |
| 5 | **中文字体** Canvas 字体检测 | 16 | **系统已安装字体** | Windows: 注册表 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts`；macOS: `/Library/Fonts` + `~/Library/Fonts`；Linux: `fc-list` | 安装/卸载字体包 |
| 6 | **厂商字体** MiSans / HarmonyOS Sans 等 | 10 | **厂商字体检测** | 同 #5，匹配特定厂商字体名 | 安装对应字体包 |
| 7 | **国产浏览器** UA 匹配 | 8 | **不适用** — CLI 无浏览器 | N/A | N/A |
| 8 | **国产设备** UA 匹配 | 6 | **系统制造商信息** | Windows: `Get-CimInstance Win32_ComputerSystem`；macOS: `sysctl hw.model` | 无法修复（硬件决定） |
| 9 | **时区偏移** UTC offset | 4 | **UTC 偏移量** | `new Date().getTimezoneOffset()` (Node.js) 或 `date +%z` | 随时区修复联动 |
| 10 | **Emoji 风格** UA 推断 | 4 | **操作系统类型推断** | `os.platform()` / `os.type()` | 无法直接修复（OS 决定） |
| 11 | **User-Agent** | 0 (信息) | **不适用** — CLI 无 UA | N/A | N/A |
| 12 | **浏览器名称** | 0 (信息) | **不适用** | N/A | N/A |
| 13 | **操作系统** | 0 (信息) | **操作系统** | `os.platform()` / `os.release()` | 无法修复 |

### 1.2 check-cc 服务端信号 → CLI 等价物

| # | 服务端 (check-cc) | 权重 | CLI/系统端 (cc-fix) | 检测方法 | 修复方式 |
|---|---|---|---|---|---|
| 14 | **IP 出口国家** `country` | 20 | **出口 IP 国家** | HTTP 请求 `ipinfo.io` / `ip-api.com` / `ifconfig.co` | 更换代理节点 / VPN |
| 15 | **代理国家** `proxyCountry` | 0 (信息) | **代理/VPN 检测** | 检查 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量；检测 IP 是否为数据中心 | 配置代理 |
| 16 | **IP 地址** | 0 (信息) | **出口 IP** | 同上 IP 查询服务 | 更换出口 |
| 17 | **IP 归属地** `browserIpLocation` | 0 (信息) | **IP 地理位置详情** | IP 情报 API 返回的 city/region | 更换代理节点 |
| 18 | **IP 组织** `browserIpOrg` | 0 (信息) | **IP ASN / 组织** | IP 情报 API 返回的 org/asn | 更换为住宅 IP 代理 |

### 1.3 CLI 新增维度（浏览器端无法检测，但 CLI 可检测）

| # | 维度 | 说明 | 检测方法 | 修复方式 |
|---|---|---|---|---|
| 19 | **`ANTHROPIC_BASE_URL` 域名检查** | Claude Code 曾检测 base URL 是否包含中国 AI 域名（147 条名单） | 读取 `$env:ANTHROPIC_BASE_URL`，匹配域名列表 | 使用非中国域名的代理 |
| 20 | **DNS 泄露** | 系统 DNS 解析可能暴露真实位置 | `nslookup` 主流网站，检查返回的 DNS 服务器 | 配置系统 DNS 为公共 DNS（8.8.8.8 等） |
| 21 | **系统主机名 / 用户名** | 可能包含中文拼音等暴露地区的线索 | `os.hostname()` / `os.userInfo().username` | 修改主机名/用户名 |
| 22 | **进程环境变量一致性** | 检查 `LANG`、`LC_ALL`、`TZ` 等是否互相矛盾 | 读取环境变量并交叉验证 | 统一设置 |
| 23 | **Node.js 版本 / 运行时** | Claude Code 运行在 Node.js 上，版本信息可能被采集 | `process.version` | 升级/降级 Node.js |
| 24 | **系统区域格式 (Windows)** | Windows 区域设置（非 Unicode 程序使用的语言） | `Get-WinSystemLocale` | `Set-WinSystemLocale` |
| 25 | **键盘布局** | 键盘布局可能暴露真实语言偏好 | Windows: `Get-WinUserLanguageList` | 调整语言列表 |

---

## 2. Claude Code 环境信号分析

### 2.1 Claude Code 发送给 Anthropic 的环境信息

根据官方文档和社区逆向分析，Claude Code 在每次 API 请求中发送以下信息：

#### 显式发送（官方文档确认）

| 信号 | 位置 | 说明 |
|---|---|---|
| `x-claude-code-session-id` | HTTP Header | 当前会话唯一 ID |
| `x-claude-code-agent-id` | HTTP Header | 子代理 ID（如有） |
| `x-claude-code-parent-agent-id` | HTTP Header | 父代理 ID（如有） |
| 客户端版本 + 对话指纹 | System Prompt 前置归属块 | 从 v2.1.181 起，在自定义 base URL 下会话内稳定 |
| `anthropic-version` | HTTP Header | API 版本 `2023-06-01` |
| `anthropic-beta` | HTTP Header | 能力标志列表 |
| `x-api-key` / `Authorization` | HTTP Header | 认证凭据 |

#### 隐式发送（已被回滚的隐写检测，v2.1.91 ~ v2.1.196+）

根据社区逆向分析和 Anthropic 官方回应（Thariq 在推特承认）：

| 信号 | 检测方式 | 编码方式 |
|---|---|---|
| **系统时区** | 检查是否为 `Asia/Shanghai` 或 `Asia/Urumqi` | 日期格式从 `2026-06-30` 变为 `2026/06/30` |
| **ANTHROPIC_BASE_URL 域名** | 匹配 147 条中国 AI 域名清单（百度、阿里、字节、DeepSeek、Moonshot 等） | 通过 Unicode 变体编码：|
| | | U+2019（右单引号）= 命中中国域名但非 AI 实验室 |
| | | U+02BC（修饰字母撇号）= 关联中国 AI 实验室 |
| | | U+02B9（修饰字母上撇号）= 两者均命中 |

> **注意**：Anthropic 声称已在 v2.1.197+ 回滚此检测，但无法确认是否完全移除或仅暂停。

#### 遥测数据（OTEL）

当 `CLAUDE_CODE_ENABLE_TELEMETRY=1` 时，Claude Code 通过 OpenTelemetry 发送：
- 会话指标
- API 请求/响应数据（当 `OTEL_LOG_RAW_API_BODIES=1`）
- 工具使用统计
- 错误信息

### 2.2 Anthropic 服务端能看到的信号

| 层级 | 信号 | 说明 |
|---|---|---|
| **网络层** | 出口 IP、IP 地理位置、ASN/组织 | 最直接的地区信号 |
| **TLS 层** | TLS 指纹（JA3/JA4） | 可区分操作系统和客户端类型 |
| **HTTP 层** | 请求头顺序、值格式 | 可推断客户端类型 |
| **应用层** | System Prompt 归属块（版本 + 指纹） | 客户端版本和会话标识 |
| **应用层** | 隐写水印（如未完全回滚） | 时区、域名检测结果 |
| **行为层** | 请求模式、使用频率、代码内容语言 | 长期行为分析 |
| **支付层** | 信用卡 BIN 国家、支付方式 | 订阅/支付时的地区信号 |

### 2.3 封号风险信号分析

根据社区经验和 check-cc 的风险模型，封号风险信号按权重排序：

#### 高风险（直接触发风控）
1. **IP 出口在中国大陆** — 约 60% 的封号原因
2. **IP 为已知数据中心/VPN** — 住宅 IP vs 数据中心 IP
3. **IP 频繁切换国家** — 画像不稳定

#### 中风险（增加可疑度）
4. **系统时区为中国时区** — `Asia/Shanghai` / `Asia/Urumqi`
5. **系统语言为中文** — `zh-CN`
6. **Intl Locale 为中文** — `zh-CN` / `zh-Hans`
7. **信号不一致** — IP 在美国但时区是上海

#### 低风险（辅助判断）
8. **中文字体存在** — 证明系统可能为中文环境
9. **厂商字体** — MiSans / HarmonyOS Sans 等
10. **国产设备** — 硬件层面的地区线索
11. **DNS 泄露** — DNS 服务器暴露真实位置

---

## 3. CLI 版检测维度清单

### 3.1 高优先级 — 必须检测

#### D1: 系统时区
- **说明**：Claude Code 已知会检测系统时区是否为 `Asia/Shanghai` 或 `Asia/Urumqi`，这是最高权重的环境信号之一
- **检测方法**：
  - Windows: `tzutil /g` 或 PowerShell `Get-TimeZone`
  - macOS: `date +%Z` 或 `systemsetup -gettimezone`
  - Linux: `timedatectl` 或读取 `/etc/timezone` / `$TZ`
  - Node.js: `Intl.DateTimeFormat().resolvedOptions().timeZone`
- **预期值**：非受限地区时区（如 `America/New_York`、`Europe/London`、`Asia/Tokyo`）
- **修复方式**：
  - Windows: `Set-TimeZone "Eastern Standard Time"` (需管理员)
  - macOS: `sudo systemsetup -settimezone America/New_York`
  - Linux: `sudo timedatectl set-timezone America/New_York`
  - 或设置 `$TZ` 环境变量（仅影响当前进程）

#### D2: 系统语言 / Locale
- **说明**：浏览器端 `navigator.languages` 映射到系统级语言设置，是第二高权重信号
- **检测方法**：
  - Windows: `Get-WinUserLanguageList` / `Get-Culture`
  - macOS: `defaults read NSGlobalDomain AppleLanguages`
  - Linux: `$LANG` / `$LC_ALL` / `$LANGUAGE`
  - Node.js: `Intl.DateTimeFormat().resolvedOptions().locale`
- **预期值**：非 `zh-CN` / `zh-Hans`
- **修复方式**：
  - Windows: `Set-WinUserLanguageList en-US -Force`
  - Linux/macOS: `export LANG=en_US.UTF-8`

#### D3: 出口 IP 国家
- **说明**：约 60% 的封号与 IP 相关，是最关键的网络层信号
- **检测方法**：
  - HTTP 请求 `https://ipinfo.io/json` 或 `https://ip-api.com/json`
  - 检查返回的 `country` 字段
- **预期值**：非 `CN`、`RU`、`IR` 等受限国家
- **修复方式**：更换代理节点 / VPN

#### D4: 信号一致性校验
- **说明**：各维度之间不能互相矛盾，不一致本身就是高风险信号
- **检测方法**：
  - 比对时区、语言、IP 国家是否属于同一地区画像
  - 例如：IP 在美国 + 时区 `America/New_York` + 语言 `en-US` = 一致 ✓
  - 例如：IP 在美国 + 时区 `Asia/Shanghai` + 语言 `zh-CN` = 矛盾 ✗
- **修复方式**：统一所有信号到同一地区画像

### 3.2 中优先级 — 建议检测

#### D5: UTC 偏移量
- **说明**：时区的数值表达，与系统时区联动
- **检测方法**：Node.js `new Date().getTimezoneOffset()` 或系统命令 `date +%z`
- **预期值**：与目标时区一致（如 `America/New_York` → UTC-5 或 UTC-4）

#### D6: Node.js Intl Locale
- **说明**：Node.js ICU 数据决定的 locale，可能与系统 locale 不同
- **检测方法**：`Intl.DateTimeFormat().resolvedOptions().locale`
- **预期值**：与系统语言一致

#### D7: 代理/VPN 环境变量
- **说明**：检查是否设置了代理，以及代理配置是否合理
- **检测方法**：检查 `$HTTP_PROXY`、`$HTTPS_PROXY`、`$ALL_PROXY`、`$NO_PROXY`
- **预期值**：代理配置存在且指向合理地区

#### D8: DNS 配置
- **说明**：系统 DNS 可能泄露真实位置
- **检测方法**：检查系统 DNS 服务器配置
  - Windows: `Get-DnsClientServerAddress`
  - Linux: `/etc/resolv.conf`
  - macOS: `scutil --dns`
- **预期值**：使用公共 DNS（8.8.8.8 / 1.1.1.1）或代理 DNS

#### D9: IP ASN / 组织类型
- **说明**：数据中心 IP 比住宅 IP 风险更高
- **检测方法**：IP 情报 API 返回的 `org` / `asn` 字段
- **预期值**：住宅 ISP 优于数据中心

#### D10: ANTHROPIC_BASE_URL 域名
- **说明**：Claude Code 曾检测 base URL 是否包含中国 AI 域名
- **检测方法**：读取 `$env:ANTHROPIC_BASE_URL`，提取域名，匹配已知敏感域名列表
- **预期值**：不包含中国 AI 实验室域名

#### D11: Windows 系统区域格式
- **说明**：Windows 特有的"非 Unicode 程序使用的语言"设置
- **检测方法**：`Get-WinSystemLocale`
- **预期值**：非 `zh-CN`

#### D12: 系统已安装字体（中文字体）
- **说明**：中文字体的存在是地区环境的强信号
- **检测方法**：
  - Windows: 检查注册表字体列表
  - Linux: `fc-list :lang=zh`
  - macOS: 检查 `/Library/Fonts` 和 `~/Library/Fonts`
- **预期值**：无中文字体（或极少）
- **修复方式**：卸载中文字体包（谨慎操作）

### 3.3 低优先级 — 可选

#### D13: 主机名 / 用户名
- **说明**：可能包含中文拼音等暴露地区的线索
- **检测方法**：`os.hostname()` / `os.userInfo().username`
- **修复方式**：修改主机名/用户名

#### D14: 厂商字体
- **说明**：MiSans、HarmonyOS Sans、OPPO Sans 等厂商字体暴露设备来源
- **检测方法**：同 D12，匹配特定厂商字体名
- **修复方式**：卸载对应字体

#### D15: 系统制造商信息
- **说明**：硬件层面的地区线索（华为、小米等）
- **检测方法**：
  - Windows: `Get-CimInstance Win32_ComputerSystem` → `Manufacturer` / `Model`
  - Linux: `dmidecode -t system`
- **修复方式**：无法修复（硬件决定）

#### D16: 键盘布局
- **说明**：键盘布局可能暴露语言偏好
- **检测方法**：
  - Windows: `Get-WinUserLanguageList` → `InputMethodTips`
  - Linux: `$XKB_DEFAULT_LAYOUT`
- **修复方式**：调整键盘布局设置

#### D17: Node.js 版本
- **说明**：运行时版本信息
- **检测方法**：`process.version`
- **修复方式**：安装合适的 Node.js 版本

#### D18: 进程环境变量完整性
- **说明**：检查所有语言/地区相关环境变量是否一致
- **检测方法**：扫描 `LANG`、`LC_ALL`、`LC_CTYPE`、`LC_MESSAGES`、`TZ` 等
- **修复方式**：统一设置

---

## 4. 优先级排序

### 高优先级（必须检测）— 不一致直接导致封号

| 维度 | 权重参考 | 理由 |
|---|---|---|
| D1: 系统时区 | check-cc 权重 26 | Claude Code 已知主动检测，隐写编码到 system prompt |
| D2: 系统语言/Locale | check-cc 权重 20 | 第二高权重信号，浏览器端和系统端都关键 |
| D3: 出口 IP 国家 | check-cc 权重 20 | 约 60% 封号的直接原因 |
| D4: 信号一致性 | 综合 | 多信号矛盾是强风控触发条件 |

### 中优先级（建议检测）— 增加可疑度

| 维度 | 权重参考 | 理由 |
|---|---|---|
| D5: UTC 偏移量 | check-cc 权重 4 | 与系统时区联动，低成本验证 |
| D6: Node.js Intl Locale | check-cc 权重 6 | CLI 可直接检测，与系统 locale 可能不同 |
| D7: 代理/VPN 环境变量 | — | CLI 特有，影响网络行为 |
| D8: DNS 配置 | — | 可能绕过代理泄露真实位置 |
| D9: IP ASN/组织类型 | — | 数据中心 IP 风险高于住宅 IP |
| D10: BASE_URL 域名 | — | Claude Code 曾有此检测逻辑 |
| D11: Windows 系统区域格式 | — | Windows 特有但常见 |
| D12: 中文字体 | check-cc 权重 16 | 浏览器端高权重，CLI 端可降低 |

### 低优先级（可选）— 辅助信号

| 维度 | 权重参考 | 理由 |
|---|---|---|
| D13: 主机名/用户名 | — | 低概率暴露 |
| D14: 厂商字体 | check-cc 权重 10 | 仅特定设备相关 |
| D15: 系统制造商信息 | check-cc 权重 6 | 硬件决定，无法修复 |
| D16: 键盘布局 | — | 弱信号 |
| D17: Node.js 版本 | — | 信息性 |
| D18: 环境变量完整性 | — | 与 D1/D2 重叠 |

---

## 5. 浏览器端 → CLI 端映射总结

### 不适用维度（浏览器独有，CLI 无需检测）
- 浏览器 UA → CLI 无 UA
- 浏览器名称 → CLI 无浏览器
- 国产浏览器检测 → CLI 无浏览器
- Emoji 渲染风格 → CLI 无 GUI
- Canvas 字体指纹 → CLI 需改用系统字体 API

### 直接映射维度
| 浏览器 API | CLI 等价 API (Node.js) |
|---|---|
| `Intl.DateTimeFormat().resolvedOptions().timeZone` | 同（Node.js 内置） |
| `Intl.DateTimeFormat().resolvedOptions().locale` | 同（Node.js 内置） |
| `navigator.languages` | `os.language` (macOS) / 环境变量 / 注册表 |
| `new Date().getTimezoneOffset()` | 同（Node.js 内置） |
| Canvas 字体检测 | 系统字体 API / 注册表 / `fc-list` |
| IP 查询（服务端） | 同（CLI 可发 HTTP 请求） |

### CLI 新增维度（浏览器无法检测）
- 系统环境变量（`LANG`、`TZ`、`HTTP_PROXY` 等）
- DNS 配置
- 系统主机名/用户名
- Windows 区域格式
- `ANTHROPIC_BASE_URL` 域名检查
- Node.js 运行时信息

---

## 6. 实施建议

### 6.1 检测架构

```
cc-fix CLI
├── detectors/
│   ├── timezone.ts        # D1: 系统时区
│   ├── language.ts        # D2: 系统语言
│   ├── ip-geo.ts          # D3: 出口 IP 国家
│   ├── consistency.ts     # D4: 信号一致性
│   ├── utc-offset.ts      # D5: UTC 偏移
│   ├── node-locale.ts     # D6: Node.js Locale
│   ├── proxy-env.ts       # D7: 代理环境变量
│   ├── dns-config.ts      # D8: DNS 配置
│   ├── ip-asn.ts          # D9: IP ASN
│   ├── base-url.ts        # D10: BASE_URL 域名
│   ├── system-locale.ts   # D11: Windows 系统区域
│   ├── fonts.ts           # D12: 系统字体
│   └── hostname.ts        # D13: 主机名
├── scoring/
│   └── index.ts           # 加权评分引擎
├── fixers/
│   └── ...                # 自动修复模块
└── index.ts               # CLI 入口
```

### 6.2 评分模型

参考 check-cc 的加权评分，CLI 版本建议：

| 维度 | 建议权重 | 满分 |
|---|---|---|
| D1 系统时区 | 25 | 0-25 |
| D2 系统语言 | 20 | 0-20 |
| D3 出口 IP | 25 | 0-25 |
| D4 一致性 | 15 | 0-15 |
| D5-D12 中优先级 | 各 2-5 | 0-15 |
| **总分** | **100** | **0-100** |

风险等级：
- 0-20: 低风险（绿色）
- 21-50: 中风险（黄色）
- 51-70: 高风险（橙色）
- 71-100: 极高风险（红色）

### 6.3 跨平台考虑

| 平台 | 优先级 | 说明 |
|---|---|---|
| Windows | **P0** | 用户当前环境，首先支持 |
| macOS | P1 | Claude Code 主流平台 |
| Linux | P2 | 服务器场景常见 |
