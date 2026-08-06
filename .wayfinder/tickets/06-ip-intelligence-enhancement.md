# Ticket 06: IP 情报增强方案

## Question

CLI 端如何实现多源 IP 对比和住宅/数据中心判断？

## ✅ 决议

### 多源对比
- 并行查询 ip-api.com + ipinfo.io（已有两个源）
- 对比返回的 country 和 ASN 是否一致
- 不一致 → 风险加分 +15（与 checkcc.org 一致）
- 显示"多源一致性"信号

### 住宅/数据中心判断
- 维护常见云厂商 ASN 前缀清单（硬编码）：
  - AWS: AS16509, AS14618
  - Azure: AS8075
  - GCP: AS15169, AS396982
  - Cloudflare: AS13335
  - DigitalOcean: AS14061
  - 阿里云: AS37963
  - 腾讯云: AS45090
- ASN 命中清单 → "数据中心 IP" → 风险加分 +13
- 未命中 → "住宅/普通 ISP" → 低风险

### 新增 IpIntelligence 字段
```typescript
ipType: "residential" | "datacenter" | "unknown"
multiSourceConsistent: boolean
sourceCount: number
```
