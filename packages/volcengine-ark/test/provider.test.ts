import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  createVolcengineProvider,
  endpointIdFromDisplayId,
  endpointIdFromModel,
  login,
  migrateCachedModels,
} from "../extensions/index.ts";
import {
  displayModelId,
  endpointToModel,
  fetchEndpointModels,
  signListEndpoints,
} from "../extensions/models.ts";

test("login stores API key and AK/SK in one credential", async () => {
  const answers = ["api-key", "access-key", "secret-key"];
  const credential = await login({
    prompt: async () => answers.shift()!,
    notify() {},
  });
  assert.deepEqual(credential, {
    type: "api_key",
    key: "api-key",
    env: {
      VOLCENGINE_ACCESS_KEY_ID: "access-key",
      VOLCENGINE_SECRET_ACCESS_KEY: "secret-key",
    },
  });
  assert.equal(JSON.stringify(createVolcengineProvider()).includes("secret-key"), false);
});

test("signature is deterministic and does not contain secret", () => {
  const signed = signListEndpoints("{}", "AKID", "SECRET", new Date("2026-08-15T01:02:03Z"));
  assert.equal(signed.xDate, "20260815T010203Z");
  assert.equal(signed.xContentSha256.length, 64);
  assert.match(signed.authorization, /SignedHeaders=host;x-content-sha256;x-date/);
  assert.match(signed.authorization, /^HMAC-SHA256 Credential=AKID\//);
  assert.equal(signed.authorization.includes("SECRET"), false);
});

test("maps only running chat endpoints", () => {
  assert.equal(endpointToModel({ Id: "ep-bad", Status: "Stopped" }), undefined);
  assert.equal(endpointToModel({ Id: "ep-img", Status: "Running", Name: "Seedream image" }), undefined);
  const model = endpointToModel({
    Id: "ep-ok",
    Name: "DeepSeek endpoint",
    Status: "Running",
    ModelReference: { FoundationModel: { Name: "DeepSeek R1", ModelVersion: "v1" } },
    Metadata: { ContextWindow: 65536, MaxOutputTokens: 8192 },
  });
  assert.equal(model?.id, "deepseek-endpoint");
  assert.equal(model?.endpointId, "ep-ok");
  assert.equal(model?.name, "DeepSeek endpoint");
  assert.equal(model?.reasoning, true);
  assert.equal(model?.contextWindow, 65536);
});

test("uses a readable model id while preserving the upstream endpoint id", () => {
  assert.equal(displayModelId("DeepSeek V4 Pro", "ep-123"), "deepseek-v4-pro");
  assert.equal(displayModelId("豆包 Seed 2.1", "ep-456"), "豆包-seed-2.1");
  assert.equal(endpointIdFromDisplayId("deepseek-v4-pro@ep-123"), "ep-123");
  assert.equal(endpointIdFromDisplayId("ep-legacy"), "ep-legacy");
  assert.equal(endpointIdFromModel({
    id: "deepseek-v4-pro",
    endpointId: "ep-123",
  } as Model<"openai-completions"> & { endpointId: string }), "ep-123");
});

test("migrates legacy endpoint ids in the persisted catalog", () => {
  const stored = migrateCachedModels({
    checkedAt: 1,
    models: [{
      id: "ep-legacy",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      provider: "volcengine",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }],
  });
  assert.equal(stored?.models[0]?.id, "deepseek-v4-pro");
  assert.equal(
    (stored?.models[0] as Model<"openai-completions"> & { endpointId?: string })?.endpointId,
    "ep-legacy",
  );
});

test("paginates endpoints and treats empty list as valid", async () => {
  let calls = 0;
  const models = await fetchEndpointModels({
    credential: {
      type: "api_key",
      env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
    },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  }, async () => {
    calls += 1;
    return new Response(JSON.stringify({
      Result: {
        Items: calls === 1 ? [{ Id: "ep-1", Status: "Running" }] : [],
        TotalCount: 2,
      },
    }));
  });
  assert.equal(calls, 2);
  assert.deepEqual(models.map((model) => model.id), ["ark-endpoint"]);
});

test("auth errors are redacted", async () => {
  await assert.rejects(
    fetchEndpointModels({
      credential: {
        type: "api_key",
        env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "super-secret" },
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }, async () => new Response("no", { status: 403 })),
    (error: Error) => error.message.includes("super-secret") === false && /重新运行/.test(error.message),
  );
});

test("restores cached models without network access", async () => {
  const provider = createVolcengineProvider();
  let published = 0;
  await provider.refreshModels!({
    stored: {
      checkedAt: 1,
      models: [{
        id: "cached",
        name: "Cached",
        api: "openai-completions",
        provider: "volcengine",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1,
        maxTokens: 1,
      }],
    },
    allowNetwork: false,
    signal: new AbortController().signal,
    publish: async ({ update }) => {
      published += 1;
      update?.();
      return true;
    },
  });
  assert.equal(published, 1);
  assert.deepEqual(provider.getModels().map((model) => model.id), ["cached"]);
});
