// IP 情报查询

import type { IpIntelligence } from "../detection/types.js";

export async function fetchIpIntelligence(): Promise<IpIntelligence | null> {
  try {
    const response = await fetch("https://ipinfo.io/json", {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      ip?: string;
      country?: string;
      region?: string;
      city?: string;
      org?: string;
      timezone?: string;
    };

    return {
      ip: data.ip ?? null,
      country: data.country ?? null,
      region: data.region ?? null,
      city: data.city ?? null,
      asn: data.org?.split(" ")[0] ?? null,
      org: data.org ?? null,
      timezone: data.timezone ?? null,
    };
  } catch {
    return null;
  }
}
