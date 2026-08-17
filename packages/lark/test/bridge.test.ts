import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import {
  BRIDGE_OPEN_GROUP_SCOPE,
  bridgeAddons,
  bridgeBootstrapAddons,
  diffBridgePermissions,
  hasBridgePermissionDiff,
} from "../extensions/bridge-permissions.ts";
import {
  APPLICATION_SELF_MANAGE_SCOPE,
  isAppManagementPermissionError,
} from "../extensions/lark-api.ts";
import {
  createPairing,
  capBridgeLog,
  defaultBridgeConfig,
  defaultBridgeState,
  isAuthorized,
  verifyPairing,
} from "../extensions/bridge-store.ts";
import {
  conversationKey,
  shouldTriggerGroup,
} from "../extensions/bridge-runtime.ts";
import { bridgeDaemonSpawnSpec } from "../extensions/bridge-daemon.ts";
import {
  compactLauncherUrl,
  QR_IMAGE_MAX_HEIGHT_CELLS,
  QR_IMAGE_MAX_WIDTH_CELLS,
  renderQrPngBase64,
} from "../extensions/bridge-qr.ts";

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_1",
    content: "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    ...overrides,
  };
}

test("bridge permission snapshot stays separate and open policy adds full group messages", () => {
  const addons = bridgeAddons("mention");
  assert.equal(addons.preset, false);
  assert.ok(addons.scopes.tenant.includes(APPLICATION_SELF_MANAGE_SCOPE));
  assert.ok(addons.scopes.tenant.includes("cardkit:card:write"));
  assert.equal(addons.scopes.tenant.includes(BRIDGE_OPEN_GROUP_SCOPE), false);
  assert.ok(addons.events.items.tenant.includes("im.message.receive_v1"));
  assert.deepEqual(addons.callbacks.items, ["card.action.trigger"]);

  const diff = diffBridgePermissions({
    tenant: [...addons.scopes.tenant],
    user: [],
    events: [...addons.events.items.tenant],
    callbacks: [...addons.callbacks.items],
    subscriptionType: "websocket",
    callbackType: "websocket",
    botCapability: true,
  }, "open");
  assert.deepEqual(diff.tenantScopes, [BRIDGE_OPEN_GROUP_SCOPE]);
  assert.equal(hasBridgePermissionDiff(diff), true);

  assert.deepEqual(bridgeBootstrapAddons(), {
    preset: false,
    scopes: { tenant: [APPLICATION_SELF_MANAGE_SCOPE] },
  });
});

test("application self-management permission errors are recognized for bootstrap", () => {
  assert.equal(isAppManagementPermissionError(
    new Error("Access denied: application:application:self_manage"),
  ), true);
  assert.equal(isAppManagementPermissionError(
    new Error("Access denied: admin:app.info:readonly"),
  ), true);
  assert.equal(isAppManagementPermissionError(new Error("network timeout")), false);
});

test("QR image renderer produces a PNG for size-constrained TUI display", async () => {
  const png = await renderQrPngBase64(
    "https://open.feishu.cn/page/launcher?user_code=TEST",
  );
  assert.equal(Buffer.from(png, "base64").subarray(1, 4).toString(), "PNG");
  assert.equal(QR_IMAGE_MAX_WIDTH_CELLS, 24);
  assert.equal(QR_IMAGE_MAX_HEIGHT_CELLS, 12);
});

test("launcher QR drops SDK tracking parameters but keeps authorization data", () => {
  const original =
    "https://open.feishu.cn/page/launcher?user_code=TEST&from=sdk&source=node-sdk%2Fpi-lark-bridge&tp=sdk&addons=ENCODED&clientID=cli_test";
  const compact = compactLauncherUrl(original);
  const url = new URL(compact);
  assert.equal(url.searchParams.get("user_code"), "TEST");
  assert.equal(url.searchParams.get("addons"), "ENCODED");
  assert.equal(url.searchParams.get("clientID"), "cli_test");
  assert.equal(url.searchParams.has("from"), false);
  assert.equal(url.searchParams.has("source"), false);
  assert.equal(url.searchParams.has("tp"), false);
  assert.ok(compact.length < original.length);
});

