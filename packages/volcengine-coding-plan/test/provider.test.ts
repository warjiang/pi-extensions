import assert from "node:assert/strict";
import test from "node:test";
import { createCodingPlanProvider, login } from "../extensions/index.ts";
import { BASELINE_MODELS, fetchPlanModels, remoteToModel } from "../extensions/models.ts";

test("login and environment precedence", async () => {
  const credential = await login({ prompt: async () => "stored", notify() {} });
  assert.deepEqual(credential, { type: "api_key", key: "stored" });
  const provider = createCodingPlanProvider();
  const auth = await provider.auth.apiKey!.resolve({
    credential,
    signal: new AbortController().signal,
    ctx: { env: async () => "environment", fileExists: async () => false },
  });
  assert.equal(auth?.auth.apiKey, "stored");
});

test("has a usable static baseline", () => {
  assert.ok(BASELINE_MODELS.length >= 5);
  assert.equal(BASELINE_MODELS.every((model) => model.provider === "volcengine-coding-plan"), true);
});

test("parses chat models and filters non-chat models", () => {
  assert.equal(remoteToModel({ id: "embedding-v1", type: "embedding" }), undefined);
  const model = remoteToModel({
    id: "deepseek-v4-pro",
    name: "DeepSeek",
    token_limits: { context_window: 1000, max_output_token_length: 200 },
  });
  assert.equal(model?.reasoning, true);
  assert.equal(model?.contextWindow, 1000);
});

test("remote catalog replaces baseline and accepts empty list", async () => {
  const context = {
    credential: { type: "api_key" as const, key: "redacted" },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  };
  const remote = await fetchPlanModels(context, async () =>
    new Response(JSON.stringify({ data: [{ id: "remote-chat", name: "Remote" }] })));
  assert.deepEqual(remote.map((model) => model.id), ["remote-chat"]);
  const empty = await fetchPlanModels(context, async () =>
    new Response(JSON.stringify({ data: [] })));
  assert.deepEqual(empty, []);
});

test("401 and malformed JSON errors never expose key", async () => {
  const context = {
    credential: { type: "api_key" as const, key: "super-secret" },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  };
  await assert.rejects(
    fetchPlanModels(context, async () => new Response("", { status: 401 })),
    (error: Error) => !error.message.includes("super-secret") && /重新运行/.test(error.message),
  );
  await assert.rejects(
    fetchPlanModels(context, async () => new Response("{")),
    /畸形 JSON/,
  );
});

test("honors an already aborted Pi signal", async () => {
  const controller = new AbortController();
  controller.abort();
  let sawAbortedSignal = false;
  await assert.rejects(fetchPlanModels({
    credential: { type: "api_key", key: "redacted" },
    allowNetwork: true,
    signal: controller.signal,
    publish: async () => true,
  }, async (_url, init) => {
    sawAbortedSignal = init?.signal?.aborted ?? false;
    throw init?.signal?.reason;
  }), /abort/i);
  assert.equal(sawAbortedSignal, true);
});
