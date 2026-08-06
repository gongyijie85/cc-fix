# 自动修复能力调研报告

> 调研日期：2026-08-06  
> 目标平台：Windows（主），macOS/Linux（扩展预留）  
> 目标场景：Claude Code 运行环境安全风险的自动修复

---

## 1. 修复能力矩阵

| 修复项 | 实现方法 | 权限要求 | 风险等级 | 是否需重启 | 回滚难度 |
|---|---|---|---|---|---|
| 系统时区 | `tzutil /s` / PowerShell `Set-TimeZone` | 管理员 | 低 | 否（新进程立即生效） | 容易 |
| 系统语言 | 注册表 + `setx` / PowerShell | 管理员（系统级）/ 用户级（用户级） | 中 | 需重启终端，部分需注销 | 中等 |
| 环境变量 | `setx` / 注册表 `Environment` | 用户级无需管理员；系统级需管理员 | 低 | 需重启终端 | 容易 |
| Node.js locale | 启动参数 `--icu-data-dir` / `NODE_OPTIONS` | 无（进程级） | 低 | 否（新进程生效） | 容易 |
| 代理设置 | 注册表 / 环境变量 / `netsh` | 用户环境变量无需管理员；系统代理需管理员 | 中 | 否（新连接生效） | 容易 |
| Hosts 文件 | 直接编辑 `C:\Windows\System32\drivers\etc\hosts` | 管理员 | 高 | 否（DNS 缓存刷新即可） | 容易（有备份时） |

---

## 2. 各项修复的详细实现

### 2.1 系统时区

**Windows 实现：**

```powershell
# 方法 1：tzutil（推荐，简洁）
tzutil /s "China Standard Time"

# 方法 2：PowerShell
Set-TimeZone -Id "China Standard Time"

# 查询当前时区
tzutil /g
# 列出所有可用时区
tzutil /l
```

```typescript
// TypeScript 实现示例
import { execSync } from 'child_process';

function setTimezone(timezoneId: string): boolean {
  try {
    execSync(`tzutil /s "${timezoneId}"`, { stdio: 'pipe' });
    return true;
  } catch (e) {
    // 常见错误：权限不足 / 时区 ID 无效
    if ((e as any).status === 1) {
      throw new Error('需要管理员权限来修改系统时区');
    }
    throw new Error(`无效的时区 ID: ${timezoneId}`);
  }
}
```

**注意事项：**
- `tzutil /s` 需要管理员权限，普通用户执行会报"拒绝访问"
- 时区 ID 必须是 Windows 识别的英文 ID（如 `"China Standard Time"`，不是 `"中国标准时间"`）
- 修改后，已运行的进程不会自动更新时区，但新启动的进程会立即使用新时区
- Windows 时区 ID 与 IANA 时区 ID 不同，需要做映射

**错误处理：**
- 权限不足 → 提示用户以管理员身份运行
- 无效时区 ID → 先用 `tzutil /l` 验证 ID 合法性

---

### 2.2 系统语言

**Windows 实现：**

```powershell
# 方法 1：注册表（用户级，无需管理员）
# 设置用户 locale
Set-ItemProperty -Path "HKCU:\Control Panel\International" -Name "Locale" -Value "00000409"  # en-US
Set-ItemProperty -Path "HKCU:\Control Panel\International" -Name "LocaleName" -Value "en-US"

# 方法 2：PowerShell（系统级，需管理员）
# 安装语言包
Install-Language en-US
Set-WinSystemLocale -SystemLocale en-US

# 方法 3：setx 设置用户级环境变量（无需管理员）
setx LANG "en_US.UTF-8"
```

```typescript
// TypeScript 实现示例
import { execSync } from 'child_process';
import * as winreg from 'winreg';

function setUserLocale(locale: string): void {
  const reg = new winreg({
    hive: winreg.HKCU,
    key: '\\Control Panel\\International'
  });
  
  reg.set('Locale', winreg.REG_SZ, locale, (err) => {
    if (err) throw new Error(`设置 locale 失败: ${err.message}`);
  });
}
```

**注意事项：**
- **用户级修改**（HKCU 注册表）无需管理员，但需要重启终端或注销/登录才能完全生效
- **系统级修改**（HKLM 注册表 / `Set-WinSystemLocale`）需要管理员权限，且需要重启系统
- 语言包安装（`Install-Language`）需要 Windows 10 1903+ 且需管理员权限
- 对于 Claude Code 场景，通常只需设置用户级 locale + 环境变量即可，不必改系统语言

