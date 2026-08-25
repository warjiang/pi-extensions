import assert from "node:assert/strict";
import test from "node:test";
import { HttpRequestError } from "@volcengine/sdk-core";
import { createAgentPlanProvider, login } from "../extensions/index.ts";
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
        return {
          Result: {
            Datas: [
              { ModelID: "deepseek-v4-pro" },
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
