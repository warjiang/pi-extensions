import { appendFileSync } from "node:fs";
import type { Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  ARKClient,
  ListEndpointsCommand,
  type ListEndpointsCommandOutput,
  ListFoundationModelsCommand,
  type ListFoundationModelsCommandOutput,
} from "@volcengine/ark";
import {
  buildRequestConfigFromMetaPath,
  Command,
  type CommandOutput,
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
import {
  createFoundationModelIndex,
  type FoundationModelInfo,
  modelCost,
  resolveModelMetadata,
} from "./model-manifest.ts";

type InnerDescribeModelEndpointsRequest =
  ConstructorParameters<typeof ListEndpointsCommand>[0];
type InnerDescribeModelEndpointsResponse =
  ListEndpointsCommandOutput extends CommandOutput<infer Response> ? Response : never;
type Endpoint = NonNullable<InnerDescribeModelEndpointsResponse["Items"]>[number];
type InnerDescribeModelEndpointsCommandOutput =
  CommandOutput<InnerDescribeModelEndpointsResponse>;
type ListFoundationModelsResponse =
  ListFoundationModelsCommandOutput extends CommandOutput<infer Response> ? Response : never;
type FoundationModel =
  NonNullable<ListFoundationModelsResponse["Items"]>[number];
type FoundationModelIndex = ReadonlyMap<string, readonly FoundationModelInfo[]>;

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

export type VolcengineEndpointModel = Model<"openai-completions"> & {
  endpointId: string;
};
export interface VolcengineMediaModel {
  inferenceId: string;
  name: string;
  kind: "image" | "video";
  source: "built-in" | "custom";
  taskTypes?: readonly string[];
  domains?: readonly string[];
  manifestId?: string;
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
  foundation?: FoundationModelInfo,
): string {
  return item.Name
    || foundation?.DisplayName
    || item.ModelReference?.FoundationModel?.Name
    || fallback;
}

function endpointToMediaModel(
  item: Endpoint,
  source: VolcengineMediaModel["source"],
  foundationsByName: FoundationModelIndex,
): VolcengineMediaModel | undefined {
  const inferenceId = item.Id;
  const metadata = resolveModelMetadata(item, foundationsByName);
  const { kind } = metadata;
  if (!inferenceId || !isAvailable(item, inferenceId) || (kind !== "image" && kind !== "video")) {
    return undefined;
  }
  return {
    inferenceId,
    name: displayName(item, inferenceId, metadata.foundation),
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
  foundationsByName: FoundationModelIndex,
): Model<"openai-completions"> | undefined {
  const modelId = item.Id;
  const metadata = resolveModelMetadata(item, foundationsByName);
  for (const diagnostic of metadata.diagnostics) {
    debug(`[volcengine] endpoint=${modelId ?? "unknown"} ${diagnostic}`);
  }
  if (!modelId || !isAvailable(item, modelId) || metadata.kind !== "chat") {
    return undefined;
  }
  const modelName = displayName(item, modelId, metadata.foundation);
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

export function customEndpointToModel(
  item: Endpoint,
  foundationsByName: FoundationModelIndex = new Map(),
): VolcengineEndpointModel | undefined {
  const model = endpointToChatModel(item, foundationsByName);
  if (!model) return undefined;
  return {
    ...model,
    endpointId: model.id,
    id: displayModelId(model.name, model.id),
  };
}

export function builtInEndpointToModel(
  item: Endpoint,
  foundationsByName: FoundationModelIndex = new Map(),
): Model<"openai-completions"> | undefined {
  return endpointToChatModel(item, foundationsByName);
}

// Prevent custom endpoint display IDs from colliding with built-in models or one another.
function uniqueEndpointModelIds(
  models: VolcengineEndpointModel[],
  reservedIds: Iterable<string> = [],
): VolcengineEndpointModel[] {
  const used = new Set(reservedIds);
  return models.map((model) => {
    let id = model.id;
    if (used.has(id)) {
      const suffix = model.endpointId.split("-").at(-1) || "endpoint";
      id = `${id}-${suffix}`;
      for (let index = 2; used.has(id); index += 1) id = `${model.id}-${suffix}-${index}`;
    }
    used.add(id);
    return id === model.id ? model : { ...model, id };
  });
}

async function listFoundationModels(
  client: ARKClient,
  context: RefreshModelsContext,
): Promise<FoundationModel[]> {
  const models: FoundationModel[] = [];
  for (let pageNumber = 1; ; pageNumber += 1) {
    const response = await client.send(new ListFoundationModelsCommand({
      PageNumber: pageNumber,
      PageSize: PAGE_SIZE,
    }), {
      abortSignal: context.signal,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const items = response.Result?.Items ?? [];
    models.push(...items);
    const totalCount = response.Result?.TotalCount;
    if (
      items.length === 0
      || (totalCount !== undefined && models.length >= totalCount)
      || (totalCount === undefined && items.length < PAGE_SIZE)
    ) {
      return models;
    }
  }
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
  const [builtInResponse, customResponse, foundationModels] = await Promise.all([
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
    listFoundationModels(client, context),
  ]);
  const builtInItems = builtInResponse.Result?.Items ?? [];
  const customItems = customResponse.Result?.Items ?? [];
  const foundationsByName = createFoundationModelIndex(foundationModels);
  const builtInModels = [
    ...new Map(
      builtInItems
        .map((item) => builtInEndpointToModel(item, foundationsByName))
        .filter((model): model is Model<"openai-completions"> => Boolean(model))
        .map((model) => [model.id, model]),
    ).values(),
  ];
  const customModels = customItems
    .map((item) => customEndpointToModel(item, foundationsByName))
    .filter((model): model is VolcengineEndpointModel => Boolean(model));
  const uniqueCustomModels = uniqueEndpointModelIds(
    customModels,
    builtInModels.map((model) => model.id),
  );
  cachedMediaModels = [
    ...new Map(
      [
        ...builtInItems.map(
          (item) => endpointToMediaModel(item, "built-in", foundationsByName),
        ),
        ...customItems.map(
          (item) => endpointToMediaModel(item, "custom", foundationsByName),
        ),
      ]
        .filter((model): model is VolcengineMediaModel => Boolean(model))
        .map((model) => [`${model.kind}:${model.inferenceId}`, model]),
    ).values(),
  ];
  debug(
    `[volcengine] refresh succeeded; foundations=${foundationModels.length} builtIn=${builtInModels.length} custom=${uniqueCustomModels.length} media=${cachedMediaModels.length}`,
  );
  return [...builtInModels, ...uniqueCustomModels];
}
