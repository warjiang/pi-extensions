import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  signInnerDescribeModelEndpoints,
  signListEndpoints,
  signListProjects,
} from "../extensions/models.ts";

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

test("signature is deterministic and does not contain secret", () => {
  const signed = signListEndpoints("{}", "AKID", "SECRET", new Date("2026-08-15T01:02:03Z"));
  const builtInSigned = signInnerDescribeModelEndpoints(
    "{}",
    "AKID",
    "SECRET",
    new Date("2026-08-15T01:02:03Z"),
  );
  assert.equal(signed.xDate, "20260815T010203Z");
  assert.equal(signed.xContentSha256.length, 64);
  assert.match(signed.authorization, /SignedHeaders=host;x-content-sha256;x-date/);
  assert.match(signed.authorization, /^HMAC-SHA256 Credential=AKID\//);
  assert.notEqual(builtInSigned.authorization, signed.authorization);
  assert.equal(signed.authorization.includes("SECRET"), false);
});

test("signs ListProjects with the official IAM host, region and headers", () => {
  const signed = signListProjects(
    "Action=ListProjects&Limit=100&Offset=0&Version=2021-08-01",
    "AKID",
    "SECRET",
    new Date("2026-08-15T01:02:03Z"),
  );
  assert.equal(signed.xDate, "20260815T010203Z");
  assert.match(signed.authorization, /AKID\/20260815\/cn-beijing\/iam\/request/);
  assert.match(signed.authorization, /SignedHeaders=host;x-date/);
  assert.equal(signed.authorization.includes("SECRET"), false);
});

test("maps only running chat endpoints", () => {
  assert.equal(endpointToModel({ Id: "ep-bad", Status: "Stopped" }), undefined);
  assert.equal(endpointToModel({
    Id: "ep-img",
    Status: "Running",
    ModelReference: { FoundationModel: { Name: "Seedream image" } },
  }), undefined);
  assert.equal(endpointToModel({ Id: "ep-batch", Status: "Running", BatchOnly: true }), undefined);
  assert.equal(
    endpointToModel({ Id: "ep-custom", Status: "Running", Name: "My image assistant" })?.id,
    "my-image-assistant",
  );
  const model = endpointToModel({
    Id: "ep-ok",
    Name: "DeepSeek endpoint",
    Status: "Running",
    ModelReference: { FoundationModel: { Name: "DeepSeek R1", ModelVersion: "v1" } },
    Metadata: { ContextWindow: 65536, MaxOutputTokens: 8192 },
  });
  assert.equal(model?.id, "deepseek-endpoint");
  assert.equal(model?.endpointId, "ep-ok");
  assert.equal(model?.name, "DeepSeek endpoint");
  assert.equal(model?.reasoning, true);
  assert.equal(model?.contextWindow, 65536);
});

test("classifies and preserves image and video inference ids", () => {
  const builtInImage = {
    ModelId: "doubao-seedream-5-0-260128",
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

test("maps built-in endpoints with ModelId as the inference model", () => {
  assert.equal(builtInEndpointToModel({
    ModelId: "doubao-seedream-4-0",
    Status: "Running",
    ModelReference: { FoundationModel: { Name: "Seedream image" } },
  }), undefined);
  const model = builtInEndpointToModel({
    Id: "builtin-endpoint-id",
    ModelId: "deepseek-v4-flash-ga-260731",
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

test("paginates endpoints and treats empty list as valid", async () => {
  let endpointCalls = 0;
  const models = await fetchEndpointModels({
    credential: {
      type: "api_key",
      env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
    },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  }, async (input) => {
    if (String(input).includes("ListProjects")) {
      return new Response(JSON.stringify({
        Result: { Projects: [{ ProjectName: "default" }], Total: 1 },
      }));
    }
    if (String(input).includes("InnerDescribeModelEndpoints")) {
      return new Response(JSON.stringify({
        Result: { Items: [], TotalCount: 0 },
      }));
    }
    endpointCalls += 1;
    return new Response(JSON.stringify({
      Result: {
        Items: endpointCalls === 1 ? [{ Id: "ep-1", Status: "Running" }] : [],
        TotalCount: 2,
      },
    }));
  });
  assert.equal(endpointCalls, 2);
  assert.deepEqual(models.map((model) => model.id), ["ark-endpoint"]);
});

test("discovers projects and keeps separate endpoints for the same model", async () => {
  const builtInRequests: Array<{ ProjectName?: string }> = [];
  const customRequests: Array<{ ProjectName?: string }> = [];
  const models = await fetchEndpointModels({
    credential: {
      type: "api_key",
      env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
    },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  }, async (input, init) => {
    if (String(input).includes("ListProjects")) {
      return new Response(JSON.stringify({
        Result: {
          Projects: [
            { ProjectName: "default", HasPermission: true },
            { ProjectName: "project-b", HasPermission: true },
            { ProjectName: "hidden", HasPermission: false },
          ],
          Total: 3,
        },
      }));
    }
    const body = JSON.parse(String(init?.body));
    if (String(input).includes("InnerDescribeModelEndpoints")) {
      builtInRequests.push(body);
      return new Response(JSON.stringify({
        Result: {
          Items: [{
            Id: "builtin-id",
            ModelId: "deepseek-v4",
            Name: "DeepSeek V4 built-in",
            Status: "Running",
          }],
          TotalCount: 1,
        },
      }));
    }
    customRequests.push(body);
    const projectName = customRequests.at(-1)?.ProjectName;
    return new Response(JSON.stringify({
      Result: {
        Items: [{
          Id: projectName === "default" ? "ep-default-aaa" : "ep-project-b-bbb",
          Name: "DeepSeek V4",
          Status: "Running",
        }],
        TotalCount: 1,
      },
    }));
  });
  assert.deepEqual(builtInRequests.map((request) => request.ProjectName), ["default", "project-b"]);
  assert.deepEqual(customRequests.map((request) => request.ProjectName), ["default", "project-b"]);
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
  const models = await fetchEndpointModels({
    credential: {
      type: "api_key",
      env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "sk" },
    },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  }, async (input) => {
    if (String(input).includes("ListProjects")) {
      return new Response(JSON.stringify({
        Result: { Projects: [{ ProjectName: "default" }], Total: 1 },
      }));
    }
    if (String(input).includes("InnerDescribeModelEndpoints")) {
      return new Response(JSON.stringify({
        Result: {
          Items: [
            {
              ModelId: "chat-model",
              Name: "Chat",
              Status: "Running",
            },
            {
              ModelId: "doubao-seedream-5-0-260128",
              Name: "Seedream",
              Status: "Running",
              EndpointModelType: "image",
            },
          ],
          TotalCount: 2,
        },
      }));
    }
    return new Response(JSON.stringify({
      Result: {
        Items: [{
          Id: "ep-video",
          Name: "Seedance endpoint",
          Status: "Running",
          EndpointModelType: "video",
        }],
        TotalCount: 1,
      },
    }));
  });
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
  await assert.rejects(
    fetchEndpointModels({
      credential: {
        type: "api_key",
        env: { VOLCENGINE_ACCESS_KEY_ID: "ak", VOLCENGINE_SECRET_ACCESS_KEY: "super-secret" },
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }, async () => new Response("no", { status: 403 })),
    (error: Error) => error.message.includes("super-secret") === false && /重新运行/.test(error.message),
  );
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
