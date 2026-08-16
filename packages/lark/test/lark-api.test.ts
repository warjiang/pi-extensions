import assert from "node:assert/strict";
import test from "node:test";
import {
  exchangeOAuthToken,
  exchangeTenantToken,
  queryBotInfo,
  queryAppScopes,
  refreshOAuthToken,
  requestDeviceAuthorization,
  revokeOAuthToken,
} from "../extensions/lark-api.ts";

test("exchanges and validates a tenant token without exposing the secret", async () => {
  let requestBody = "";
  const token = await exchangeTenantToken("cli_test", "top-secret", "feishu", undefined, async (
    input,
    init,
  ) => {
    assert.equal(
      String(input),
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    );
    requestBody = String(init?.body);
    return new Response(JSON.stringify({
      code: 0,
      tenant_access_token: "tat",
      expire: 100,
    }));
  });
  assert.deepEqual(token, { token: "tat", expiresIn: 100 });
  assert.match(requestBody, /top-secret/);

  await assert.rejects(
    exchangeTenantToken("cli_test", "top-secret", "lark", undefined, async () =>
      new Response(JSON.stringify({ code: 10003, msg: "invalid credential" }), { status: 400 })),
    (error: unknown) => {
      assert.match(String(error), /invalid credential/);
      assert.equal(String(error).includes("top-secret"), false);
      return true;
    },
  );
});

test("queries actual tenant and user scopes", async () => {
  const result = await queryAppScopes("cli/a", "tat", "lark", undefined, async (input, init) => {
    assert.match(String(input), /applications\/cli%2Fa\?lang=zh_cn$/);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tat");
    return new Response(JSON.stringify({
      code: 0,
      data: {
        app: {
          scopes: [
            { scope: "tenant:a", token_types: ["tenant"] },
            { scope: "both", token_types: ["tenant", "user"] },
            { scope: "user:a", token_types: ["user"] },
          ],
        },
      },
    }));
  });
  assert.deepEqual(result, {
    tenant: ["both", "tenant:a"],
    user: ["both", "user:a"],
  });
});

test("queries chat Bot status as a separate non-blocking probe", async () => {
  const bot = await queryBotInfo("tat", "feishu", undefined, async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tat");
    return new Response(JSON.stringify({
      code: 0,
      bot: { app_name: "Pi Bot", open_id: "ou_bot" },
    }));
  });
  assert.deepEqual(bot, { appName: "Pi Bot", openId: "ou_bot" });
});

test("device OAuth requests offline access and handles pending, slow-down, and refresh", async () => {
  const device = await requestDeviceAuthorization(
    "cli_test",
    "secret",
    "feishu",
    ["calendar:read", "calendar:read"],
    undefined,
    async (_input, init) => {
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        `Basic ${Buffer.from("cli_test:secret").toString("base64")}`,
      );
      assert.equal(String(init?.body), "client_id=cli_test&scope=calendar%3Aread+offline_access");
      return new Response(JSON.stringify({
        device_code: "device",
        user_code: "ABCD",
        verification_uri: "https://accounts.example/verify",
        expires_in: 30,
        interval: 2,
      }));
    },
  );
  assert.equal(device.verificationUriComplete, "https://accounts.example/verify");

  const pending = await exchangeOAuthToken(
    "feishu",
    new URLSearchParams(),
    undefined,
    async () => new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
  );
  assert.deepEqual(pending, { pending: true, slowDown: false });
  const slow = await exchangeOAuthToken(
    "feishu",
    new URLSearchParams(),
    undefined,
    async () => new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }),
  );
  assert.deepEqual(slow, { pending: true, slowDown: true });

  const refreshed = await refreshOAuthToken(
    "cli_test",
    "secret",
    "refresh-old",
    "lark",
    undefined,
    async (input, init) => {
      assert.equal(String(input), "https://open.larksuite.com/open-apis/authen/v2/oauth/token");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        grant_type: "refresh_token",
        refresh_token: "refresh-old",
        client_id: "cli_test",
        client_secret: "secret",
      });
      return new Response(JSON.stringify({
        code: 0,
        access_token: "uat-new",
        refresh_token: "refresh-new",
        expires_in: 10,
        refresh_token_expires_in: 20,
        scope: "calendar:read",
      }));
    },
  );
  assert.equal(refreshed.accessToken, "uat-new");
  assert.equal(refreshed.refreshToken, "refresh-new");

  await revokeOAuthToken("refresh-new", "lark", undefined, async (input, init) => {
    assert.equal(String(input), "https://accounts.larksuite.com/oauth/v1/revoke");
    assert.equal(String(init?.body), "token=refresh-new");
    return new Response(JSON.stringify({ code: 0 }));
  });
  await assert.rejects(
    exchangeOAuthToken(
      "feishu",
      new URLSearchParams(),
      undefined,
      async () => new Response(JSON.stringify({
        error: "access_denied",
        error_description: "user denied",
      }), { status: 400 }),
    ),
    /user denied/,
  );
});
