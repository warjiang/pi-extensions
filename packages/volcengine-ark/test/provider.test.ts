import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ARKClient, ListEndpointsCommand } from "@volcengine/ark";
import volcengineArk, {
  createVolcengineProvider,
  endpointIdFromDisplayId,
  endpointIdFromModel,
  login,
  migrateCachedModels,
} from "../extensions/index.ts";
import {
  builtInEndpointToModel,
  builtInEndpointToMediaModel,
  classifyEndpoint,
  displayModelId,
  endpointToMediaModel,
  endpointToModel,
  fetchEndpointModels,
  getCachedMediaModels,
  InnerDescribeModelEndpointsCommand,
} from "../extensions/models.ts";

function mockArkClient(send: (command: object) => Promise<unknown>): ARKClient {
  const client = new ARKClient({ accessKeyId: "ak", secretAccessKey: "sk" });
  Object.defineProperty(client, "send", { value: send });
  return client;
}

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

test("registers chat provider, media tools and media commands in one extension", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  let providers = 0;
  volcengineArk({
    registerProvider() {
      providers += 1;
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
  } as unknown as ExtensionAPI);
  assert.equal(providers, 1);
  assert.deepEqual(tools, ["generate_image", "generate_video", "get_video_task"]);
  assert.deepEqual(commands, ["media-models", "media-refresh"]);
});

test("defines the unsupported built-in endpoint API as an SDK command", () => {
  const command = new InnerDescribeModelEndpointsCommand({
    PageNumber: 2,
    PageSize: 100,
  });

  assert.equal(
    InnerDescribeModelEndpointsCommand.metaPath,
    "/InnerDescribeModelEndpoints/2024-01-01/ark/post/application_json/",
  );
  assert.deepEqual(command.input, {
    PageNumber: 2,
    PageSize: 100,
  });
  assert.equal(command.requestConfig?.serviceName, "ark");
  assert.equal(command.requestConfig?.method, "POST");
});

test("maps only running chat endpoints", () => {
  assert.equal(endpointToModel({ Id: "ep-bad", Status: "Stopped" }), undefined);
  assert.equal(endpointToModel({
    Id: "ep-img",
    Status: "Running",
    ModelReference: { FoundationModel: { Name: "Seedream image" } },
  }), undefined);
  assert.equal(
    endpointToModel({ Id: "ep-custom", Status: "Running", Name: "My image assistant" })?.id,
    "my-image-assistant",
  );
  const model = endpointToModel({
    Id: "ep-ok",
    Name: "DeepSeek endpoint",
    Status: "Running",
    ModelReference: { FoundationModel: { Name: "DeepSeek R1", ModelVersion: "v1" } },
  });
  assert.equal(model?.id, "deepseek-endpoint");
  assert.equal(model?.endpointId, "ep-ok");
  assert.equal(model?.name, "DeepSeek endpoint");
  assert.equal(model?.reasoning, true);
  assert.equal(model?.contextWindow, 128_000);
});

test("classifies and preserves image and video inference ids", () => {
  const builtInImage = {
    Id: "doubao-seedream-5-0-260128",
    Name: "Seedream 5.0",
    Status: "Running",
    ModelReference: { FoundationModel: { Name: "Seedream image generation" } },
  };
  const customVideo = {
    Id: "ep-video",
    Name: "Product animation",
    Status: "Running",
    EndpointModelType: "video",
  };
  assert.equal(classifyEndpoint(builtInImage), "image");
  assert.equal(classifyEndpoint(customVideo), "video");
  assert.deepEqual(builtInEndpointToMediaModel(builtInImage), {
    inferenceId: "doubao-seedream-5-0-260128",
    name: "Seedream 5.0",
    kind: "image",
    source: "built-in",
  });
  assert.deepEqual(endpointToMediaModel(customVideo), {
    inferenceId: "ep-video",
    name: "Product animation",
    kind: "video",
    source: "custom",
  });
  assert.equal(endpointToModel(customVideo), undefined);
  assert.equal(
    classifyEndpoint({ Id: "ep-chat", Name: "My image assistant", Status: "Running" }),
    "chat",
  );
});

