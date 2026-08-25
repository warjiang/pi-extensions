import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  ARKClient,
  ListEndpointsCommand,
} from "@volcengine/ark";
import {
  buildRequestConfigFromMetaPath,
  Command,
} from "@volcengine/sdk-core";
import {
  BASE_URL,
  DEBUG_LOG_PATH,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  ENV_NAMES,
  PAGE_SIZE,
  PROVIDER_ID,
  REQUEST_TIMEOUT_MS,
} from "./constants.ts";
import { modelCost, resolveModelMetadata } from "./model-manifest.ts";
import type {
  Endpoint,
  InnerDescribeModelEndpointsCommandOutput,
  InnerDescribeModelEndpointsRequest,
  VolcengineEndpointModel,
  VolcengineMediaModel,
} from "./types.ts";

export class InnerDescribeModelEndpointsCommand extends Command<
  InnerDescribeModelEndpointsRequest,
  InnerDescribeModelEndpointsCommandOutput,
  "InnerDescribeModelEndpointsCommand"
> {
  static readonly metaPath =
    "/InnerDescribeModelEndpoints/2024-01-01/ark/post/application_json/";

  constructor(input: InnerDescribeModelEndpointsRequest) {
    super(input);
    this.requestConfig = buildRequestConfigFromMetaPath(
      InnerDescribeModelEndpointsCommand.metaPath,
    );
  }
}

export let cachedMediaModels: readonly VolcengineMediaModel[] = [];

function debug(message: string): void {
  if (!DEBUG_LOG_PATH) return;
  try {
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Debug logging must never break model refresh.
  }
}

function isAvailable(item: Endpoint, id: string | undefined): boolean {
  const status = item.Status?.toLowerCase();
  return Boolean(
    id
    && (!status || ["running", "active", "ready", "inservice"].includes(status)),
  );
}

function displayName(
  item: Endpoint,
  fallback: string,
  manifestDisplayName?: string,
): string {
  return manifestDisplayName
    || item.ModelReference?.FoundationModel?.Name
    || item.Name
    || fallback;
}

function endpointToMediaModel(
  item: Endpoint,
  source: VolcengineMediaModel["source"],
): VolcengineMediaModel | undefined {
  const inferenceId = item.Id;
  const metadata = resolveModelMetadata(item);
  const { kind } = metadata;
  if (!inferenceId || !isAvailable(item, inferenceId) || (kind !== "image" && kind !== "video")) {
    return undefined;
  }
  return {
    inferenceId,
    name: displayName(item, inferenceId, metadata.manifest?.displayName),
    kind,
    source,
    ...(metadata.taskTypes.length ? { taskTypes: metadata.taskTypes } : {}),
    ...(metadata.domains.length ? { domains: metadata.domains } : {}),
    ...(metadata.manifestId ? { manifestId: metadata.manifestId } : {}),
  };
}

export function displayModelId(name: string, endpointId: string): string {
  const slug = (name === endpointId ? "ark-endpoint" : name)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "ark-endpoint";
}

function endpointToChatModel(
  item: Endpoint,
): Model<"openai-completions"> | undefined {
  const modelId = item.Id;
  const metadata = resolveModelMetadata(item);
  for (const diagnostic of metadata.diagnostics) {
    debug(`[volcengine] endpoint=${modelId ?? "unknown"} ${diagnostic}`);
  }
  if (!modelId || !isAvailable(item, modelId) || metadata.kind !== "chat") {
    return undefined;
  }
  const modelName = displayName(item, modelId, metadata.manifest?.displayName);
  const manifest = metadata.manifest;
  const reasoning = manifest?.supportsReasoning ?? false;
  return {
    id: modelId,
    name: modelName,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning,
    input: manifest?.supportsVision ? ["text", "image"] : ["text"],
    cost: modelCost(manifest),
    contextWindow: manifest?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: manifest?.maxOutputTokens ?? manifest?.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
      ...(reasoning ? { thinkingFormat: "deepseek" as const } : {}),
    },
  };
}

