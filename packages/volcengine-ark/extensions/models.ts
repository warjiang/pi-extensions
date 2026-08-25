import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ApiKeyCredential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  ARKClient,
  ListEndpointsCommand,
  type ListEndpointsCommandOutput,
} from "@volcengine/ark";
import {
  buildRequestConfigFromMetaPath,
  Command,
  type CommandOutput,
} from "@volcengine/sdk-core";

const BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CATALOG_PAGE_SIZE = 100;
const CATALOG_TIMEOUT_MS = 15_000;
const DEBUG_SETTING = process.env.VOLCENGINE_DEBUG;
const DEBUG_LOG_PATH = DEBUG_SETTING
  ? DEBUG_SETTING === "1"
    ? join(tmpdir(), "volcengine-ark-debug.log")
    : resolve(DEBUG_SETTING)
  : undefined;

type InnerDescribeModelEndpointsRequest =
  ConstructorParameters<typeof ListEndpointsCommand>[0];
type InnerDescribeModelEndpointsResponse =
  ListEndpointsCommandOutput extends CommandOutput<infer Response> ? Response : never;
type Endpoint = NonNullable<InnerDescribeModelEndpointsResponse["Items"]>[number];
type InnerDescribeModelEndpointsCommandOutput =
  CommandOutput<InnerDescribeModelEndpointsResponse>;

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
export type VolcengineModelKind = "chat" | "image" | "video" | "other";
export interface VolcengineMediaModel {
  inferenceId: string;
  name: string;
  kind: "image" | "video";
  source: "built-in" | "custom";
}

let cachedMediaModels: readonly VolcengineMediaModel[] = [];

function debug(message: string): void {
  if (!DEBUG_LOG_PATH) return;
  try {
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Debug logging must never break model refresh.
  }
}

function credentials(context: RefreshModelsContext): { accessKeyId: string; secretAccessKey: string } {
  const credential = context.credential?.type === "api_key"
    ? context.credential as ApiKeyCredential
    : undefined;
  const accessKeyId = credential?.env?.VOLCENGINE_ACCESS_KEY_ID;
  const secretAccessKey = credential?.env?.VOLCENGINE_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("拉取方舟接入点需要 Access Key 和 Secret Key；请运行 /login 或设置对应环境变量。");
  }
  return { accessKeyId, secretAccessKey };
}

export function classifyEndpoint(item: Endpoint): VolcengineModelKind {
  const foundation = item.ModelReference?.FoundationModel;
  const haystack = [
    item.EndpointModelType,
    foundation?.Name,
    foundation?.ModelVersion,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/(video|seedance)/.test(haystack)) return "video";
  if (/(image|seedream|seededit)/.test(haystack)) return "image";
  if (/(embedding|tts|speech|audio)/.test(haystack)) return "other";
  return "chat";
}

function isAvailable(item: Endpoint, id: string | undefined): boolean {
  const status = item.Status?.toLowerCase();
  return Boolean(
    id
    && (!status || ["running", "active", "ready", "inservice"].includes(status)),
  );
}

function mediaDisplayName(item: Endpoint, fallback: string): string {
  return item.Name
    || item.ModelReference?.FoundationModel?.Name
    || fallback;
}

export function endpointToMediaModel(item: Endpoint): VolcengineMediaModel | undefined {
  const inferenceId = item.Id;
  const kind = classifyEndpoint(item);
  if (!inferenceId || !isAvailable(item, inferenceId) || (kind !== "image" && kind !== "video")) {
    return undefined;
  }
  return {
    inferenceId,
    name: mediaDisplayName(item, inferenceId),
    kind,
    source: "custom",
  };
}

export function builtInEndpointToMediaModel(
  item: Endpoint,
): VolcengineMediaModel | undefined {
  const inferenceId = item.Id;
  const kind = classifyEndpoint(item);
  if (!inferenceId || !isAvailable(item, inferenceId) || (kind !== "image" && kind !== "video")) {
    return undefined;
  }
  return {
    inferenceId,
    name: mediaDisplayName(item, inferenceId),
    kind,
    source: "built-in",
  };
}