test("maps built-in endpoints with Id as the inference model", () => {
  assert.equal(builtInEndpointToModel({
    Id: "doubao-seedream-4-0",
    Status: "Running",
    ModelReference: { FoundationModel: { Name: "Seedream image" } },
  }), undefined);
  const model = builtInEndpointToModel({
    Id: "deepseek-v4-flash-ga-260731",
    Name: "DeepSeek V4 Flash",
    Status: "Running",
    ModelReference: { FoundationModel: { Name: "DeepSeek V4 Flash" } },
  });
  assert.equal(model?.id, "deepseek-v4-flash-ga-260731");
  assert.equal(model?.name, "DeepSeek V4 Flash");
  assert.equal(model?.reasoning, true);
  assert.equal(endpointIdFromModel(model!), "deepseek-v4-flash-ga-260731");
  assert.equal("endpointId" in model!, false);
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

test("maps SDK endpoint catalogs and treats an empty built-in list as valid", async () => {
  let customCalls = 0;
  const client = mockArkClient(async (command) => {
    if (command instanceof InnerDescribeModelEndpointsCommand) {
      return { Result: { Items: [] } };
    }
    assert.ok(command instanceof ListEndpointsCommand);
    customCalls += 1;
    return { Result: { Items: [{ Id: "ep-1", Status: "Running" }] } };
  });
  const models = await fetchEndpointModels({
    credential: {
      type: "api_key",
      env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
    },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  }, client);
  assert.equal(customCalls, 1);
  assert.deepEqual(models.map((model) => model.id), ["ark-endpoint"]);
});

test("keeps separate custom endpoints for the same model", async () => {
  let builtInCalls = 0;
  let customCalls = 0;
  const client = mockArkClient(async (command) => {
    if (command instanceof InnerDescribeModelEndpointsCommand) {
      builtInCalls += 1;
      return {
        Result: {
          Items: [{
            Id: "deepseek-v4",
            Name: "DeepSeek V4 built-in",
            Status: "Running",
          }],
        },
      };
    }
    assert.ok(command instanceof ListEndpointsCommand);
    customCalls += 1;
    return {
      Result: {
        Items: [
          { Id: "ep-default-aaa", Name: "DeepSeek V4", Status: "Running" },
          { Id: "ep-project-b-bbb", Name: "DeepSeek V4", Status: "Running" },
        ],
      },
    };
  });
  const models = await fetchEndpointModels({
    credential: {
      type: "api_key",
      env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
    },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  }, client);
  assert.equal(builtInCalls, 1);
  assert.equal(customCalls, 1);
  assert.deepEqual(models.map((model) => model.id), [
    "deepseek-v4",
    "deepseek-v4-aaa",
    "deepseek-v4-bbb",
  ]);
  assert.deepEqual(
    models.slice(1).map(
      (model) => (model as Model<"openai-completions"> & { endpointId: string }).endpointId,
    ),
    ["ep-default-aaa", "ep-project-b-bbb"],
  );
});

test("keeps media models in a separate catalog while publishing chat models only", async () => {
  const client = mockArkClient(async (command) => {
    if (command instanceof InnerDescribeModelEndpointsCommand) {
      return {
        Result: {
          Items: [
            { Id: "chat-model", Name: "Chat", Status: "Running" },
            {
              Id: "doubao-seedream-5-0-260128",
              Name: "Seedream",
              Status: "Running",
              EndpointModelType: "image",
            },
          ],
        },
      };
    }
    assert.ok(command instanceof ListEndpointsCommand);
    return {
      Result: {
        Items: [{
          Id: "ep-video",
          Name: "Seedance endpoint",
          Status: "Running",
          EndpointModelType: "video",
        }],
      },
    };
  });
  const models = await fetchEndpointModels({
    credential: {
      type: "api_key",
      env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
    },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  }, client);
  assert.deepEqual(models.map((model) => model.id), ["chat-model"]);
  assert.deepEqual(getCachedMediaModels(), [
    {
      inferenceId: "doubao-seedream-5-0-260128",
      name: "Seedream",
      kind: "image",
      source: "built-in",
    },
    {
      inferenceId: "ep-video",
      name: "Seedance endpoint",
      kind: "video",
      source: "custom",
    },
  ]);
});

test("auth errors are redacted", async () => {
  const client = mockArkClient(async (command) => {
    if (command instanceof InnerDescribeModelEndpointsCommand) {
      throw new Error("AccessDenied");
    }
    return { Result: { Items: [] } };
  });
  await assert.rejects(
    fetchEndpointModels({
      credential: {
        type: "api_key",
        env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "super-secret" },
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }, client),
    (error: Error) => error.message.includes("super-secret") === false && /AccessDenied/.test(error.message),
  );
});

test("preserves SDK cancellation errors", async () => {
  const controller = new AbortController();
  controller.abort();
  const sdkError = new Error("SDK cancellation wrapper");
  const client = mockArkClient(async () => {
    throw sdkError;
  });

  await assert.rejects(fetchEndpointModels({
    credential: {
      type: "api_key",
      env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
    },
    allowNetwork: true,
    signal: controller.signal,
    publish: async () => true,
  }, client), (error) => error === sdkError);
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
