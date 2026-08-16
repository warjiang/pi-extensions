import assert from "node:assert/strict";
import test from "node:test";
import { createAgentPlanProvider, login } from "../extensions/index.ts";
import { fetchPlanModels, signPlanModelRequest } from "../extensions/models.ts";

function context(secretAccessKey = "secret-key") {
  return {
    credential: {
      type: "api_key" as const,
      key: "plan-key",
      env: {
        VOLCENGINE_ACCESS_KEY_ID: "access-key",
        VOLCENGINE_SECRET_ACCESS_KEY: secretAccessKey,
      },
    },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  };
}

test("login stores the inference key and model-catalog AK/SK", async () => {
  const answers = ["plan-key", "access-key", "secret-key"];
  const credential = await login({ prompt: async () => answers.shift() ?? "", notify() {} });
  assert.deepEqual(credential, {
    type: "api_key",
    key: "plan-key",
    env: {
      VOLCENGINE_ACCESS_KEY_ID: "access-key",
      VOLCENGINE_SECRET_ACCESS_KEY: "secret-key",
    },
  });
});

test("stored credentials take precedence over environment variables", async () => {
  const provider = createAgentPlanProvider();
  const auth = await provider.auth.apiKey!.resolve({
    credential: context().credential,
    signal: new AbortController().signal,
    ctx: { env: async () => "environment", fileExists: async () => false },
  });
  assert.equal(auth?.auth.apiKey, "plan-key");
  assert.equal(auth?.env?.VOLCENGINE_ACCESS_KEY_ID, "access-key");
  assert.equal(auth?.env?.VOLCENGINE_SECRET_ACCESS_KEY, "secret-key");
});

test("signs the official Agent Plan control-plane request", () => {
  const signed = signPlanModelRequest(
    "ListArkAgentPlanModel",
    "{}",
    "access-key",
    "secret-key",
    new Date("2026-06-02T08:55:37Z"),
  );
  assert.equal(signed.xDate, "20260602T085537Z");
  assert.match(signed.authorization, /Credential=access-key\/20260602\/cn-beijing\/ark\/request/);
  assert.doesNotMatch(signed.authorization, /secret-key/);
});

test("loads only model IDs returned by ListArkAgentPlanModel", async () => {
  let requestedUrl = "";
  const models = await fetchPlanModels(context(), async (url, init) => {
    requestedUrl = String(url);
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    return new Response(JSON.stringify({
      Result: {
        Datas: [
          { ModelID: "deepseek-v4-pro" },
          { ModelID: "new-agent-model" },
        ],
      },
    }));
  });
  assert.equal(
    requestedUrl,
    "https://ark.cn-beijing.volcengineapi.com/?Action=ListArkAgentPlanModel&Version=2024-01-01",
  );
  assert.deepEqual(models.map((model) => model.id), ["deepseek-v4-pro", "new-agent-model"]);
  assert.equal(models[0]?.provider, "volcengine-agent-plan");
  assert.equal(models[0]?.compat?.maxTokensField, "max_tokens");
  assert.equal(models[0]?.compat?.supportsDeveloperRole, false);
  assert.equal(models[0]?.thinkingLevelMap?.xhigh, "max");
});

test("accepts an empty official catalog", async () => {
  const models = await fetchPlanModels(
    context(),
    async () => new Response(JSON.stringify({ Result: { Datas: [] } })),
  );
  assert.deepEqual(models, []);
});

test("5xx, API errors and malformed responses expose no credentials", async () => {
  await assert.rejects(
    fetchPlanModels(context("super-secret"), async () => new Response("", { status: 503 })),
    (error: Error) => !error.message.includes("super-secret") && /503/.test(error.message),
  );
  await assert.rejects(
    fetchPlanModels(context(), async () => new Response(JSON.stringify({
      ResponseMetadata: { Error: { Code: "AccessDenied" } },
    }))),
    /AccessDenied/,
  );
  await assert.rejects(
    fetchPlanModels(context(), async () => new Response(JSON.stringify({ unexpected: true }))),
    /格式已变化/,
  );
});

test("provider registration exposes an empty dynamic provider", () => {
  const provider = createAgentPlanProvider();
  assert.equal(provider.id, "volcengine-agent-plan");
  assert.ok(provider.refreshModels);
});
