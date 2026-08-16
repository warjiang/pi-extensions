import assert from "node:assert/strict";
import test from "node:test";
import { TenantTokenCache } from "../extensions/token-cache.ts";

test("tenant token cache is single-flight and refreshes near expiry", async () => {
  let now = 1_000;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cache = new TenantTokenCache(async () => {
    calls += 1;
    await gate;
    return { token: `tat-${calls}`, expiresIn: 120 };
  }, () => now);

  const first = cache.get("cli", "secret", "feishu");
  const second = cache.get("cli", "secret", "feishu");
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["tat-1", "tat-1"]);
  assert.equal(await cache.get("cli", "secret", "feishu"), "tat-1");

  now += 61_000;
  assert.equal(await cache.get("cli", "secret", "feishu"), "tat-2");
  assert.equal(calls, 2);
});

test("failed token exchanges are not cached", async () => {
  let calls = 0;
  const cache = new TenantTokenCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary");
    return { token: "tat", expiresIn: 120 };
  });
  await assert.rejects(cache.get("cli", "secret", "lark"), /temporary/);
  assert.equal(await cache.get("cli", "secret", "lark"), "tat");
});

test("rotating an App Secret cannot reuse the previous cached token", async () => {
  let calls = 0;
  const cache = new TenantTokenCache(async () => ({
    token: `tat-${++calls}`,
    expiresIn: 120,
  }));
  assert.equal(await cache.get("cli", "secret-a", "feishu"), "tat-1");
  assert.equal(await cache.get("cli", "secret-b", "feishu"), "tat-2");
});
