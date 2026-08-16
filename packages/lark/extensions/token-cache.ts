import { createHash } from "node:crypto";
import type { LarkBrand } from "./constants.ts";
import { exchangeTenantToken, type TenantToken } from "./lark-api.ts";

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class TenantTokenCache {
  private readonly cache = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<CachedToken>>();
  private readonly exchange: (
    appId: string,
    appSecret: string,
    brand: LarkBrand,
    signal?: AbortSignal,
  ) => Promise<TenantToken>;
  private readonly now: () => number;

  constructor(
    exchange: (
      appId: string,
      appSecret: string,
      brand: LarkBrand,
      signal?: AbortSignal,
    ) => Promise<TenantToken> = exchangeTenantToken,
    now: () => number = Date.now,
  ) {
    this.exchange = exchange;
    this.now = now;
  }

  async get(appId: string, appSecret: string, brand: LarkBrand, signal?: AbortSignal): Promise<string> {
    const secretFingerprint = createHash("sha256").update(appSecret).digest("base64url");
    const key = `${brand}:${appId}:${secretFingerprint}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now() + 60_000) return cached.token;

    let request = this.pending.get(key);
    if (!request) {
      request = this.exchange(appId, appSecret, brand, signal).then((result) => {
        const value = {
          token: result.token,
          expiresAt: this.now() + Math.max(1, result.expiresIn) * 1000,
        };
        this.cache.set(key, value);
        return value;
      }).finally(() => {
        this.pending.delete(key);
      });
      this.pending.set(key, request);
    }
    return (await request).token;
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
  }
}