**风险：**
- 修改系统语言可能影响其他应用程序的显示语言
- 建议只修改用户级设置，避免影响系统级设置

---

### 2.3 环境变量

**Windows 实现：**

```powershell
# 方法 1：setx（用户级，无需管理员，推荐）
setx LANG "en_US.UTF-8"
setx LC_ALL "en_US.UTF-8"
setx TZ "UTC"

# 方法 2：setx（系统级，需管理员）
setx /M LANG "en_US.UTF-8"

# 方法 3：注册表（用户级）
reg add "HKCU\Environment" /v LANG /t REG_SZ /d "en_US.UTF-8" /f

# 方法 4：PowerShell
[Environment]::SetEnvironmentVariable("LANG", "en_US.UTF-8", "User")
[Environment]::SetEnvironmentVariable("LC_ALL", "en_US.UTF-8", "User")
```

```typescript
// TypeScript 实现示例
import { execSync } from 'child_process';
import * as winreg from 'winreg';

interface EnvFix {
  key: string;
  value: string;
  scope: 'User' | 'Machine';
}

function fixEnvironmentVariables(fixes: EnvFix[]): void {
  for (const fix of fixes) {
    if (fix.scope === 'User') {
      // 用户级，无需管理员
      execSync(`setx ${fix.key} "${fix.value}"`, { stdio: 'pipe' });
    } else {
      // 系统级，需管理员
      execSync(`setx /M ${fix.key} "${fix.value}"`, { stdio: 'pipe' });
    }
  }
}
```

**注意事项：**
- `setx` 设置的环境变量**对当前终端不生效**，只对新打开的终端生效
- 如果需要在当前进程立即生效，还需同时调用 `process.env.KEY = value`
- 用户级环境变量无需管理员权限
- 系统级环境变量（`/M`）需要管理员权限
- `setx` 有 1024 字符长度限制

**回滚策略：**
- 修改前先用 `reg query "HKCU\Environment" /v KEY` 读取旧值
- 回滚时恢复旧值或删除新增的变量

---

### 2.4 Node.js Locale

**实现方法：**

```bash
# 方法 1：启动参数
node --icu-data-dir=/path/to/icu your-script.js

# 方法 2：环境变量（推荐）
NODE_OPTIONS="--icu-data-dir=/path/to/icu" node your-script.js

# 方法 3：通过 process.env 在代码内设置（仅影响部分 API）
process.env.LANG = 'en_US.UTF-8';
process.env.LC_ALL = 'en_US.UTF-8';
```

```typescript
// TypeScript 实现示例
import { execSync } from 'child_process';

function setNodeLocale(locale: string): void {
  // 设置用户级环境变量，让 Node.js 继承
  execSync(`setx LANG "${locale}"`, { stdio: 'pipe' });
  execSync(`setx LC_ALL "${locale}"`, { stdio: 'pipe' });
  
  // 同时写入 shell profile 使其持久化
  // 对于当前进程也立即生效
  process.env.LANG = locale;
  process.env.LC_ALL = locale;
}
```

**注意事项：**
- Node.js 的 locale 主要受系统环境变量影响
- 完全独立的 ICU 数据目录方式较重，一般不需要
- 对于 Claude Code 场景，设置 `LANG` / `LC_ALL` 环境变量通常足够
- 无需任何特殊权限

**风险：** 极低，只影响 Node.js 进程的 locale 行为

---

### 2.5 代理设置

**Windows 实现：**

```powershell
# 方法 1：用户级环境变量（无需管理员，推荐）
setx HTTP_PROXY "http://proxy:port"
setx HTTPS_PROXY "http://proxy:port"
setx NO_PROXY "localhost,127.0.0.1"

# 方法 2：系统代理（需管理员）
# 通过注册表设置 IE/系统代理
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /t REG_SZ /d "proxy:port" /f

# 方法 3：netsh（需管理员）
netsh winhttp set proxy proxy:port

# 方法 4：PowerShell 查询/设置
# 查询当前代理
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" | Select ProxyEnable, ProxyServer

# 关闭系统代理
Set-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyEnable -Value 0
```

