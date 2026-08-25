import assert from "node:assert/strict";
import test from "node:test";
import { HttpRequestError } from "@volcengine/sdk-core";
import { createCodingPlanProvider, login } from "../extensions/index.ts";
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
        return {
          Result: {
            Datas: [
              { ModelID: "doubao-seed-2.0-code" },
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
