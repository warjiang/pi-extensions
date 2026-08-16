import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import {
  loginApp,
  loginUser,
  refreshUser,
  type ProviderDependencies,
} from "../extensions/providers.ts";
import type { AppCredentials } from "../extensions/credentials.ts";

function app(overrides: Partial<AppCredentials> = {}): AppCredentials {
  return {
    appId: "cli_test",
    appSecret: "secret",
    brand: "feishu",
    domains: ["calendar"],
    tenantScopes: ["calendar:calendar.event:create"],
    userScopes: ["calendar:calendar.event:read"],
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<ProviderDependencies> = {},
): ProviderDependencies {
  return {
    registerApp: async () => ({
      client_id: "cli_test",
      client_secret: "secret",
      user_info: { tenant_brand: "feishu" },
    }),
    exchangeTenantToken: async () => ({ token: "tat", expiresIn: 7200 }),
    queryAppScopes: async () => ({
      tenant: ["calendar:calendar.event:create"],
      user: ["calendar:calendar.event:read"],
    }),
    queryBotInfo: async () => ({ appName: "Pi Bot", openId: "ou_bot" }),
    requestDeviceAuthorization: async () => ({
      deviceCode: "device",
      userCode: "CODE",
      verificationUri: "https://verify",
      verificationUriComplete: "https://verify?code=CODE",
      expiresIn: 60,
      interval: 1,
    }),
    exchangeOAuthToken: async () => ({
      accessToken: "uat",
      refreshToken: "refresh",
      expiresIn: 10,
      refreshExpiresIn: 20,
      scope: "calendar:read",
    }),
    refreshOAuthToken: async () => ({
      accessToken: "uat-new",
      refreshToken: "refresh-new",
      expiresIn: 10,
      refreshExpiresIn: 20,
      scope: "calendar:read",
    }),
    readAppCredential: () => app(),
    now: () => 1_000,
    sleep: async () => {},
    ...overrides,
  };
}

function interaction(answers: string[], notifications: unknown[] = []): AuthInteraction {
  return {
    prompt: async () => answers.shift()!,
    notify: (notification) => notifications.push(notification),
    signal: new AbortController().signal,
  };
}

test("QR configuration allows selecting or creating an app with built-in common scopes", async () => {
  let options: Parameters<ProviderDependencies["registerApp"]>[0] | undefined;
  const notifications: unknown[] = [];
  const credential = await loginApp(
    interaction(["qr"], notifications),
    dependencies({
      registerApp: async (value) => {
        options = value;
        value.onQRCodeReady({ url: "https://qr", expireIn: 30 });
        value.onStatusChange?.({ status: "domain_switched" });
        return {
          client_id: "cli_lark",
          client_secret: "secret-lark",
          user_info: { tenant_brand: "lark" },
        };
      },
      queryAppScopes: async () => ({ tenant: [], user: [] }),
    }),
  );
  assert.equal(options?.createOnly, undefined);
  assert.equal(options?.appId, undefined);
  assert.equal(options?.addons?.preset, false);
  assert.ok(options?.addons?.scopes?.tenant?.includes("calendar:calendar.event:create"));
  assert.ok(options?.addons?.scopes?.user?.includes("docx:document:create"));
  assert.ok(options?.addons?.scopes?.user?.includes("drive:file:download"));
  assert.equal(credential.key, "secret-lark");
  assert.equal(credential.env?.PI_LARK_APP_ID, "cli_lark");
  assert.equal(credential.env?.PI_LARK_BRAND, "lark");
  assert.equal(JSON.stringify(notifications).includes("secret-lark"), false);
  assert.match(JSON.stringify(notifications), /calendar、docs、drive/);
  assert.match(JSON.stringify(notifications), /选择已有应用或新建应用/);
  assert.match(JSON.stringify(notifications), /缺少 tenant scopes/);
});

test("existing credentials require successful TAT exchange but tolerate scope-query failure", async () => {
  let verifiedSecret = "";
  const notifications: unknown[] = [];
  const credential = await loginApp(
    interaction(["manual", "feishu", "cli_existing", "existing-secret", "docs"], notifications),
    dependencies({
      exchangeTenantToken: async (_id, secret) => {
        verifiedSecret = secret;
        return { token: "tat", expiresIn: 10 };
      },
      queryAppScopes: async () => {
        throw new Error("scope endpoint unavailable");
      },
    }),
  );
  assert.equal(verifiedSecret, "existing-secret");
  assert.equal(credential.env?.PI_LARK_APP_ID, "cli_existing");
  assert.match(JSON.stringify(notifications), /凭据已验证/);

  await assert.rejects(
    loginApp(
      interaction(["manual", "feishu", "cli_bad", "bad-secret", ""]),
      dependencies({
        exchangeTenantToken: async () => {
          throw new Error("invalid credential");
        },
      }),
    ),
    /invalid credential/,
  );
});

test("user device OAuth handles pending and slow-down before storing app-bound tokens", async () => {
  let calls = 0;
  const waits: number[] = [];
  const credential = await loginUser(
    interaction([]),
    dependencies({
      sleep: async (ms) => {
        waits.push(ms);
      },
      exchangeOAuthToken: async () => {
        calls += 1;
        if (calls === 1) return { pending: true, slowDown: true };
        return {
          accessToken: "uat",
          refreshToken: "refresh",
          expiresIn: 10,
          refreshExpiresIn: 20,
          scope: "calendar:read",
        };
      },
    }),
  );
  assert.deepEqual(waits, [1_000, 6_000]);
  assert.equal(credential.app_id, "cli_test");
  assert.equal(credential.access, "uat");
  assert.equal(credential.expires, 11_000);
});

test("user OAuth expiry, cancellation, and App ID mismatch are rejected", async () => {
  const times = [0, 0, 1_001];
  await assert.rejects(
    loginUser(
      interaction([]),
      dependencies({
        now: () => times.shift() ?? 1_001,
        requestDeviceAuthorization: async () => ({
          deviceCode: "device",
          userCode: "CODE",
          verificationUri: "https://verify",
          verificationUriComplete: "https://verify",
          expiresIn: 1,
          interval: 1,
        }),
        exchangeOAuthToken: async () => ({ pending: true, slowDown: false }),
      }),
    ),
    /已过期/,
  );
  await assert.rejects(
    loginUser(
      interaction([]),
      dependencies({
        sleep: async () => {
          throw new Error("cancelled");
        },
      }),
    ),
    /cancelled/,
  );

  const credential = {
    type: "oauth",
    access: "uat",
    refresh: "refresh",
    expires: 1,
    app_id: "cli_old",
  } as OAuthCredential;
  await assert.rejects(
    refreshUser(credential, new AbortController().signal, dependencies()),
    /App ID 已改变/,
  );
});

test("refresh uses the current App Secret and rotates user tokens", async () => {
  let receivedSecret = "";
  const credential = {
    type: "oauth",
    access: "uat",
    refresh: "refresh",
    expires: 1,
    app_id: "cli_test",
  } as OAuthCredential;
  const refreshed = await refreshUser(
    credential,
    new AbortController().signal,
    dependencies({
      refreshOAuthToken: async (_id, secret) => {
        receivedSecret = secret;
        return {
          accessToken: "uat-new",
          refreshToken: "refresh-new",
          expiresIn: 10,
          refreshExpiresIn: 20,
          scope: "calendar:read",
        };
      },
    }),
  );
  assert.equal(receivedSecret, "secret");
  assert.equal(refreshed.access, "uat-new");
  assert.equal(refreshed.refresh, "refresh-new");
});