```typescript
// TypeScript 实现示例
import { execSync } from 'child_process';
import * as winreg from 'winreg';

interface ProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  systemProxy?: boolean;
}

function configureProxy(config: ProxyConfig): void {
  // 1. 设置环境变量（用户级，无需管理员）
  if (config.httpProxy) {
    execSync(`setx HTTP_PROXY "${config.httpProxy}"`, { stdio: 'pipe' });
  }
  if (config.httpsProxy) {
    execSync(`setx HTTPS_PROXY "${config.httpsProxy}"`, { stdio: 'pipe' });
  }
  if (config.noProxy) {
    execSync(`setx NO_PROXY "${config.noProxy}"`, { stdio: 'pipe' });
  }

  // 2. 设置系统代理（HKCU 注册表，无需管理员）
  if (config.systemProxy && config.httpProxy) {
    const regPath = '\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const reg = new winreg({ hive: winreg.HKCU, key: regPath });
    reg.set('ProxyEnable', winreg.REG_DWORD, '1', () => {});
    reg.set('ProxyServer', winreg.REG_SZ, config.httpProxy, () => {});
  }
}
```

**注意事项：**
- 环境变量代理对大多数 CLI 工具（包括 Node.js、npm、git）有效
- 系统代理（IE/Internet Settings）影响使用 `WinHttpOpen` / `InternetOpen` 的应用
- HKCU 注册表的代理设置**不需要管理员权限**
- 修改代理后，已建立的连接不会自动切换，新连接会使用新代理

**风险：**
- 设置错误可能导致网络中断
- 建议修复前备份当前代理配置

---

### 2.6 Hosts 文件

**Windows 实现：**

```powershell
# 读取当前 hosts 文件
Get-Content "C:\Windows\System32\drivers\etc\hosts"

# 添加条目（需管理员）
Add-Content "C:\Windows\System32\drivers\etc\hosts" "`n1.2.3.4 example.com"

# 备份 hosts 文件
Copy-Item "C:\Windows\System32\drivers\etc\hosts" "C:\Windows\System32\drivers\etc\hosts.bak"

# 刷新 DNS 缓存
ipconfig /flushdns
```

```typescript
// TypeScript 实现示例
import * as fs from 'fs';
import { execSync } from 'child_process';

const HOSTS_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts';

function backupHosts(): string {
  const backupPath = `${HOSTS_PATH}.ccfix-backak-${Date.now()}`;
  fs.copyFileSync(HOSTS_PATH, backupPath);
  return backupPath;
}

function addHostEntry(ip: string, hostname: string): void {
  const content = fs.readFileSync(HOSTS_PATH, 'utf-8');
  const entry = `${ip}\t${hostname}`;
  
  // 检查是否已存在
  if (content.includes(hostname)) {
    console.log(`Hosts 中已存在 ${hostname}，跳过`);
    return;
  }
  
  // 追加条目
  fs.appendFileSync(HOSTS_PATH, `\n${entry}\n`);
  
  // 刷新 DNS 缓存
  execSync('ipconfig /flushdns', { stdio: 'pipe' });
}
```

**注意事项：**
- **必须管理员权限**才能写入 hosts 文件
- 修改前必须备份
- 修改后需刷新 DNS 缓存：`ipconfig /flushdns`
- 注意文件编码应为 ASCII 或 UTF-8 无 BOM
- Windows Defender 可能监控 hosts 文件修改

**风险：**
- 高风险操作：错误的 hosts 条目可能导致网站无法访问
- 必须有备份和回滚机制
- 建议每次修改前创建带时间戳的备份

---

## 3. 权限管理策略

### 3.1 检测当前权限

```typescript
import { execSync } from 'child_process';
import * as fs from 'fs';

/**
 * 检测当前是否以管理员身份运行
 */