export function applyCurrentManifestMetadata(
  model: Model<"openai-completions">,
): Model<"openai-completions"> {
  const endpointId =
    (model as Model<"openai-completions"> & { endpointId?: unknown }).endpointId;
  const metadata = resolveModelMetadata({
    Id: typeof endpointId === "string" ? endpointId : model.id,
    Name: model.name,
  });
  const manifest = metadata.manifest;
  if (!manifest) return model;
  const reasoning = manifest.supportsReasoning ?? false;
  const refreshed: Model<"openai-completions"> = {
    ...model,
    name: manifest.displayName ?? model.name,
    reasoning,
    input: manifest.supportsVision ? ["text", "image"] : ["text"],
    cost: modelCost(manifest),
    contextWindow: manifest.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: manifest.maxOutputTokens ?? manifest.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat: {
      ...model.compat,
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
      thinkingFormat: reasoning ? "deepseek" : undefined,
    },
  };
  return isDeepStrictEqual(refreshed, model) ? model : refreshed;
}

export function customEndpointToModel(
  item: Endpoint,
): VolcengineEndpointModel | undefined {
  const model = endpointToChatModel(item);
  if (!model) return undefined;
  return {
    ...model,
    endpointId: model.id,
    id: displayModelId(model.name, model.id),
  };
}

export function builtInEndpointToModel(
  item: Endpoint,
): Model<"openai-completions"> | undefined {
  const model = endpointToChatModel(item);
  if (!model || !model.id.startsWith("ep-")) return model;
  const endpointModel: VolcengineEndpointModel = {
    ...model,
    endpointId: model.id,
    id: displayModelId(model.name, model.id),
  };
  return endpointModel;
}

export async function fetchEndpointModels(
  context: RefreshModelsContext,
): Promise<readonly Model<"openai-completions">[]> {
  if (!context.allowNetwork) return [];
  debug(`[volcengine] refresh started; log=${DEBUG_LOG_PATH}`);
  const env = context.credential?.type === "api_key"
    ? context.credential.env
    : undefined;
  const accessKeyId = env?.[ENV_NAMES.accessKeyId];
  const secretAccessKey = env?.[ENV_NAMES.secretAccessKey];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Access Key ID and Secret Access Key are required to fetch Ark endpoints; run /login.");
  }
  const client = new ARKClient({
    accessKeyId,
    secretAccessKey,
    region: "cn-beijing",
  });
  const [builtInResponse, customResponse] = await Promise.all([
    client.send(new InnerDescribeModelEndpointsCommand({
      PageSize: PAGE_SIZE,
    }), {
      abortSignal: context.signal,
      timeout: REQUEST_TIMEOUT_MS,
    }),
    client.send(new ListEndpointsCommand({
      PageSize: PAGE_SIZE,
    }), {
      abortSignal: context.signal,
      timeout: REQUEST_TIMEOUT_MS,
    }),
  ]);
  const builtInItems = builtInResponse.Result?.Items ?? [];
  const customItems = customResponse.Result?.Items ?? [];
  const builtInModels = [
    ...new Map(
      builtInItems
        .map((item) => builtInEndpointToModel(item))
        .filter((model): model is Model<"openai-completions"> => Boolean(model))
        .map((model) => [model.id, model]),
    ).values(),
  ];
  const customModels = customItems
    .map((item) => customEndpointToModel(item))
    .filter((model): model is VolcengineEndpointModel => Boolean(model));
  const builtInModelIds = new Set(builtInModels.map((model) => model.id));
  const customModelsById = new Map<string, VolcengineEndpointModel>();
  for (const model of customModels) {
    if (!builtInModelIds.has(model.id) && !customModelsById.has(model.id)) {
      customModelsById.set(model.id, model);
    }
  }
  const uniqueCustomModels = [...customModelsById.values()];
  cachedMediaModels = [
    ...new Map(
      [
        ...builtInItems.map(
          (item) => endpointToMediaModel(item, "built-in"),
        ),
        ...customItems.map(
          (item) => endpointToMediaModel(item, "custom"),
        ),
      ]
        .filter((model): model is VolcengineMediaModel => Boolean(model))
        .map((model) => [`${model.kind}:${model.inferenceId}`, model]),
    ).values(),
  ];
  debug(
    `[volcengine] refresh succeeded; builtIn=${builtInModels.length} custom=${uniqueCustomModels.length} media=${cachedMediaModels.length}`,
  );
  return [...builtInModels, ...uniqueCustomModels];
}
