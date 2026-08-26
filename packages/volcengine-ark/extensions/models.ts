import { appendFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  ARKClient,
  ListEndpointsCommand,
  type ListEndpointsCommandOutput,
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
  ResolvedModelMetadata,
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

function resetDebugLog(): void {
  if (!DEBUG_LOG_PATH) return;
  try {
    writeFileSync(
      DEBUG_LOG_PATH,
      `=== Volcengine Ark model refresh ${new Date().toISOString()} ===\n`,
      "utf8",
    );
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

function endpointDetails(
  item: Endpoint,
  source: VolcengineMediaModel["source"],
  metadata: ResolvedModelMetadata,
): string {
  const foundation = item.ModelReference?.FoundationModel;
  return [
    `source=${source}`,
    `id=${JSON.stringify(item.Id ?? null)}`,
    `name=${JSON.stringify(item.Name ?? null)}`,
    `status=${JSON.stringify(item.Status ?? null)}`,
    `endpointModelType=${JSON.stringify(item.EndpointModelType ?? null)}`,
    `foundationName=${JSON.stringify(foundation?.Name ?? null)}`,
    `foundationVersion=${JSON.stringify(foundation?.ModelVersion ?? null)}`,
    `kind=${metadata.kind}`,
    `manifestId=${JSON.stringify(metadata.manifestId ?? null)}`,
    `taskTypes=${JSON.stringify(metadata.taskTypes)}`,
    `domains=${JSON.stringify(metadata.domains)}`,
  ].join(" ");
}

function logResponseCount(
  source: VolcengineMediaModel["source"],
  returned: number,
  total: number | undefined,
): void {
  debug(
    `[volcengine] response source=${source} returned=${returned} total=${total ?? "unknown"} pageSize=${PAGE_SIZE}`,
  );
  if (total !== undefined && total > returned) {
    debug(
      `[volcengine] warning source=${source} reason=truncated-response returned=${returned} total=${total}; only the first page was requested`,
    );
  } else if (total === undefined && returned >= PAGE_SIZE) {
    debug(
      `[volcengine] warning source=${source} reason=possible-truncated-response returned=${returned}; total is unavailable and the response filled the requested page`,
    );
  }
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
  const model = {
    inferenceId,
    name: displayName(item, inferenceId, metadata.manifest?.displayName),
    kind,
    source,
    ...(metadata.taskTypes.length ? { taskTypes: metadata.taskTypes } : {}),
    ...(metadata.domains.length ? { domains: metadata.domains } : {}),
    ...(metadata.manifestId ? { manifestId: metadata.manifestId } : {}),
  };
  debug(
    `[volcengine] media decision=included ${endpointDetails(item, source, metadata)} displayName=${JSON.stringify(model.name)}`,
  );
  return model;
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
  source: VolcengineMediaModel["source"],
): Model<"openai-completions"> | undefined {
  const modelId = item.Id;
  const metadata = resolveModelMetadata(item);
  const details = endpointDetails(item, source, metadata);
  for (const diagnostic of metadata.diagnostics) {
    debug(`[volcengine] endpoint ${details} diagnostic=${JSON.stringify(diagnostic)}`);
  }
  if (!modelId) {
    debug(`[volcengine] chat decision=excluded reason=missing-id ${details}`);
    return undefined;
  }
  if (!isAvailable(item, modelId)) {
    debug(`[volcengine] chat decision=excluded reason=unavailable-status ${details}`);
    return undefined;
  }
  if (metadata.kind !== "chat") {
    debug(`[volcengine] chat decision=excluded reason=non-chat-model ${details}`);
    return undefined;
  }
  const modelName = displayName(item, modelId, metadata.manifest?.displayName);
  const manifest = metadata.manifest;
  const reasoning = manifest?.supportsReasoning ?? false;
  const model: Model<"openai-completions"> = {
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
  debug(
    `[volcengine] chat decision=included ${details} displayName=${JSON.stringify(model.name)} contextWindow=${model.contextWindow} maxTokens=${model.maxTokens} input=${JSON.stringify(model.input)} reasoning=${model.reasoning}`,
  );
  return model;
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
  const model = endpointToChatModel(item, "custom");
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
  const model = endpointToChatModel(item, "built-in");
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
  resetDebugLog();
  if (!context.allowNetwork) {
    debug("[volcengine] refresh skipped; reason=network-disabled");
    return [];
  }
  debug(`[volcengine] refresh started; log=${DEBUG_LOG_PATH}`);
  const env = context.credential?.type === "api_key"
    ? context.credential.env
    : undefined;
  const accessKeyId = env?.[ENV_NAMES.accessKeyId];
  const secretAccessKey = env?.[ENV_NAMES.secretAccessKey];
  if (!accessKeyId || !secretAccessKey) {
    debug("[volcengine] refresh failed; reason=missing-access-key-credentials");
    throw new Error("Access Key ID and Secret Access Key are required to fetch Ark endpoints; run /login.");
  }
  const client = new ARKClient({
    accessKeyId,
    secretAccessKey,
    region: "cn-beijing",
  });
  let builtInResponse: InnerDescribeModelEndpointsCommandOutput;
  let customResponse: ListEndpointsCommandOutput;
  try {
    [builtInResponse, customResponse] = await Promise.all([
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
  } catch (error) {
    const message = error instanceof Error
      ? `${error.name}: ${error.message}`
      : `Non-Error value (${typeof error})`;
    debug(
      `[volcengine] refresh failed; error=${JSON.stringify(
        message
          .replaceAll(accessKeyId, "[redacted]")
          .replaceAll(secretAccessKey, "[redacted]"),
      )}`,
    );
    throw error;
  }
  const builtInItems = builtInResponse.Result?.Items ?? [];
  const customItems = customResponse.Result?.Items ?? [];
  logResponseCount("built-in", builtInItems.length, builtInResponse.Result?.TotalCount);
  logResponseCount("custom", customItems.length, customResponse.Result?.TotalCount);

  const builtInModelsById = new Map<
    string,
    { model: Model<"openai-completions">; inferenceId: string }
  >();
  let builtInChatCandidates = 0;
  let duplicateBuiltInModels = 0;
  for (const item of builtInItems) {
    const model = builtInEndpointToModel(item);
    if (!model) continue;
    builtInChatCandidates += 1;
    const existing = builtInModelsById.get(model.id);
    if (existing) {
      duplicateBuiltInModels += 1;
      debug(
        `[volcengine] chat decision=deduplicated source=built-in reason=duplicate-model-id modelId=${JSON.stringify(model.id)} keptInferenceId=${JSON.stringify(item.Id ?? model.id)} droppedInferenceId=${JSON.stringify(existing.inferenceId)}`,
      );
    }
    builtInModelsById.set(model.id, {
      model,
      inferenceId: item.Id ?? model.id,
    });
  }
  const builtInModels = [...builtInModelsById.values()].map(({ model }) => model);
  const customModels = customItems
    .map((item) => customEndpointToModel(item))
    .filter((model): model is VolcengineEndpointModel => Boolean(model));
  const builtInModelIds = new Set(builtInModels.map((model) => model.id));
  const customModelsById = new Map<string, VolcengineEndpointModel>();
  let duplicateBuiltInCustomModels = 0;
  let duplicateCustomModels = 0;
  for (const model of customModels) {
    if (builtInModelIds.has(model.id)) {
      duplicateBuiltInCustomModels += 1;
      debug(
        `[volcengine] chat decision=deduplicated source=custom reason=duplicate-built-in-model modelId=${JSON.stringify(model.id)} droppedInferenceId=${JSON.stringify(model.endpointId)}`,
      );
      continue;
    }
    const existing = customModelsById.get(model.id);
    if (existing) {
      duplicateCustomModels += 1;
      debug(
        `[volcengine] chat decision=deduplicated source=custom reason=duplicate-custom-model modelId=${JSON.stringify(model.id)} keptInferenceId=${JSON.stringify(existing.endpointId)} droppedInferenceId=${JSON.stringify(model.endpointId)}`,
      );
      continue;
    }
    customModelsById.set(model.id, model);
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
    `[volcengine] refresh succeeded; builtInItems=${builtInItems.length} builtInChatCandidates=${builtInChatCandidates} builtInPublished=${builtInModels.length} duplicateBuiltIn=${duplicateBuiltInModels} customItems=${customItems.length} customChatCandidates=${customModels.length} customPublished=${uniqueCustomModels.length} duplicateAgainstBuiltIn=${duplicateBuiltInCustomModels} duplicateCustom=${duplicateCustomModels} media=${cachedMediaModels.length} published=${builtInModels.length + uniqueCustomModels.length}`,
  );
  return [...builtInModels, ...uniqueCustomModels];
}
