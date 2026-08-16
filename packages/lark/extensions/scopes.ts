import snapshot from "../snapshots/permissions-1.0.87.json" with { type: "json" };

export interface DomainScopes {
  tenant: string[];
  user: string[];
}

export const PERMISSION_SNAPSHOT_VERSION = "1.0.87";
export const DOMAIN_SCOPES = snapshot as Record<string, DomainScopes>;
export const AUTH_DOMAINS = Object.keys(DOMAIN_SCOPES).sort();
export const DEFAULT_QR_DOMAINS = ["calendar", "docs", "drive"];

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function normalizeDomains(input: string): string[] {
  const values = input.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  const unknown = values.filter((value) => !(value in DOMAIN_SCOPES));
  if (unknown.length > 0) {
    throw new Error(`未知领域：${unknown.join(", ")}。可选：${AUTH_DOMAINS.join(", ")}`);
  }
  return uniqueSorted(values);
}

export function scopesForDomains(domains: string[]): DomainScopes {
  return {
    tenant: uniqueSorted(domains.flatMap((domain) => DOMAIN_SCOPES[domain]?.tenant ?? [])),
    user: uniqueSorted(domains.flatMap((domain) => DOMAIN_SCOPES[domain]?.user ?? [])),
  };
}

export function missingScopes(requested: string[], granted: string[]): string[] {
  const actual = new Set(granted);
  return requested.filter((scope) => !actual.has(scope));
}
