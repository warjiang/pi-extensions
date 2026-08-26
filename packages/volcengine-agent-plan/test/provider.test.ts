import assert from "node:assert/strict";
import test from "node:test";
import { HttpRequestError } from "@volcengine/sdk-core";
import {
  createAgentPlanProvider,
  login,
  migrateCachedModels,
} from "../extensions/index.ts";
import { modelFromId, resolveModelMetadata } from "../extensions/model-manifest.ts";
import {
  fetchPlanModels,
  ListArkAgentPlanModelCommand,
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

test("loads only model IDs returned by ListArkAgentPlanModel", async () => {
  const factory: PlanModelClientFactory = (credentials) => {
    assert.deepEqual(credentials, {
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    });
    return {
      async send(command, options) {
        assert.ok(command instanceof ListArkAgentPlanModelCommand);
        assert.deepEqual(command.input, {});
        assert.equal(
          ListArkAgentPlanModelCommand.metaPath,
          "/ListArkAgentPlanModel/2024-01-01/ark/post/application_json/",
        );
        assert.equal(options.abortSignal.aborted, false);
        assert.equal(options.timeout, 15_000);
        return {
          Result: {
            Datas: [
              { ModelID: "" },
              { ModelID: "deepseek-v4-pro" },
              { ModelID: " deepseek-v4-pro " },
              { ModelID: "new-agent-model" },
            ],
          },
        };
      },
    };
  };
  const models = await fetchPlanModels(context(), factory);
  assert.deepEqual(models.map((model) => model.id), ["deepseek-v4-pro", "new-agent-model"]);
  assert.equal(models[0]?.provider, "volcengine-agent-plan");
  assert.equal(models[0]?.compat?.maxTokensField, "max_tokens");
  assert.equal(models[0]?.compat?.supportsDeveloperRole, false);
  assert.equal(models[0]?.thinkingLevelMap?.xhigh, "max");
});

test("manifest metadata controls Agent capabilities and xhigh", () => {
  assert.equal(
    resolveModelMetadata("volcengine:DeepSeek V4 Pro")?.id,
    "deepseek-v4-pro",
  );
  const known = modelFromId("deepseek-v4-pro");
  assert.equal(known.reasoning, true);
  assert.equal(known.thinkingLevelMap?.xhigh, "max");
  assert.equal(known.compat?.maxTokensField, "max_tokens");
  assert.equal(known.compat?.supportsDeveloperRole, false);

  const unknown = modelFromId("future-agent-model");
  assert.equal(unknown.contextWindow, 128_000);
  assert.equal(unknown.maxTokens, 16_384);
  assert.equal(unknown.reasoning, true);
  assert.deepEqual(unknown.thinkingLevelMap, { minimal: null });
  assert.deepEqual(unknown.input, ["text"]);
});

test("refreshes Agent metadata in persisted models", () => {
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

test("5xx, API errors and malformed responses expose no credentials", async () => {
  await assert.rejects(
    fetchPlanModels(context("super-secret"), () => ({
      async send() { throw new HttpRequestError("ApiException", "SDK error", 503); },
    })),
    (error: Error) => !error.message.includes("super-secret") && /503/.test(error.message),
  );
  await assert.rejects(
    fetchPlanModels(context(), () => ({
      async send() {
        throw new HttpRequestError("ApiException", "SDK error", undefined, {
          ResponseMetadata: { Error: { Code: "AccessDenied" } },
        });
      },
    })),
    /AccessDenied/,
  );
  await assert.rejects(
    fetchPlanModels(context(), () => ({ async send() { return { Result: {} }; } })),
    /格式已变化/,
  );
});

test("skips the client when networking is disabled and forwards cancellation", async () => {
  let created = false;
  assert.deepEqual(await fetchPlanModels(
    { ...context(), allowNetwork: false },
    () => { created = true; throw new Error("unexpected"); },
  ), []);
  assert.equal(created, false);

  const controller = new AbortController();
  controller.abort();
  const reason = controller.signal.reason;
  await assert.rejects(fetchPlanModels(
    { ...context(), signal: controller.signal },
    () => ({ async send(_command, options) {
      assert.equal(options.abortSignal.aborted, true);
      throw new HttpRequestError("Exception", "HTTP request failed: canceled");
    } }),
  ), (error) => error === reason);
});

test("provider registration exposes an empty dynamic provider", () => {
  const provider = createAgentPlanProvider();
  assert.equal(provider.id, "volcengine-agent-plan");
  assert.ok(provider.refreshModels);
});
