import assert from "node:assert/strict";
import test from "node:test";
import { createAgentPlanProvider, login } from "../extensions/index.ts";
import { BASELINE_MODELS, fetchPlanModels, remoteToModel } from "../extensions/models.ts";

test("login and environment precedence", async () => {
  const credential = await login({ prompt: async () => "stored", notify() {} });
  assert.deepEqual(credential, { type: "api_key", key: "stored" });
  const provider = createAgentPlanProvider();
  const auth = await provider.auth.apiKey!.resolve({
    credential,
    signal: new AbortController().signal,
    ctx: { env: async () => "environment", fileExists: async () => false },
  });
  assert.equal(auth?.auth.apiKey, "stored");
});

test("baseline preserves Agent Plan compatibility", () => {
  const deepseek = BASELINE_MODELS.find((model) => model.id === "deepseek-v4-pro");
  assert.equal(deepseek?.compat?.maxTokensField, "max_tokens");
  assert.equal(deepseek?.compat?.supportsDeveloperRole, false);
  assert.equal(deepseek?.thinkingLevelMap?.xhigh, "max");
});

test("remote metadata overrides baseline", () => {
  const model = remoteToModel({
    id: "deepseek-v4-pro",
    name: "Remote DeepSeek",
    context_window: 123456,
    max_tokens: 65432,
  });
  assert.equal(model?.contextWindow, 123456);
  assert.equal(model?.maxTokens, 65432);
  assert.equal(model?.name, "Remote DeepSeek（Ark Agent Plan）");
});

test("filters non-chat and accepts empty remote catalog", async () => {
  assert.equal(remoteToModel({ id: "video-model", type: "video" }), undefined);
  const models = await fetchPlanModels({
    credential: { type: "api_key", key: "redacted" },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  }, async () => new Response(JSON.stringify({ data: [] })));
  assert.deepEqual(models, []);
});

test("5xx and malformed responses fail without exposing credentials", async () => {
  const context = {
    credential: { type: "api_key" as const, key: "super-secret" },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  };
  await assert.rejects(
    fetchPlanModels(context, async () => new Response("", { status: 503 })),
    (error: Error) => !error.message.includes("super-secret") && /503/.test(error.message),
  );
  await assert.rejects(
    fetchPlanModels(context, async () => new Response(JSON.stringify({ unexpected: true }))),
    /格式已变化/,
  );
});

test("provider registration exposes the independent provider id", () => {
  const provider = createAgentPlanProvider();
  assert.equal(provider.id, "volcengine-agent-plan");
  assert.ok(provider.refreshModels);
});
