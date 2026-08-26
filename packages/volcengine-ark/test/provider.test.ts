import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ARKClient,
  ListEndpointsCommand,
} from "@volcengine/ark";
import volcengineArk, {
  createVolcengineProvider,
  endpointIdFromDisplayId,
  endpointIdFromModel,
  login,
  migrateCachedModels,
} from "../extensions/index.ts";
import {
  builtInEndpointToModel,
  customEndpointToModel,
  cachedMediaModels,
  displayModelId,
  fetchEndpointModels,
  InnerDescribeModelEndpointsCommand,
} from "../extensions/models.ts";
import {
  getModelManifest,
  normalizeModelKey,
  resolveModelMetadata,
} from "../extensions/model-manifest.ts";

async function withMockArkClient<T>(
  send: (command: object) => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const prototype = ARKClient.prototype as unknown as {
    send: (command: object) => Promise<unknown>;
  };
  const originalSend = prototype.send;
  prototype.send = send;
  try {
    return await run();
  } finally {
    prototype.send = originalSend;
  }
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

test("stored credentials take precedence over environment variables", async () => {
  const auth = await createVolcengineProvider().auth.apiKey!.resolve({
    credential: {
      type: "api_key",
      key: "api-key",
      env: {
        VOLCENGINE_ACCESS_KEY_ID: "access-key",
        VOLCENGINE_SECRET_ACCESS_KEY: "secret-key",
      },
    },
    signal: new AbortController().signal,
    ctx: { env: async () => "environment", fileExists: async () => false },
  });
  assert.equal(auth?.auth.apiKey, "api-key");
  assert.equal(auth?.env?.VOLCENGINE_ACCESS_KEY_ID, "access-key");
  assert.equal(auth?.env?.VOLCENGINE_SECRET_ACCESS_KEY, "secret-key");
});

test("environment variables do not replace stored credentials", async () => {
  const provider = createVolcengineProvider();
  const values: Record<string, string> = {
    VOLCENGINE_ACCESS_KEY_ID: "environment-access-key",
    VOLCENGINE_SECRET_ACCESS_KEY: "environment-secret-key",
  };
  const auth = await provider.auth.apiKey!.resolve({
    signal: new AbortController().signal,
    ctx: { env: async (name) => values[name], fileExists: async () => false },
  });
  assert.equal(auth, undefined);
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
  assert.deepEqual(commands, [
    "media-models",
    "media-image-model",
    "media-video-model",
    "media-dir",
    "media-refresh",
  ]);
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
  assert.equal(customEndpointToModel({ Id: "ep-bad", Status: "Stopped" }), undefined);
  assert.equal(customEndpointToModel({
    Id: "ep-img",
    Status: "Running",
    EndpointModelType: "image",
  }), undefined);
  assert.equal(
    customEndpointToModel({
      Id: "ep-custom",
      Status: "Running",
      Name: "My image assistant",
    })?.id,
    "my-image-assistant",
  );
  const model = customEndpointToModel({
    Id: "ep-ok",
    Name: "DeepSeek endpoint",
    Status: "Running",
    ModelReference: {
      FoundationModel: { Name: "DeepSeek V3.2", ModelVersion: "251201" },
    },
  });
  assert.equal(model?.id, "deepseek-v3.2");
  assert.equal(model?.endpointId, "ep-ok");
  assert.equal(model?.name, "DeepSeek-V3.2");
  assert.equal(model?.reasoning, true);
  assert.equal(
    model?.contextWindow,
    getModelManifest().models["deepseek-v3-2-251201"]?.maxInputTokens,
  );
  assert.equal(model?.maxTokens, 32_768);
});

test("classifies and preserves image and video inference ids", () => {
  const builtInImage = {
    Id: "doubao-seedream-5-0-260128",
    Name: "Seedream 5.0",
    Status: "Running",
    EndpointModelType: "image",
    ModelReference: { FoundationModel: { Name: "Seedream" } },
  };
  const customVideo = {
    Id: "ep-video",
    Name: "Product animation",
    Status: "Running",
    EndpointModelType: "video",
  };
  const imageMetadata = resolveModelMetadata(builtInImage);
  const videoMetadata = resolveModelMetadata(customVideo);
  assert.equal(imageMetadata.kind, "image");
  assert.equal(videoMetadata.kind, "video");
  assert.equal(customEndpointToModel(customVideo), undefined);
  assert.equal(builtInEndpointToModel({
    Id: "doubao-seedance-2-5",
    Name: "doubao-seedance-2-5",
    Status: "Running",
  }), undefined);
  assert.equal(customEndpointToModel({
    Id: "ep-seedream",
    Name: "doubao-seedream-5-0",
    Status: "Running",
    ModelReference: {
      FoundationModel: { Name: "doubao-seedream-5-0" },
    },
  }), undefined);
  assert.ok(customEndpointToModel({
    Id: "ep-chat",
    Name: "My image assistant",
    Status: "Running",
  }));
});

test("maps built-in endpoints with Id as the inference model", () => {
  assert.equal(builtInEndpointToModel({
    Id: "doubao-seedream-4-0",
    Status: "Running",
    EndpointModelType: "image",
  }), undefined);
  const model = builtInEndpointToModel({
    Id: "deepseek-v3-2-251201",
    Name: "DeepSeek V3.2",
    Status: "Running",
  });
  assert.equal(model?.id, "deepseek-v3-2-251201");
  assert.equal(model?.name, "DeepSeek-V3.2");
  assert.equal(model?.reasoning, true);
  assert.equal(endpointIdFromModel(model!), "deepseek-v3-2-251201");
  assert.equal("endpointId" in model!, false);

  const endpointModel = builtInEndpointToModel({
    Id: "ep-m-20260312223546-mlbfc",
    Name: "ep-m-20260312223546-mlbfc",
    Status: "Running",
    ModelReference: {
      FoundationModel: { Name: "DeepSeek V3.2", ModelVersion: "251201" },
    },
  });
  assert.equal(endpointModel?.id, "deepseek-v3.2");
  assert.equal(endpointModel?.name, "DeepSeek-V3.2");
  assert.equal(endpointIdFromModel(endpointModel!), "ep-m-20260312223546-mlbfc");
});

test("normalizes only provider prefixes, case and separators for manifest matching", () => {
  assert.equal(
    normalizeModelKey("Volcengine/Doubao_Seed 2.0-Pro-260215"),
    "doubao-seed-2-0-pro-260215",
  );
  assert.equal(
    normalizeModelKey("DeepSeek-V4-Pro正式版"),
    "deepseek-v4-pro正式版",
  );
  assert.equal(
    resolveModelMetadata({
      Id: "VOLCENGINE/Doubao_Seed-2.0-Pro-260215",
    }).manifestId,
    "doubao-seed-2-0-pro-260215",
  );
});

test("matches manifest data through endpoint id and referenced version", () => {
  const byEndpoint = resolveModelMetadata({
    Id: "doubao-seed-2-0-pro-260215",
  });
  const byReferencedVersion = resolveModelMetadata({
    Id: "ep-version",
    ModelReference: {
      FoundationModel: {
        Name: "Doubao Seed 2.0 Pro",
        ModelVersion: "260215",
      },
    },
  });

  assert.equal(byEndpoint.manifestId, "doubao-seed-2-0-pro-260215");
  assert.equal(byReferencedVersion.manifestId, "doubao-seed-2-0-pro-260215");
});

test("matches a manifest model by its Ark display name", () => {
  const model = builtInEndpointToModel({
    Id: "ep-deepseek-v4-pro",
    Name: "DeepSeek-V4-Pro正式版",
    Status: "Running",
  });

  assert.equal(model?.name, "DeepSeek-V4-Pro正式版");
  assert.equal(
    model?.contextWindow,
    getModelManifest().models["deepseek-v4-pro-ga-260813"]?.maxInputTokens,
  );
  assert.equal(model?.maxTokens, 384_000);
});

test("uses the generated Seed Evolving context window metadata", () => {
  const model = builtInEndpointToModel({
    Id: "doubao-seed-evolving",
    Name: "Doubao-Seed-Evolving",
    Status: "Running",
  });

  assert.equal(
    model?.contextWindow,
    getModelManifest().models["doubao-seed-evolving-latest-version"]?.maxInputTokens,
  );
  assert.equal(model?.contextWindow, 1_048_576);
});

test("uses LiteLLM for chat capabilities and pricing", () => {
  const metadata = resolveModelMetadata({
    Id: "ep-pro",
    ModelReference: {
      FoundationModel: {
        Name: "Doubao Seed 2.0 Pro",
        ModelVersion: "260215",
      },
    },
  });
  const model = builtInEndpointToModel({
    Id: "ep-pro",
    Status: "Running",
    ModelReference: {
      FoundationModel: {
        Name: "Doubao Seed 2.0 Pro",
        ModelVersion: "260215",
      },
    },
  });

  assert.equal(metadata.kind, "chat");
  assert.equal(
    model?.contextWindow,
    getModelManifest().models["doubao-seed-2-0-pro-260215"]?.maxInputTokens,
  );
  assert.equal(model?.maxTokens, 128_000);
  assert.equal(model?.reasoning, true);
  assert.deepEqual(model?.input, ["text", "image"]);
  assert.deepEqual(model?.cost, {
    input: 0.46,
    output: 2.3,
    cacheRead: 0,
    cacheWrite: 0,
    tiers: [
      {
        inputTokensAbove: 32_000,
        input: 0.7,
        output: 3.5,
        cacheRead: 0,
        cacheWrite: 0,
      },
      {
        inputTokensAbove: 128_000,
        input: 1.4,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ],
  });
});

test("uses conservative defaults when LiteLLM has no matching model", () => {
  const model = builtInEndpointToModel({
    Id: "future-model",
    Name: "Reasoning vision image assistant",
    Status: "Running",
  });
  assert.equal(model?.reasoning, false);
  assert.deepEqual(model?.input, ["text"]);
  assert.equal(model?.contextWindow, 128_000);
  assert.equal(model?.maxTokens, 16_384);
  assert.deepEqual(model?.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("does not publish manifest embedding models as chat models", () => {
  const metadata = resolveModelMetadata({ Id: "doubao-embedding" });
  assert.equal(metadata.kind, "other");
  assert.equal(builtInEndpointToModel({
    Id: "doubao-embedding",
    Status: "Running",
  }), undefined);
});

test("ships a normalized, unique model manifest snapshot", () => {
  const snapshot = getModelManifest();
  const keys = Object.keys(snapshot.models);
  assert.equal(snapshot.source.repository, "BerriAI/litellm");
  assert.match(snapshot.source.commit, /^[0-9a-f]{40}$/);
  assert.ok(keys.length > 0);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(keys.every((key) => key === normalizeModelKey(key)));
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

test("migrates legacy endpoint ids in the persisted model cache", () => {
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

test("refreshes persisted model capabilities from the current manifest", () => {
  const stored = migrateCachedModels({
    checkedAt: 1,
    models: [{
      id: "deepseek-v4-pro-260425",
      name: "DeepSeek-V4-pro",
      api: "openai-completions",
      provider: "volcengine",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }],
  });
  const model = stored?.models[0];
  assert.equal(model?.contextWindow, 1_048_576);
  assert.equal(model?.maxTokens, 384_000);
  assert.equal(model?.reasoning, true);
});

test("removes endpoint suffixes and duplicate models from the persisted cache", () => {
  const base: Omit<Model<"openai-completions">, "id" | "name"> = {
    api: "openai-completions",
    provider: "volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const stored = migrateCachedModels({
    checkedAt: 1,
    models: [
      {
        ...base,
        id: "doubao-seed-code",
        name: "Doubao Seed Code",
        endpointId: "ep-first",
      } as Model<"openai-completions"> & { endpointId: string },
      {
        ...base,
        id: "doubao-seed-code-wtdvx",
        name: "Doubao Seed Code",
        endpointId: "ep-second-wtdvx",
      } as Model<"openai-completions"> & { endpointId: string },
    ],
  });
  assert.deepEqual(stored?.models.map((model) => model.id), ["doubao-seed-code"]);
  assert.equal(endpointIdFromModel(stored!.models[0]!), "ep-first");
});

test("maps SDK endpoint responses and treats an empty built-in list as valid", async () => {
  let customCalls = 0;
  const models = await withMockArkClient(async (command) => {
    if (command instanceof InnerDescribeModelEndpointsCommand) {
      return { Result: { Items: [] } };
    }
    assert.ok(command instanceof ListEndpointsCommand);
    customCalls += 1;
    return { Result: { Items: [{ Id: "ep-1", Status: "Running" }] } };
  }, () => fetchEndpointModels({
      credential: {
        type: "api_key",
        env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }));
  assert.equal(customCalls, 1);
  assert.deepEqual(models.map((model) => model.id), ["ark-endpoint"]);
});

test("prefers a built-in model over duplicate custom endpoints", async () => {
  let builtInCalls = 0;
  let customCalls = 0;
  const models = await withMockArkClient(async (command) => {
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
  }, () => fetchEndpointModels({
      credential: {
        type: "api_key",
        env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }));
  assert.equal(builtInCalls, 1);
  assert.equal(customCalls, 1);
  assert.deepEqual(models.map((model) => model.id), ["deepseek-v4"]);
});

test("collapses duplicate custom endpoints into one model", async () => {
  const models = await withMockArkClient(async (command) => {
    if (command instanceof InnerDescribeModelEndpointsCommand) {
      return { Result: { Items: [] } };
    }
    assert.ok(command instanceof ListEndpointsCommand);
    return {
      Result: {
        Items: [
          { Id: "ep-first", Name: "Doubao Seed Code", Status: "Running" },
          { Id: "ep-second-wtdvx", Name: "Doubao Seed Code", Status: "Running" },
        ],
      },
    };
  }, () => fetchEndpointModels({
      credential: {
        type: "api_key",
        env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }));
  assert.deepEqual(models.map((model) => model.id), ["doubao-seed-code"]);
  assert.equal(endpointIdFromModel(models[0]!), "ep-first");
});

test("keeps media models separate while publishing chat models only", async () => {
  const models = await withMockArkClient(async (command) => {
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
              ModelReference: { FoundationModel: { Name: "Seedream" } },
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
          ModelReference: { FoundationModel: { Name: "Seedance" } },
        }],
      },
    };
  }, () => fetchEndpointModels({
      credential: {
        type: "api_key",
        env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }));
  assert.deepEqual(models.map((model) => model.id), ["chat-model"]);
  assert.deepEqual(cachedMediaModels.map(
    ({ inferenceId, name, kind, source }) => ({ inferenceId, name, kind, source }),
  ), [
    {
      inferenceId: "doubao-seedream-5-0-260128",
      name: "Doubao-Seedream-5.0-lite",
      kind: "image",
      source: "built-in",
    },
    {
      inferenceId: "ep-video",
      name: "Seedance",
      kind: "video",
      source: "custom",
    },
  ]);
});

test("auth errors are redacted", async () => {
  await assert.rejects(
    withMockArkClient(async (command) => {
      if (command instanceof InnerDescribeModelEndpointsCommand) {
        throw new Error("AccessDenied");
      }
      return { Result: { Items: [], TotalCount: 0 } };
    }, () => fetchEndpointModels({
        credential: {
          type: "api_key",
          env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "super-secret" },
        },
        allowNetwork: true,
        signal: new AbortController().signal,
        publish: async () => true,
      })),
    (error: Error) => error.message.includes("super-secret") === false && /AccessDenied/.test(error.message),
  );
});

test("preserves SDK cancellation errors", async () => {
  const controller = new AbortController();
  controller.abort();
  const sdkError = new Error("SDK cancellation wrapper");

  await assert.rejects(withMockArkClient(async () => {
    throw sdkError;
  }, () => fetchEndpointModels({
      credential: {
        type: "api_key",
        env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
      },
      allowNetwork: true,
      signal: controller.signal,
      publish: async () => true,
    })), (error) => error === sdkError);
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
