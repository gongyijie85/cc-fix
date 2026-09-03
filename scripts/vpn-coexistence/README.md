# 本机 VPN 共存脚本

- `local-rt-be86u.ps1` — 针对 **RT-BE86U 192.168.50.1 + FortiClient + Clash 纽约住宅** 的一键修复
- 依赖：`vpn-anthropic-coexist/src/...` 通用模板

## 使用

```powershell
# 预览
.\vpn-anthropic-coexist\src\detect.ps1

# 本机一键（管理员）
powershell -ExecutionPolicy Bypass -File scripts\vpn-coexistence\local-rt-be86u.ps1
```

## 回滚

```powershell
vpn-anthropic-coexist\src\split-template\route-add.ps1 -Revert
Get-DnsClientNrptPolicy | ? Comment -like "ccfix-*" | Remove-DnsClientNrptPolicy -Force
```
