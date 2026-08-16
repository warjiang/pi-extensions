import assert from "node:assert/strict";
import test from "node:test";
import { createCodingPlanProvider, login } from "../extensions/index.ts";
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
  const provider = createCodingPlanProvider();
  const auth = await provider.auth.apiKey!.resolve({
    credential: context().credential,
    signal: new AbortController().signal,
    ctx: { env: async () => "environment", fileExists: async () => false },
  });
  assert.equal(auth?.auth.apiKey, "plan-key");
  assert.equal(auth?.env?.VOLCENGINE_ACCESS_KEY_ID, "access-key");
  assert.equal(auth?.env?.VOLCENGINE_SECRET_ACCESS_KEY, "secret-key");
});

test("signs the official Coding Plan control-plane request", () => {
  const signed = signPlanModelRequest(
    "ListArkCodingPlanModel",
    "{}",
    "access-key",
    "secret-key",
    new Date("2026-06-02T08:55:37Z"),
  );
  assert.equal(signed.xDate, "20260602T085537Z");
  assert.match(signed.authorization, /Credential=access-key\/20260602\/cn-beijing\/ark\/request/);
  assert.doesNotMatch(signed.authorization, /secret-key/);
});

test("loads only model IDs returned by ListArkCodingPlanModel", async () => {
  let requestedUrl = "";
  const models = await fetchPlanModels(context(), async (url, init) => {
    requestedUrl = String(url);
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    assert.match(String(new Headers(init?.headers).get("authorization")), /^HMAC-SHA256 /);
    return new Response(JSON.stringify({
      Result: {
        Datas: [
          { ModelID: "doubao-seed-2.0-code" },
          { ModelID: "new-coding-model" },
        ],
      },
    }));
  });
  assert.equal(
    requestedUrl,
    "https://ark.cn-beijing.volcengineapi.com/?Action=ListArkCodingPlanModel&Version=2024-01-01",
  );
  assert.deepEqual(models.map((model) => model.id), ["doubao-seed-2.0-code", "new-coding-model"]);
  assert.equal(models[0]?.provider, "volcengine-coding-plan");
});

test("accepts an empty official catalog", async () => {
  const models = await fetchPlanModels(
    context(),
    async () => new Response(JSON.stringify({ Result: { Datas: [] } })),
  );
  assert.deepEqual(models, []);
});

test("missing credentials, auth failures and malformed responses expose no secrets", async () => {
  await assert.rejects(
    fetchPlanModels({
      credential: { type: "api_key", key: "plan-key" },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }),
    /Access Key.*Secret Key/,
  );
  await assert.rejects(
    fetchPlanModels(context("super-secret"), async () => new Response("", { status: 403 })),
    (error: Error) => !error.message.includes("super-secret") && /重新运行/.test(error.message),
  );
  await assert.rejects(
    fetchPlanModels(context(), async () => new Response(JSON.stringify({ unexpected: true }))),
    /格式已变化/,
  );
  await assert.rejects(
    fetchPlanModels(context(), async () => new Response("{")),
    /畸形 JSON/,
  );
});

test("honors an already aborted Pi signal", async () => {
  const controller = new AbortController();
  controller.abort();
  let sawAbortedSignal = false;
  await assert.rejects(fetchPlanModels({
    ...context(),
    signal: controller.signal,
  }, async (_url, init) => {
    sawAbortedSignal = init?.signal?.aborted ?? false;
    throw init?.signal?.reason;
  }), /abort/i);
  assert.equal(sawAbortedSignal, true);
});