function isAdmin(): boolean {
  try {
    // 方法 1：尝试写入受保护目录
    const testPath = 'C:\\Windows\\ccfix-admin-test';
    fs.writeFileSync(testPath, 'test');
    fs.unlinkSync(testPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 方法 2：通过 whoami 命令检测（更可靠）
 */
function isAdminViaWhoami(): boolean {
  try {
    const output = execSync('whoami /groups /fo csv', { encoding: 'utf-8' });
    return output.includes('S-1-5-32-544'); // Administrators group SID
  } catch {
    return false;
  }
}

/**
 * 方法 3：通过 net session 检测（经典方法）
 */
function isAdminViaNetSession(): boolean {
  try {
    execSync('net session', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
```

### 3.2 权限分级策略

```
┌─────────────────────────────────────────────────┐
│              修复项权限分级                        │
├───────────────┬─────────────────────────────────┤
│ 无需管理员     │ • 环境变量（用户级 setx）         │
│               │ • HKCU 注册表修改                │
│               │ • Node.js locale（进程级）        │
│               │ • 用户级代理设置                  │
├───────────────┼─────────────────────────────────┤
│ 需要管理员     │ • 系统时区（tzutil /s）          │
│               │ • 系统级环境变量（setx /M）       │
│               │ • 系统代理（netsh winhttp）       │
│               │ • Hosts 文件编辑                 │
│               │ • 系统语言包安装                  │
└───────────────┴─────────────────────────────────┘
```

### 3.3 权限提升策略

```typescript
/**
 * 根据修复项自动判断是否需要提升权限
 */
interface FixItem {
  name: string;
  requiresAdmin: boolean;
  execute: () => void;
}

async function runFixes(fixes: FixItem[]): void {
  const needsAdmin = fixes.some(f => f.requiresAdmin);
  const isCurrentlyAdmin = isAdmin();

  if (needsAdmin && !isCurrentlyAdmin) {
    // 策略 1：分两阶段执行
    // 先执行不需要管理员的修复
    const userFixes = fixes.filter(f => !f.requiresAdmin);
    for (const fix of userFixes) {
      console.log(`[用户级] 正在修复: ${fix.name}`);
      fix.execute();
    }

    // 再提示用户提升权限
    console.log('\n以下修复需要管理员权限:');
    const adminFixes = fixes.filter(f => f.requiresAdmin);
    adminFixes.forEach(f => console.log(`  - ${f.name}`));
    console.log('\n请以管理员身份重新运行此工具以完成全部修复。');
    
    // 策略 2：使用 sudo / runas 自动提升（可选）
    // 在 Windows 上可通过 shell-exec 以 runas 方式启动新进程
  } else {
    // 全部执行
    for (const fix of fixes) {
      console.log(`正在修复: ${fix.name}`);
      fix.execute();
    }
  }
}
```

### 3.4 何时提示用户

| 场景 | 行为 |
|---|---|
| 所有修复项均为用户级 | 直接执行，无需提示 |
| 部分修复项需管理员 | 先执行用户级修复，再提示提升权限执行剩余项 |
| 全部修复项需管理员 | 直接提示以管理员身份运行 |
| 用户拒绝提升权限 | 记录未完成项，提供手动修复指南 |

---

## 4. 回滚策略

### 4.1 备份机制

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface BackupData {
  timestamp: string;
  fixes: Record<string, any>;
}

const BACKUP_DIR = path.join(process.env.APPDATA || '', 'ccfix', 'backups');

/**
 * 修复前备份所有相关设置
 */
function createBackup(): BackupData {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  
  const backup: BackupData = {
    timestamp: new Date().toISOString(),
    fixes: {}
  };

  // 1. 备份时区
  backup.fixes.timezone = execSync('tzutil /g', { encoding: 'utf-8' }).trim();

  // 2. 备份环境变量
  const envKeys = ['LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
  backup.fixes.envVars = {};
  for (const key of envKeys) {
    try {
      const val = execSync(
        `reg query "HKCU\\Environment" /v ${key} 2>nul`,
        { encoding: 'utf-8' }
      );
      backup.fixes.envVars[key] = parseRegValue(val);
    } catch {
      backup.fixes.envVars[key] = null; // 不存在
    }
  }

  // 3. 备份代理设置
  try {
    const proxyReg = execSync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable`,
      { encoding: 'utf-8' }
    );
    backup.fixes.proxyEnabled = proxyReg.includes('0x1');
  } catch {
    backup.fixes.proxyEnabled = false;
  }

  // 4. 备份 hosts 文件
  const hostsBackup = path.join(BACKUP_DIR, `hosts-${Date.now()}.bak`);
  fs.copyFileSync(
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    hostsBackup
  );
  backup.fixes.hostsBackupPath = hostsBackup;

  // 5. 备份 locale 注册表
  try {
    const localeReg = execSync(
      `reg query "HKCU\\Control Panel\\International" /v Locale`,
      { encoding: 'utf-8' }
    );
    backup.fixes.locale = parseRegValue(localeReg);
  } catch {
    backup.fixes.locale = null;
  }

  // 保存备份文件
  const backupFile = path.join(BACKUP_DIR, `backup-${Date.now()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  backup.fixes.backupFile = backupFile;

  return backup;
}
```

### 4.2 回滚实现

```typescript
/**
 * 从备份回滚所有设置
 */
function rollback(backupFile: string): void {
  const backup: BackupData = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));

  // 1. 回滚时区
  if (backup.fixes.timezone) {
    execSync(`tzutil /s "${backup.fixes.timezone}"`, { stdio: 'pipe' });
    console.log(`✓ 时区已恢复为: ${backup.fixes.timezone}`);
  }

  // 2. 回滚环境变量
  for (const [key, value] of Object.entries(backup.fixes.envVars || {})) {
    if (value === null) {
      // 原来不存在，删除
      execSync(`reg delete "HKCU\\Environment" /v ${key} /f`, { stdio: 'pipe' });
    } else {
      execSync(`setx ${key} "${value}"`, { stdio: 'pipe' });
    }
    console.log(`✓ 环境变量 ${key} 已恢复`);
  }

  // 3. 回滚代理
  if (!backup.fixes.proxyEnabled) {
    execSync(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
      { stdio: 'pipe' }
    );
    console.log('✓ 系统代理已关闭');
  }

  // 4. 回滚 hosts 文件
  if (backup.fixes.hostsBackupPath && fs.existsSync(backup.fixes.hostsBackupPath)) {
    fs.copyFileSync(backup.fixes.hostsBackupPath, 'C:\\Windows\\System32\\drivers\\etc\\hosts');
    execSync('ipconfig /flushdns', { stdio: 'pipe' });
    console.log('✓ hosts 文件已恢复');
  }

  // 5. 回滚 locale
  if (backup.fixes.locale) {
    execSync(
      `reg add "HKCU\\Control Panel\\International" /v Locale /t REG_SZ /d "${backup.fixes.locale}" /f`,
      { stdio: 'pipe' }
    );
    console.log('✓ Locale 已恢复');
  }

  console.log('\n所有设置已回滚到修复前状态。请重启终端使更改完全生效。');
}
```

### 4.3 CLI 命令设计

```
cc-fix fix              # 执行自动修复（先备份再修复）
cc-fix fix --dry-run    # 仅检测，不实际修复
cc-fix rollback         # 回滚到最近一次备份
cc-fix rollback <file>  # 回滚到指定备份文件
cc-fix backup           # 仅创建备份，不修复
cc-fix status           # 显示当前环境状态
```

---

## 5. 跨平台扩展预留

### 5.1 macOS 等价实现

| 修复项 | macOS 命令 | 权限要求 |
|---|---|---|
| 系统时区 | `sudo systemsetup -settimezone Asia/Shanghai` 或 `sudo ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime` | 管理员（sudo） |
| 系统语言 | `defaults write NSGlobalDomain AppleLanguages -array en-US` | 用户级（需注销生效） |
| 环境变量 | `launchctl setenv LANG en_US.UTF-8` 或写入 `~/.zshrc` / `~/.bash_profile` | 用户级 |
| Node.js locale | 同 Windows，通过环境变量 `LANG` / `LC_ALL` | 无 |
| 代理设置 | `networksetup -setwebproxy "Wi-Fi" proxy.example.com 8080` | 管理员（部分操作） |
| Hosts 文件 | `sudo tee -a /etc/hosts <<< "1.2.3.4 example.com"` + `sudo dscacheutil -flushcache` | 管理员（sudo） |

```typescript
// macOS 平台检测
function isMacOS(): boolean {
  return process.platform === 'darwin';
}

// macOS 时区设置
function setTimezoneMacOS(timezone: string): void {
  execSync(`sudo systemsetup -settimezone ${timezone}`);
}

// macOS 环境变量（持久化）
function setEnvMacOS(key: string, value: string): void {
  // 临时生效（当前 session）
  execSync(`launchctl setenv ${key} ${value}`);
  // 持久化（写入 shell profile）
  const shell = process.env.SHELL || '/bin/zsh';
  const profileFile = shell.includes('zsh') ? '~/.zshrc' : '~/.bash_profile';
  execSync(`echo 'export ${key}="${value}"' >> ${profileFile}`);
}
```

### 5.2 Linux 等价实现

| 修复项 | Linux 命令 | 权限要求 |
|---|---|---|
| 系统时区 | `sudo timedatectl set-timezone Asia/Shanghai` 或 `sudo ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime` | 管理员（sudo） |
| 系统语言 | `sudo localectl set-locale LANG=en_US.UTF-8` | 管理员（sudo） |
| 环境变量 | `export LANG=en_US.UTF-8` + 写入 `~/.bashrc` / `~/.profile` | 用户级 |
| Node.js locale | 同 Windows，通过环境变量 | 无 |
| 代理设置 | `export http_proxy=http://proxy:8080` + 写入 profile | 用户级 |
| Hosts 文件 | `sudo tee -a /etc/hosts <<< "1.2.3.4 example.com"` | 管理员（sudo） |

```typescript
// Linux 平台检测
function isLinux(): boolean {
  return process.platform === 'linux';
}

// Linux 时区设置
function setTimezoneLinux(timezone: string): void {
  execSync(`sudo timedatectl set-timezone ${timezone}`);
}

// Linux locale 设置
function setLocaleLinux(locale: string): void {
  // 确保 locale 已生成
  execSync(`sudo locale-gen ${locale}`, { stdio: 'pipe' });
  execSync(`sudo localectl set-locale LANG=${locale}`, { stdio: 'pipe' });
}

// Linux 环境变量（持久化）
function setEnvLinux(key: string, value: string): void {
  const profileFile = process.env.SHELL?.includes('zsh') 
    ? '~/.zshrc' 
    : '~/.bashrc';
  execSync(`echo 'export ${key}="${value}"' >> ${profileFile}`);
}
```

### 5.3 跨平台抽象层设计

```typescript
// platform-adapter.ts
interface PlatformAdapter {
  setTimezone(timezone: string): Promise<void>;
  setLocale(locale: string): Promise<void>;
  setEnvVar(key: string, value: string, scope: 'user' | 'system'): Promise<void>;
  setProxy(config: ProxyConfig): Promise<void>;
  editHosts(entries: HostEntry[]): Promise<void>;
  
  isAdmin(): boolean;
  getBackup(): Promise<BackupData>;
  rollback(backup: BackupData): Promise<void>;
}

// 工厂函数
function createAdapter(): PlatformAdapter {
  switch (process.platform) {
    case 'win32':
      return new WindowsAdapter();
    case 'darwin':
      return new MacOSAdapter();
    case 'linux':
      return new LinuxAdapter();
    default:
      throw new Error(`不支持的平台: ${process.platform}`);
  }
}
```

---

## 6. 综合建议

### 6.1 推荐修复优先级

| 优先级 | 修复项 | 理由 |
|---|---|---|
| P0（必做） | 环境变量（LANG, LC_ALL, TZ） | 低风险、无需管理员、效果显著 |
| P0（必做） | Node.js locale | 低风险、无权限要求、直接影响 Claude Code |
| P1（推荐） | 系统时区 | 低风险、需管理员、环境一致性重要 |
| P1（推荐） | 代理设置 | 中风险、影响网络出口 |
| P2（可选） | 系统语言（用户级） | 中风险、需注销生效 |
| P3（谨慎） | Hosts 文件 | 高风险、需管理员、非必要不修改 |

### 6.2 安全原则

1. **修复前必须备份**：任何修改前先保存当前状态
2. **最小权限原则**：能用用户级权限解决的，不要求管理员
3. **渐进式修复**：先做低风险项，高风险项需用户确认
4. **可回滚**：每项修复都必须支持回滚
5. **透明性**：所有修改操作必须记录日志，用户可查看

### 6.3 重启/生效要求汇总

| 修复项 | 当前终端 | 新终端 | 系统重启 |
|---|---|---|---|
| 环境变量（setx） | ❌ 不生效 | ✅ 生效 | - |
| 环境变量（process.env） | ✅ 立即 | ✅ 生效 | - |
| 时区（tzutil） | ❌ 不生效 | ✅ 生效 | - |
| 系统语言（HKCU） | ❌ 不生效 | ⚠️ 部分生效 | ✅ 完全生效 |
| 系统语言（系统级） | ❌ 不生效 | ❌ 不生效 | ✅ 完全生效 |
| 代理（环境变量） | ❌ 不生效 | ✅ 生效 | - |
| 代理（系统代理注册表） | ⚠️ 部分生效 | ✅ 生效 | - |
| Hosts 文件 | ⚠️ 需 flushdns | ✅ 生效 | - |
| Node.js locale | ✅ 立即（process.env） | ✅ 生效 | - |
