import { createHash, createHmac } from "node:crypto";
import type { ApiKeyCredential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";

const CONTROL_URL = "https://ark.cn-beijing.volcengineapi.com/";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;
export type VolcengineEndpointModel = Model<"openai-completions"> & {
  endpointId: string;
};

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function pick(record: JsonObject | undefined, ...keys: string[]): unknown {
  for (const key of keys) if (record?.[key] !== undefined) return record[key];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

export function signListEndpoints(
  body: string,
  accessKeyId: string,
  secretAccessKey: string,
  date = new Date(),
): { authorization: string; xDate: string; xContentSha256: string } {
  const xDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = xDate.slice(0, 8);
  const query = "Action=ListEndpoints&Version=2024-01-01";
  const host = "ark.cn-beijing.volcengineapi.com";
  const xContentSha256 = sha256(body);
  const signedHeaders = "host;x-content-sha256;x-date";
  const canonicalRequest = [
    "POST",
    "/",
    query,
    `host:${host}\nx-content-sha256:${xContentSha256}\nx-date:${xDate}\n`,
    signedHeaders,
    xContentSha256,
  ].join("\n");
  const scope = `${day}/cn-beijing/ark/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(secretAccessKey, day), "cn-beijing"), "ark"), "request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    xDate,
    xContentSha256,
    authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function combinedSignal(parent: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = AbortSignal.any([parent, timeout]);
  return { signal, dispose() {} };
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

function parsePage(payload: unknown): { items: JsonObject[]; total: number } {
  const root = object(payload);
  const result = object(pick(root, "Result", "result")) ?? root;
  const rawItems = pick(result, "Items", "items");
  if (!Array.isArray(rawItems)) throw new Error("方舟 ListEndpoints 返回格式已变化");
  const items = rawItems.map(object).filter((item): item is JsonObject => Boolean(item));
  return {
    items,
    total: number(pick(result, "TotalCount", "total_count", "total")) ?? items.length,
  };
}

function looksNonChat(item: JsonObject): boolean {
  const modelType = string(pick(item, "EndpointModelType", "endpoint_model_type"))?.toLowerCase() ?? "";
  const reference = object(pick(item, "ModelReference", "model_reference"));
  const foundation = object(pick(reference, "FoundationModel", "foundation_model"));
  const haystack = [
    modelType,
    string(pick(item, "Name", "name")),
    string(pick(foundation, "Name", "name")),
    string(pick(foundation, "ModelVersion", "model_version")),
  ].filter(Boolean).join(" ").toLowerCase();
  return /(embedding|image|video|seedream|seedance|tts|speech|audio)/.test(haystack);
}

export function displayModelId(name: string, endpointId: string): string {
  const slug = (name === endpointId ? "ark-endpoint" : name)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "ark-endpoint";
}

export function endpointToModel(item: JsonObject): VolcengineEndpointModel | undefined {
  const endpointId = string(pick(item, "Id", "id"));
  const status = string(pick(item, "Status", "status"))?.toLowerCase();
  if (!endpointId || (status && !["running", "active", "ready", "inservice"].includes(status)) || looksNonChat(item)) {
    return undefined;
  }
  const reference = object(pick(item, "ModelReference", "model_reference"));
  const foundation = object(pick(reference, "FoundationModel", "foundation_model"));
  const metadata = object(pick(item, "Metadata", "metadata", "ModelMetadata", "model_metadata"));
  const modelName = string(pick(foundation, "Name", "name"));
  const version = string(pick(foundation, "ModelVersion", "model_version"));
  const haystack = `${modelName ?? ""} ${version ?? ""}`.toLowerCase();
  const vision = /(vision|vl|doubao-seed|kimi-k2\.6|multimodal)/.test(haystack);
  const reasoning = /(deepseek|reason|thinking|r1|glm-5|kimi)/.test(haystack);
  const displayName = string(pick(item, "Name", "name"))
    || [modelName, version].filter(Boolean).join(" ")
    || endpointId;
  return {
    id: displayModelId(displayName, endpointId),
    endpointId,
    name: displayName,
    api: "openai-completions",
    provider: "volcengine",
    baseUrl: BASE_URL,
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
    cost: { ...ZERO_COST },
    contextWindow: number(pick(metadata, "ContextWindow", "context_window", "MaxContextLength")) ?? 128_000,
    maxTokens: number(pick(metadata, "MaxOutputTokens", "max_output_tokens", "MaxTokens")) ?? 16_384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
      ...(reasoning ? { thinkingFormat: "deepseek" as const } : {}),
    },
  };
}

function uniqueModelIds(models: VolcengineEndpointModel[]): VolcengineEndpointModel[] {
  const used = new Set<string>();
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
  fetchImpl: typeof fetch = fetch,
): Promise<readonly Model<"openai-completions">[]> {
  if (!context.allowNetwork) return [];
  const { accessKeyId, secretAccessKey } = credentials(context);
  const all: JsonObject[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const body = JSON.stringify({ PageNumber: page, PageSize: 100 });
    const signed = signListEndpoints(body, accessKeyId, secretAccessKey);
    const request = combinedSignal(context.signal);
    const response = await fetchImpl(`${CONTROL_URL}?Action=ListEndpoints&Version=2024-01-01`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-date": signed.xDate,
        "x-content-sha256": signed.xContentSha256,
        authorization: signed.authorization,
      },
      body,
      signal: request.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("方舟 AK/SK 鉴权失败，请重新运行 /login。");
    }
    if (!response.ok) throw new Error(`方舟 ListEndpoints 请求失败（HTTP ${response.status}）`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("方舟 ListEndpoints 返回了畸形 JSON"); }
    const parsed = parsePage(payload);
    all.push(...parsed.items);
    if (all.length >= parsed.total || parsed.items.length === 0) break;
  }
  const models = all.map(endpointToModel)
    .filter((model): model is VolcengineEndpointModel => Boolean(model));
  return uniqueModelIds(models);
}