export function getCachedMediaModels(): readonly VolcengineMediaModel[] {
  return cachedMediaModels;
}

function modelProperties(item: Endpoint, fallback: string): Omit<
  Model<"openai-completions">,
  "id" | "name"
> {
  const foundation = item.ModelReference?.FoundationModel;
  const modelName = foundation?.Name;
  const version = foundation?.ModelVersion;
  const haystack = `${fallback} ${modelName ?? ""} ${version ?? ""}`.toLowerCase();
  const vision = /(vision|vl|doubao-seed|kimi-k2\.6|multimodal)/.test(haystack);
  const reasoning = /(deepseek|reason|thinking|r1|glm-5|kimi)/.test(haystack);
  return {
    api: "openai-completions",
    provider: "volcengine",
    baseUrl: BASE_URL,
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
    cost: { ...ZERO_COST },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
      ...(reasoning ? { thinkingFormat: "deepseek" as const } : {}),
    },
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

export function endpointToModel(item: Endpoint): VolcengineEndpointModel | undefined {
  const endpointId = item.Id;
  if (!endpointId || !isAvailable(item, endpointId) || classifyEndpoint(item) !== "chat") {
    return undefined;
  }
  const foundation = item.ModelReference?.FoundationModel;
  const modelName = foundation?.Name;
  const version = foundation?.ModelVersion;
  const displayName = item.Name
    || [modelName, version].filter(Boolean).join(" ")
    || endpointId;
  return {
    id: displayModelId(displayName, endpointId),
    endpointId,
    name: displayName,
    ...modelProperties(item, displayName),
  };
}

export function builtInEndpointToModel(
  item: Endpoint,
): Model<"openai-completions"> | undefined {
  const modelId = item.Id;
  if (!modelId || !isAvailable(item, modelId) || classifyEndpoint(item) !== "chat") {
    return undefined;
  }
  const displayName = item.Name
    || item.ModelReference?.FoundationModel?.Name
    || modelId;
  return {
    id: modelId,
    name: displayName,
    ...modelProperties(item, modelId),
  };
}

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

export async function fetchEndpointModels(
  context: RefreshModelsContext,
  injectedClient?: ARKClient,
): Promise<readonly Model<"openai-completions">[]> {
  if (!context.allowNetwork) return [];
  debug(`[volcengine] refresh started; log=${DEBUG_LOG_PATH}`);
  const { accessKeyId, secretAccessKey } = credentials(context);
  const client = injectedClient ?? new ARKClient({
    accessKeyId,
    secretAccessKey,
    region: "cn-beijing",
  });
  const [builtInResponse, customResponse] = await Promise.all([
    client.send(new InnerDescribeModelEndpointsCommand({
      PageSize: CATALOG_PAGE_SIZE,
    }), {
      abortSignal: context.signal,
      timeout: CATALOG_TIMEOUT_MS,
    }),
    client.send(new ListEndpointsCommand({
      PageSize: CATALOG_PAGE_SIZE,
    }), {
      abortSignal: context.signal,
      timeout: CATALOG_TIMEOUT_MS,
    }),
  ]);
  const builtInItems = builtInResponse.Result?.Items ?? [];
  const customItems = customResponse.Result?.Items ?? [];
  const builtInModels = [
    ...new Map(
      builtInItems
        .map(builtInEndpointToModel)
        .filter((model): model is Model<"openai-completions"> => Boolean(model))
        .map((model) => [model.id, model]),
    ).values(),
  ];
  const customModels = customItems
    .map(endpointToModel)
    .filter((model): model is VolcengineEndpointModel => Boolean(model));
  const uniqueCustomModels = uniqueEndpointModelIds(
    customModels,
    builtInModels.map((model) => model.id),
  );
  cachedMediaModels = [
    ...new Map(
      [
        ...builtInItems.map(builtInEndpointToMediaModel),
        ...customItems.map(endpointToMediaModel),
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
