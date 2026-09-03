$ErrorActionPreference='Stop'
Set-StrictMode -Off
# Local: RT-BE86U 192.168.50.1 / FortiClient / Clash SG->US fix

Write-Host "== RT-BE86U local fix ==" -F Cyan

# 1. Current egress IP
Write-Host "`n[1] Current egress IP" -F Yellow
try {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $ip = Invoke-RestMethod "https://ipwho.is/?fields=country_code,ip,connection" -TimeoutSec 5
  $cc = $ip.country_code; $addr = $ip.ip; $asn = if($ip.connection){ $ip.connection.asn } else { "" }
  Write-Host ("  {0} {1} {2}" -f $addr,$cc,$asn)
  if($cc -eq "SG"){ Write-Host "  -> Current SG datacenter, switch to NYC residential" -F Yellow }
} catch { Write-Host "  Query failed $_" -F Red }

# 2. Local Clash config patch
$clashPath = "D:\new project\clash_config.yaml"
if(Test-Path -LiteralPath $clashPath){
  $content = Get-Content -LiteralPath $clashPath -Raw -ErrorAction SilentlyContinue
  if($content -notmatch "Anthropic"){
    Write-Host "`n[2] Patch local Clash $clashPath" -F Yellow
    $patch = @"

# --- vpn-anthropic-coexist LOCAL BEGIN ---
proxy-groups:
  - name: "Anthropic"
    type: select
    proxies: [Mobile-NYC-Residential01, Telecom-NYC-Residential02r, Mobile-AI-01, DIRECT]
# Manually move these 4 rules to top of rules: (before geosite:cn)
# - DOMAIN-SUFFIX,anthropic.com,Anthropic
# - DOMAIN-SUFFIX,claude.ai,Anthropic
# - DOMAIN-KEYWORD,anthropic,Anthropic
# - DOMAIN-SUFFIX,ipwho.is,DIRECT
# --- LOCAL END ---
"@
    Add-Content -LiteralPath $clashPath -Value $patch -Encoding utf8
    Write-Host "  Added Anthropic group (move 4 rules to top manually)" -F Green
  } else { Write-Host "`n[2] Local Clash already has Anthropic" -F Green }
}

# 3. NRPT split (admin)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if($isAdmin){
  Write-Host "`n[3] Configure NRPT split" -F Yellow
  try {
    Import-Module DnsClient -ErrorAction SilentlyContinue
    if(Get-Command Get-DnsClientNrptPolicy -ErrorAction SilentlyContinue){
      Get-DnsClientNrptPolicy -ErrorAction SilentlyContinue | Where-Object Comment -like "ccfix-*" | ForEach-Object { Remove-DnsClientNrptPolicy -InputObject $_ -Force -ErrorAction SilentlyContinue }
      Add-DnsClientNrptPolicy -Namespace ".anthropic.com" -NameServers @("1.1.1.1","8.8.8.8") -Comment "ccfix-anthropic" -ErrorAction Stop
      Add-DnsClientNrptPolicy -Namespace ".claude.ai" -NameServers @("1.1.1.1","8.8.8.8") -Comment "ccfix-anthropic" -ErrorAction Stop
      Write-Host "  NRPT written" -F Green
      Get-DnsClientNrptPolicy | Where-Object Comment -like "ccfix-*" | Format-Table Namespace,NameServers -AutoSize | Out-String | Write-Host
    } else {
      Write-Host "  NRPT cmdlet not available (Windows Home), skipping. Use manual hosts or router DNS." -F Yellow
    }
  } catch { Write-Host "  NRPT failed: $_" -F Red }

  Write-Host "`n[4] Adjust interface metrics" -F Yellow
  try {
    Set-NetIPInterface -InterfaceAlias "Realtek Gaming 2.5GbE Family Controller #2" -InterfaceMetric 20 -ErrorAction SilentlyContinue
    Set-NetIPInterface -InterfaceAlias "Fortinet SSL VPN Virtual Ethernet Adapter" -InterfaceMetric 35 -ErrorAction SilentlyContinue
    Set-NetIPInterface -InterfaceAlias "Fortinet Virtual Ethernet Adapter (NDIS 6.30)" -InterfaceMetric 35 -ErrorAction SilentlyContinue
    Write-Host "  Metrics: Realtek=20 < Fortinet=35" -F Green
  } catch { Write-Host "  Metric adjust failed: $_" -F Yellow }
  Get-NetIPInterface | Where-Object { $_.InterfaceAlias -like "*Realtek*" -or $_.InterfaceAlias -like "*Fortinet*" } | Format-Table InterfaceAlias,InterfaceMetric,ConnectionState -AutoSize | Out-String | Write-Host
} else {
  Write-Host "`n[3-4] Skip NRPT/metrics (not admin)" -F Yellow
}

# 5. Router hint
Write-Host "`n[5] Router RT-BE86U 192.168.50.1" -F Yellow
Write-Host "  Login http://192.168.50.1 -> MerlinClash -> import vpn-anthropic-coexist/src/split-template/clash-anthropic.yaml"
Write-Host "  Or SSH: sh /jffs/vpn-anthropic-coexist/merlinclash_patch.sh"
Write-Host "  Keep fake-ip 198.18.0.1/16 and geosite:cn DIRECT" -F Gray

# 6. CC-Fix recheck
Write-Host "`n[6] CC-Fix recheck" -F Yellow
try {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $raw = & node "$PSScriptRoot/../../dist/index.js" check --json 2>$null
  $joined = $raw -join "`n"
  $out = $joined | ConvertFrom-Json
  Write-Host ("  score={0} risk={1} ip={2} {3}" -f $out.score,$out.riskLevel,$out.ipIntelligence.country,$out.ipIntelligence.asn)
  if($out.score -ge 21){ Write-Host "  Still >21, switch MerlinClash Anthropic group to NYC residential and retest" -F Red } else { Write-Host "  Now low, keep" -F Green }
} catch { Write-Host "  cc-fix check failed $_" -F Yellow }

Write-Host "`nDone. Reconnect FortiClient and rerun if still high (use -Revert to rollback)" -F Cyan
