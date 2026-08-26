import assert from "node:assert/strict";
import test from "node:test";
import { HttpRequestError } from "@volcengine/sdk-core";
import {
  createCodingPlanProvider,
  login,
  migrateCachedModels,
} from "../extensions/index.ts";
import { modelFromId, resolveModelMetadata } from "../extensions/model-manifest.ts";
import {
  fetchPlanModels,
  ListArkCodingPlanModelCommand,
  type PlanModelClientFactory,
} from "../extensions/models.ts";

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

test("loads only model IDs returned by ListArkCodingPlanModel", async () => {
  const factory: PlanModelClientFactory = (credentials) => {
    assert.deepEqual(credentials, {
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    });
    return {
      async send(command, options) {
        assert.ok(command instanceof ListArkCodingPlanModelCommand);
        assert.deepEqual(command.input, {});
        assert.equal(
          ListArkCodingPlanModelCommand.metaPath,
          "/ListArkCodingPlanModel/2024-01-01/ark/post/application_json/",
        );
        assert.equal(options.abortSignal.aborted, false);
        assert.equal(options.timeout, 15_000);
        return {
          Result: {
            Datas: [
              { ModelID: " " },
              { ModelID: "doubao-seed-2.0-code" },
              { ModelID: " doubao-seed-2.0-code " },
              { ModelID: "new-coding-model" },
            ],
          },
        };
      },
    };
  };
  const models = await fetchPlanModels(context(), factory);
  assert.deepEqual(models.map((model) => model.id), ["doubao-seed-2.0-code", "new-coding-model"]);
  assert.equal(models[0]?.provider, "volcengine-coding-plan");
});

test("manifest metadata and conservative unknown fallback are applied", () => {
  assert.equal(
    resolveModelMetadata("Volcengine/Doubao Seed 2.1 Turbo")?.id,
    "doubao-seed-2-1-turbo",
  );
  const known = modelFromId("doubao-seed-2-1-turbo");
  assert.equal(known.contextWindow, 256_000);
  assert.equal(known.maxTokens, 256_000);
  assert.deepEqual(known.input, ["text", "image"]);
  assert.equal(known.reasoning, true);
  assert.deepEqual(known.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });

  const unknown = modelFromId("future-coding-model");
  assert.equal(unknown.contextWindow, 128_000);
  assert.equal(unknown.maxTokens, 16_384);
  assert.deepEqual(unknown.input, ["text"]);
  assert.equal(unknown.reasoning, false);
});

test("refreshes metadata in persisted models without changing IDs", () => {
  const stored = {
    checkedAt: 1,
    models: [{
      ...modelFromId("doubao-seed-2-1-turbo"),
      contextWindow: 1,
      maxTokens: 1,
      reasoning: false,
    }],
  };
  const migrated = migrateCachedModels(stored);
  assert.equal(migrated?.models[0]?.id, "doubao-seed-2-1-turbo");
  assert.equal(migrated?.models[0]?.contextWindow, 256_000);
  assert.equal(migrated?.models[0]?.maxTokens, 256_000);
  assert.equal(migrated?.models[0]?.reasoning, true);
});

test("accepts an empty official catalog", async () => {
  const models = await fetchPlanModels(
    context(),
    () => ({ async send() { return { Result: { Datas: [] } }; } }),
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
    fetchPlanModels(context("super-secret"), () => ({
      async send() { throw new HttpRequestError("ApiException", "SDK error", 403); },
    })),
    (error: Error) => !error.message.includes("super-secret") && /重新运行/.test(error.message),
  );
  await assert.rejects(
    fetchPlanModels(context(), () => ({ async send() { return { Result: {} }; } })),
    /格式已变化/,
  );
});

test("honors an already aborted Pi signal", async () => {
  const controller = new AbortController();
  controller.abort();
  let sawAbortedSignal = false;
  await assert.rejects(fetchPlanModels({
    ...context(),
    signal: controller.signal,
  }, () => ({ async send(_command, options) {
    sawAbortedSignal = options.abortSignal.aborted;
    throw new HttpRequestError("Exception", "HTTP request failed: canceled");
  } })), /abort/i);
  assert.equal(sawAbortedSignal, true);
});

test("does not construct a client when networking is disabled", async () => {
  let created = false;
  const models = await fetchPlanModels(
    { ...context(), allowNetwork: false },
    () => { created = true; throw new Error("unexpected"); },
  );
  assert.deepEqual(models, []);
  assert.equal(created, false);
});
