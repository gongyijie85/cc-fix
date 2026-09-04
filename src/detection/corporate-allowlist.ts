// 企业办公网络白名单 — 挂VPN时避免把公司出口误判为高风险
// 读取优先级：%APPDATA%\cc-fix\corporate-allowlist.json > CC_FIX_CORPORATE_ALLOWLIST（仅绝对路径）> 模块相对仓库模板 > 内置默认
// 仅影响 ip-datacenter 与 consistency 的 IP 分支，时区/语言等系统信号不受影响（保持 SPEC reminder-only）
// issue #91：不再从 process.cwd() 解析候选路径——从不可信目录（下载/克隆仓库）启动时，
// 预置的同名文件会被静默采纳并压制风险信号，伪造"安全"结论。仓库模板只接受模块相对
// 位置（源码/vitest 布局），发布产物需显式 env 或 %APPDATA% 配置。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CorporateAllowlist = {
  allowCidrs: string[];
  allowAsns: string[];
};

let cache: CorporateAllowlist | null | undefined;

function normalizeAsn(asn: string): string | null {
  const m = asn.toUpperCase().match(/AS\d+/);
  return m ? m[0] : null;
}

function expandCidr(cidr: string): string { return cidr.trim(); }

async function loadAllowlist(): Promise<CorporateAllowlist | null> {
  if(cache !== undefined) return cache;
  const candidates: string[] = [];
  if(process.env.APPDATA){
    candidates.push(path.join(process.env.APPDATA, "cc-fix", "corporate-allowlist.json"));
  }
  // 显式绝对路径覆盖（发布产物/桥接场景；拒绝相对路径，避免不可信 CWD 预置）
  const fromEnv = process.env.CC_FIX_CORPORATE_ALLOWLIST;
  if(typeof fromEnv === "string" && fromEnv.length > 0 && path.isAbsolute(fromEnv)){
    candidates.push(fromEnv);
  }
  try {
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    // 仓库内通用模板（开源方案，仅源码/vitest 布局可达；勿在此引入 cwd/相对解析）
    candidates.push(path.resolve(selfDir, "../../vpn-anthropic-coexist/src/ccfix-bridge/allowlist.json"));
  } catch {}

  for(const p of candidates){
    try {
      const raw = await readFile(p, "utf8");
      const j = JSON.parse(raw) as { allowCidrs?: string[]; allowAsns?: string[] };
      const allowCidrs = (j.allowCidrs ?? []).map(expandCidr).filter(Boolean);
      const allowAsns = (j.allowAsns ?? []).map(a=>normalizeAsn(a) ?? "").filter(Boolean);
      cache = { allowCidrs, allowAsns };
      return cache;
    } catch { /* try next */ }
  }
  // 内置最小集（与 vpn-anthropic-coexist 默认一致）
  cache = { allowCidrs: ["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"], allowAsns: [] };
  return cache;
}

export function resetCorporateAllowlistCache(){ cache = undefined; }

export async function isCorporateAsn(asn: string | null): Promise<boolean> {
  if(!asn) return false;
  const list = await loadAllowlist();
  if(!list) return false;
  const n = normalizeAsn(asn);
  if(!n) return false;
  return list.allowAsns.includes(n);
}

// 简易 CIDR 匹配（仅 IPv4，IPv6 走 ASN 判定）
export async function isCorporateIp(ip: string | null): Promise<boolean> {
  if(!ip) return false;
  if(ip.includes(":")) return false; // IPv6 走 ASN
  const list = await loadAllowlist();
  if(!list || list.allowCidrs.length===0) return false;
  // 将 ip 转 32位
  const parts = ip.split(".").map(Number);
  if(parts.length!==4 || parts.some(n=>Number.isNaN(n)||n<0||n>255)) return false;
  const ipNum = ((parts[0]!<<24)>>>0) + ((parts[1]!<<16)>>>0) + ((parts[2]!<<8)>>>0) + (parts[3]!>>>0);
  for(const cidr of list.allowCidrs){
    const [base, bitsStr] = cidr.split("/");
    if(!base || !bitsStr) continue;
    const bits = Number(bitsStr);
    if(bits<0||bits>32) continue;
    const bParts = base.split(".").map(Number);
    if(bParts.length!==4) continue;
    const baseNum = ((bParts[0]!<<24)>>>0) + ((bParts[1]!<<16)>>>0) + ((bParts[2]!<<8)>>>0) + (bParts[3]!>>>0);
    const mask = bits===0?0:(0xFFFFFFFF << (32-bits))>>>0;
    if((ipNum & mask) === (baseNum & mask)) return true;
  }
  return false;
}
