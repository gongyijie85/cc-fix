# Ticket 07: 各检测插件 Node.js 实现规格

## Question

每个中优检测插件的具体实现方式、依赖和测试方案？

## ✅ 决议

### 1. DNS 检测 (dns.ts)
- `dns.lookup('api.anthropic.com')` 获取解析 IP
- 用 ip-api.com 查询该 IP 所在国家
- 与目标地区对比：一致=安全，不一致=风险
- 依赖：`node:dns`（内置），无新增
- 测试：mock `dns.lookup` 和 IP 查询

### 2. 系统字体 (fonts.ts)
- Windows: `dir /b C:\Windows\Fonts\*.ttf` 列出字体文件
- 匹配中文字体模式：`msyh` / `simsun` / `simhei` / `STSong` / `mingliu`
- 发现中文字体 → 风险加分
- 依赖：无，用 `child_process` + `fs`
- 测试：mock 字体目录列表

### 3. BASE_URL 域名 (base-url.ts)
- 读取 `ANTHROPIC_BASE_URL` 环境变量
- 匹配 147 个中国 AI 敏感域名清单（内置于 `src/detection/config/sensitive-domains.ts`）
- 命中 → 高风险
- 依赖：无
- 测试：mock process.env

### 4. 代理环境 (proxy-env.ts)
- 检查 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 是否设置
- 检查 `NO_PROXY` 是否合理
- 未设置代理 → 中风险（可能直连）
- 依赖：无
- 测试：mock process.env

### 5. Windows 区域格式 (win-locale.ts)
- `reg query "HKCU\Control Panel\International" /v LocaleName`
- 返回 `zh-CN` → 高风险
- 依赖：无，用 `child_process`
- 测试：mock reg query 输出

### 6. UTC 偏移 (utc-offset.ts)
- `new Date().getTimezoneOffset()` 获取当前偏移（分钟）
- 与目标时区的预期偏移对比
- 不一致 → 中风险
- 依赖：无
- 测试：直接测试

### 敏感域名清单
- 文件：`src/detection/config/sensitive-domains.ts`
- 内容：147 个中国 AI 服务商域名（从 check-cc 提取）
- 导出为 `Set<string>` 便于 O(1) 查找