test("launcher QR compaction leaves unrelated and malformed URLs unchanged", () => {
  assert.equal(
    compactLauncherUrl("https://example.com/page/launcher?from=sdk"),
    "https://example.com/page/launcher?from=sdk",
  );
  assert.equal(compactLauncherUrl("not a URL"), "not a URL");
});

test("pairing stores only a salted hash and expires", () => {
  const { code, pairing } = createPairing(1_000, 500);
  assert.equal(JSON.stringify(pairing).includes(code), false);
  assert.equal(verifyPairing(pairing, code.toLowerCase(), 1_499), true);
  assert.equal(verifyPairing(pairing, "BAD-CODE", 1_499), false);
  assert.equal(verifyPairing(pairing, code, 1_501), false);
});

test("owner and allowlist access are explicit", () => {
  const state = defaultBridgeState("cli_test");
  state.ownerOpenId = "ou_owner";
  state.allowedOpenIds.push("ou_allowed");
  assert.equal(isAuthorized(state, "ou_owner"), true);
  assert.equal(isAuthorized(state, "ou_allowed"), true);
  assert.equal(isAuthorized(state, "ou_other"), false);
});

test("conversation keys distinguish p2p, groups and topics", () => {
  assert.equal(conversationKey(message({ chatType: "p2p" })), "p2p:oc_1");
  assert.equal(conversationKey(message()), "group:oc_1");
  assert.equal(conversationKey(message({ threadId: "omt_1" }), true), "topic:oc_1:omt_1");
  assert.equal(conversationKey(message({ rootId: "om_root" }), true), "topic:oc_1:om_root");
});

test("group trigger accepts mention, keyword and bot reply but rejects mention-all", () => {
  const config = {
    groupPolicy: "mention" as const,
    groupKeywords: ["pi:"],
    groupAlsoOnReply: true,
  };
  assert.equal(shouldTriggerGroup(message({ mentionedBot: true }), config, []), true);
  assert.equal(shouldTriggerGroup(message({ content: "pi: help" }), config, []), true);
  assert.equal(shouldTriggerGroup(message({ replyToMessageId: "om_bot" }), config, ["om_bot"]), true);
  assert.equal(shouldTriggerGroup(message({ mentionedBot: true, mentionAll: true }), config, []), false);
  assert.equal(shouldTriggerGroup(message(), config, []), false);
});

test("daemon spawn uses array argv, child recursion guard and scrubs Lark credentials", () => {
  const spec = bridgeDaemonSpawnSpec({
    SAFE: "ok",
    LARKSUITE_CLI_APP_SECRET: "top-secret",
    LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "tat",
  }, "/pkg/extensions/bridge-daemon.ts");
  assert.deepEqual(spec.args, [
    "--experimental-strip-types",
    "/pkg/extensions/bridge-daemon.ts",
    "--daemon",
  ]);
  assert.equal(spec.detached, true);
  assert.equal(spec.env.SAFE, "ok");
  assert.equal(spec.env.PI_LARK_BRIDGE_CHILD_SESSION, "1");
  assert.equal(spec.env.LARKSUITE_CLI_APP_SECRET, undefined);
  assert.equal(JSON.stringify(spec).includes("top-secret"), false);
});

test("default bridge config contains no secret and is conservative", () => {
  const config = defaultBridgeConfig("cli_test", "feishu", "/tmp/work");
  assert.equal(config.autostart, false);
  assert.equal(config.groupPolicy, "mention");
  assert.deepEqual(config.groupKeywords, []);
  assert.equal(config.groupAlsoOnReply, true);
  assert.equal(JSON.stringify(config).toLowerCase().includes("secret"), false);
});

test("bridge logs are capped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-lark-bridge-"));
  const path = join(directory, "daemon.log");
  try {
    await writeFile(path, "x".repeat(32));
    await capBridgeLog(path, 8);
    assert.equal((await stat(path)).size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
