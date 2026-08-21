import { createHash, createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ApiKeyCredential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";

const CONTROL_URL = "https://ark.cn-beijing.volcengineapi.com/";
const IAM_CONTROL_URL = "https://iam.volcengineapi.com/";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TIMEOUT_MS = 15_000;
const CATALOG_IMPLEMENTATION = "built-in+custom-v1";
const DEBUG_SETTING = process.env.VOLCENGINE_DEBUG;
const DEBUG_LOG_PATH = DEBUG_SETTING
  ? DEBUG_SETTING === "1"
    ? join(tmpdir(), "volcengine-ark-debug.log")
    : resolve(DEBUG_SETTING)
  : undefined;

type JsonObject = Record<string, unknown>;
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

type ArkControlAction = "ListEndpoints" | "InnerDescribeModelEndpoints";

function debug(message: string): void {
  if (!DEBUG_LOG_PATH) return;
  try {
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Debug logging must never break model refresh.
  }
}

debug(
  `[volcengine] extension loaded; catalogImplementation=${CATALOG_IMPLEMENTATION} sources=${JSON.stringify(["InnerDescribeModelEndpoints", "ListEndpoints"])}`,
);

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

export interface VolcengineRequestOptions {
  url: string;
  method: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  body?: string;
  headers?: HeadersInit;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function volcengineRequest(options: VolcengineRequestOptions): Promise<Response> {
  const url = new URL(options.url);
  url.searchParams.sort();
  const xDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = xDate.slice(0, 8);
  const region = options.region ?? "cn-beijing";
  const xContentSha256 = sha256(options.body ?? "");
  const signPayload = options.body !== undefined;
  const signedHeaders = signPayload
    ? "host;x-content-sha256;x-date"
    : "host;x-date";
  const canonicalHeaders = signPayload
    ? `host:${url.host}\nx-content-sha256:${xContentSha256}\nx-date:${xDate}\n`
    : `host:${url.host}\nx-date:${xDate}\n`;
  const canonicalRequest = [
    options.method,
    url.pathname,
    url.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    xContentSha256,
  ].join("\n");
  const scope = `${day}/${region}/${options.service}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signingKey = hmac(
    hmac(hmac(hmac(options.secretAccessKey, day), region), options.service),
    "request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const headers = new Headers(options.headers);
  headers.set("x-date", xDate);
  if (signPayload) headers.set("x-content-sha256", xContentSha256);
  headers.set(
    "authorization",
    `HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return (options.fetchImpl ?? fetch)(url, {
    method: options.method,
    headers,
    body: options.body,
    signal: combinedSignal(options.signal).signal,
  });
}

function signArkControlRequest(
  action: ArkControlAction,
  body: string,
  accessKeyId: string,
  secretAccessKey: string,
  date = new Date(),
): { authorization: string; xDate: string; xContentSha256: string } {
  const xDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = xDate.slice(0, 8);
  const query = `Action=${action}&Version=2024-01-01`;
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

export function signListEndpoints(
  body: string,
  accessKeyId: string,
  secretAccessKey: string,
  date = new Date(),
): { authorization: string; xDate: string; xContentSha256: string } {
  return signArkControlRequest("ListEndpoints", body, accessKeyId, secretAccessKey, date);
}

export function signInnerDescribeModelEndpoints(
  body: string,
  accessKeyId: string,
  secretAccessKey: string,
  date = new Date(),
): { authorization: string; xDate: string; xContentSha256: string } {
  return signArkControlRequest(
    "InnerDescribeModelEndpoints",
    body,
    accessKeyId,
    secretAccessKey,
    date,
  );
}

export function signListProjects(
  query: string,
  accessKeyId: string,
  secretAccessKey: string,
  date = new Date(),
): { authorization: string; xDate: string } {
  const xDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = xDate.slice(0, 8);
  const host = "iam.volcengineapi.com";
  const signedHeaders = "host;x-date";
  const canonicalRequest = [
    "GET",
    "/",
    query,
    `host:${host}\nx-date:${xDate}\n`,
    signedHeaders,
    sha256(""),
  ].join("\n");
  const scope = `${day}/cn-beijing/iam/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(secretAccessKey, day), "cn-beijing"), "iam"), "request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    xDate,
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

function parsePage(
  payload: unknown,
  action: ArkControlAction,
): { items: JsonObject[]; total: number } {
  const root = object(payload);
  const metadata = object(pick(root, "ResponseMetadata", "response_metadata"));
  const apiError = object(pick(metadata, "Error", "error"));
  if (apiError) {
    const code = string(pick(apiError, "Code", "code")) ?? "UnknownError";
    throw new Error(`方舟 ${action} 请求失败（${code}）`);
  }
  const result = object(pick(root, "Result", "result")) ?? root;
  const rawItems = pick(result, "Items", "items");
  if (!Array.isArray(rawItems)) throw new Error(`方舟 ${action} 返回格式已变化`);
  const items = rawItems.map(object).filter((item): item is JsonObject => Boolean(item));
  return {
    items,
    total: number(pick(result, "TotalCount", "total_count", "total")) ?? items.length,
  };
}

export function classifyEndpoint(item: JsonObject): VolcengineModelKind {
  const modelType = string(pick(item, "EndpointModelType", "endpoint_model_type"))?.toLowerCase() ?? "";
  const reference = object(pick(item, "ModelReference", "model_reference"));
  const foundation = object(pick(reference, "FoundationModel", "foundation_model"));
  const haystack = [
    modelType,
    string(pick(item, "ModelId", "model_id")),
    string(pick(foundation, "Name", "name")),
    string(pick(foundation, "ModelVersion", "model_version")),
    string(pick(foundation, "TaskType", "task_type")),
  ].filter(Boolean).join(" ").toLowerCase();
  if (/(video|seedance)/.test(haystack)) return "video";
  if (/(image|seedream|seededit)/.test(haystack)) return "image";
  if (/(embedding|tts|speech|audio)/.test(haystack)) return "other";
  return "chat";
}

function isAvailable(item: JsonObject, id: string | undefined, allowBatch = false): boolean {
  const status = string(pick(item, "Status", "status"))?.toLowerCase();
  return Boolean(
    id
    && (allowBatch || pick(item, "BatchOnly", "batch_only") !== true)
    && (!status || ["running", "active", "ready", "inservice"].includes(status)),
  );
}

function mediaDisplayName(item: JsonObject, fallback: string): string {
  const reference = object(pick(item, "ModelReference", "model_reference"));
  const foundation = object(pick(reference, "FoundationModel", "foundation_model"));
  return string(pick(item, "Name", "name"))
    || string(pick(foundation, "Name", "name"))
    || fallback;
}

export function endpointToMediaModel(item: JsonObject): VolcengineMediaModel | undefined {
  const inferenceId = string(pick(item, "Id", "id"));
  const kind = classifyEndpoint(item);
  if (!isAvailable(item, inferenceId) || (kind !== "image" && kind !== "video")) return undefined;
  return {
    inferenceId: inferenceId!,
    name: mediaDisplayName(item, inferenceId!),
    kind,
    source: "custom",
  };
}

export function builtInEndpointToMediaModel(item: JsonObject): VolcengineMediaModel | undefined {
  const inferenceId = string(pick(item, "ModelId", "model_id"));
  const kind = classifyEndpoint(item);
  if (!isAvailable(item, inferenceId, true) || (kind !== "image" && kind !== "video")) {
    return undefined;
  }
  return {
    inferenceId: inferenceId!,
    name: mediaDisplayName(item, inferenceId!),
    kind,
    source: "built-in",
  };
}

export function getCachedMediaModels(): readonly VolcengineMediaModel[] {
  return cachedMediaModels;
}

function modelProperties(item: JsonObject, fallback: string): Omit<
  Model<"openai-completions">,
  "id" | "name"
> {
  const reference = object(pick(item, "ModelReference", "model_reference"));
  const foundation = object(pick(reference, "FoundationModel", "foundation_model"));
  const metadata = object(pick(item, "Metadata", "metadata", "ModelMetadata", "model_metadata"));
  const modelName = string(pick(foundation, "Name", "name"));
  const version = string(pick(foundation, "ModelVersion", "model_version"));
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
    contextWindow: number(pick(metadata, "ContextWindow", "context_window", "MaxContextLength")) ?? 128_000,
    maxTokens: number(pick(metadata, "MaxOutputTokens", "max_output_tokens", "MaxTokens")) ?? 16_384,
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

export function endpointToModel(item: JsonObject): VolcengineEndpointModel | undefined {
  const endpointId = string(pick(item, "Id", "id"));
  if (!endpointId || !isAvailable(item, endpointId) || classifyEndpoint(item) !== "chat") {
    return undefined;
  }
  const reference = object(pick(item, "ModelReference", "model_reference"));
  const foundation = object(pick(reference, "FoundationModel", "foundation_model"));
  const modelName = string(pick(foundation, "Name", "name"));
  const version = string(pick(foundation, "ModelVersion", "model_version"));
  const displayName = string(pick(item, "Name", "name"))
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
  item: JsonObject,
): Model<"openai-completions"> | undefined {
  const modelId = string(pick(item, "ModelId", "model_id"));
  if (!modelId || !isAvailable(item, modelId, true) || classifyEndpoint(item) !== "chat") {
    return undefined;
  }
  const reference = object(pick(item, "ModelReference", "model_reference"));
  const foundation = object(pick(reference, "FoundationModel", "foundation_model"));
  const displayName = string(pick(item, "Name", "name"))
    || string(pick(foundation, "Name", "name"))
    || modelId;
  return {
    id: modelId,
    name: displayName,
    ...modelProperties(item, modelId),
  };
}

function endpointSummary(item: JsonObject): string {
  const reference = object(pick(item, "ModelReference", "model_reference"));
  const foundation = object(pick(reference, "FoundationModel", "foundation_model"));
  return JSON.stringify({
    id: string(pick(item, "Id", "id")),
    modelId: string(pick(item, "ModelId", "model_id")),
    name: string(pick(item, "Name", "name")),
    status: string(pick(item, "Status", "status")),
    endpointModelType: string(pick(item, "EndpointModelType", "endpoint_model_type")),
    batchOnly: pick(item, "BatchOnly", "batch_only") === true,
    foundationModel: string(pick(foundation, "Name", "name")),
    modelVersion: string(pick(foundation, "ModelVersion", "model_version")),
  });
}

function endpointRejectionReason(item: JsonObject): string | undefined {
  if (!string(pick(item, "Id", "id"))) return "missing endpoint id";
  if (pick(item, "BatchOnly", "batch_only") === true) return "batch-only endpoint";
  const status = string(pick(item, "Status", "status"))?.toLowerCase();
  if (status && !["running", "active", "ready", "inservice"].includes(status)) {
    return `status=${status}`;
  }
  if (classifyEndpoint(item) !== "chat") return `kind=${classifyEndpoint(item)}`;
}

function builtInRejectionReason(item: JsonObject): string | undefined {
  if (!string(pick(item, "ModelId", "model_id"))) return "missing model id";
  const status = string(pick(item, "Status", "status"))?.toLowerCase();
  if (status && !["running", "active", "ready", "inservice"].includes(status)) {
    return `status=${status}`;
  }
  if (classifyEndpoint(item) !== "chat") return `kind=${classifyEndpoint(item)}`;
}

function parseProjects(payload: unknown): { names: string[]; count: number; total: number } {
  const root = object(payload);
  const metadata = object(pick(root, "ResponseMetadata", "response_metadata"));
  const apiError = object(pick(metadata, "Error", "error"));
  if (apiError) {
    const code = string(pick(apiError, "Code", "code")) ?? "UnknownError";
    throw new Error(`火山引擎项目列表请求失败（${code}）`);
  }
  const result = object(pick(root, "Result", "result")) ?? root;
  const rawProjects = pick(result, "Projects", "projects");
  if (!Array.isArray(rawProjects)) throw new Error("火山引擎 ListProjects 返回格式已变化");
  const projects = rawProjects.map(object).filter((item): item is JsonObject => Boolean(item));
  const names = projects
    .filter((item) => pick(item, "HasPermission", "has_permission") !== false)
    .map((item) => string(pick(item, "ProjectName", "project_name", "Name", "name")))
    .filter((name): name is string => Boolean(name));
  return {
    names,
    count: projects.length,
    total: number(pick(result, "Total", "total", "TotalCount", "total_count")) ?? projects.length,
  };
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (redacted, secret) => secret ? redacted.split(secret).join("[REDACTED]") : redacted,
    value,
  );
}

async function responseText(response: Response, secrets: readonly string[]): Promise<string> {
  try {
    return redact(await response.clone().text(), secrets);
  } catch (error) {
    return `<读取响应失败: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

async function fetchProjectNames(
  context: RefreshModelsContext,
  accessKeyId: string,
  secretAccessKey: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const names = new Set<string>(["default"]);
  for (let offset = 0; offset <= 100_000;) {
    const query = `Action=ListProjects&Limit=100&Offset=${offset}&Version=2021-08-01`;
    const signed = signListProjects(query, accessKeyId, secretAccessKey);
    const requestUrl = `${IAM_CONTROL_URL}?${query}`;
    debug(`[volcengine] GET ${requestUrl}`);
    const response = await fetchImpl(requestUrl, {
      method: "GET",
      headers: {
        "x-date": signed.xDate,
        authorization: signed.authorization,
      },
      signal: combinedSignal(context.signal).signal,
    });
    if (DEBUG_LOG_PATH) {
      debug(`[volcengine] ListProjects HTTP ${response.status} ${response.statusText}\n${await responseText(response, [accessKeyId, secretAccessKey])}`);
    }
    if (!response.ok) throw new Error(`火山引擎 ListProjects 请求失败（HTTP ${response.status}）`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("火山引擎 ListProjects 返回了畸形 JSON");
    }
    const parsed = parseProjects(payload);
    parsed.names.forEach((name) => names.add(name));
    offset += parsed.count;
    if (offset >= parsed.total || parsed.count === 0) break;
  }
  return [...names];
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

async function fetchArkItems(
  action: ArkControlAction,
  projectNames: readonly string[],
  context: RefreshModelsContext,
  accessKeyId: string,
  secretAccessKey: string,
  fetchImpl: typeof fetch,
): Promise<JsonObject[]> {
  const all: JsonObject[] = [];
  for (const projectName of projectNames) {
    let projectCount = 0;
    for (let page = 1; page <= 100; page += 1) {
      const body = JSON.stringify({ PageNumber: page, PageSize: 100, ProjectName: projectName });
      const signed = signArkControlRequest(action, body, accessKeyId, secretAccessKey);
      const requestUrl = `${CONTROL_URL}?Action=${action}&Version=2024-01-01`;
      debug(`[volcengine] ${action} POST ${requestUrl} body=${body}`);
      let response: Response;
      try {
        response = await fetchImpl(requestUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-date": signed.xDate,
            "x-content-sha256": signed.xContentSha256,
            authorization: signed.authorization,
          },
          body,
          signal: combinedSignal(context.signal).signal,
        });
      } catch (error) {
        debug(`[volcengine] ${action} request error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
        throw error;
      }
      if (DEBUG_LOG_PATH) {
        debug(`[volcengine] ${action} HTTP ${response.status} ${response.statusText}\n${await responseText(response, [accessKeyId, secretAccessKey])}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`方舟 ${action} AK/SK 鉴权失败，请重新运行 /login。`);
      }
      if (!response.ok) throw new Error(`方舟 ${action} 请求失败（HTTP ${response.status}）`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`方舟 ${action} 返回了畸形 JSON`);
      }
      const parsed = parsePage(payload, action);
      all.push(...parsed.items);
      projectCount += parsed.items.length;
      debug(`[volcengine] ${action} project=${JSON.stringify(projectName)} page=${page} items=${parsed.items.length} projectItems=${projectCount} total=${parsed.total}`);
      if (projectCount >= parsed.total || parsed.items.length === 0) break;
    }
  }
  return all;
}

export async function fetchEndpointModels(
  context: RefreshModelsContext,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly Model<"openai-completions">[]> {
  if (!context.allowNetwork) return [];
  debug(
    `[volcengine] refresh started; catalogImplementation=${CATALOG_IMPLEMENTATION} builtInSource=InnerDescribeModelEndpoints customSource=ListEndpoints log=${DEBUG_LOG_PATH}`,
  );
  const { accessKeyId, secretAccessKey } = credentials(context);
  let projectNames = ["default"];
  try {
    projectNames = await fetchProjectNames(context, accessKeyId, secretAccessKey, fetchImpl);
  } catch (error) {
    debug(`[volcengine] project discovery failed; using default only: ${error instanceof Error ? error.message : String(error)}`);
  }
  debug(`[volcengine] projects=${JSON.stringify(projectNames)}`);
  const builtInItems = await fetchArkItems(
    "InnerDescribeModelEndpoints",
    projectNames,
    context,
    accessKeyId,
    secretAccessKey,
    fetchImpl,
  );
  const customItems = await fetchArkItems(
    "ListEndpoints",
    projectNames,
    context,
    accessKeyId,
    secretAccessKey,
    fetchImpl,
  );
  const builtInById = new Map<string, Model<"openai-completions">>();
  const mediaById = new Map<string, VolcengineMediaModel>();
  const builtInRejections = new Map<string, number>();
  for (const item of builtInItems) {
    const mediaModel = builtInEndpointToMediaModel(item);
    if (mediaModel) {
      mediaById.set(`${mediaModel.kind}:${mediaModel.inferenceId}`, mediaModel);
      debug(`[volcengine] built-in media accepted ${endpointSummary(item)} kind=${mediaModel.kind} inferenceId=${JSON.stringify(mediaModel.inferenceId)}`);
      continue;
    }
    const model = builtInEndpointToModel(item);
    if (model) {
      builtInById.set(model.id, model);
      debug(`[volcengine] built-in accepted ${endpointSummary(item)} inferenceId=${JSON.stringify(model.id)}`);
      continue;
    }
    const reason = builtInRejectionReason(item) ?? "unknown";
    builtInRejections.set(reason, (builtInRejections.get(reason) ?? 0) + 1);
    debug(`[volcengine] built-in filtered reason=${JSON.stringify(reason)} ${endpointSummary(item)}`);
  }
  const customModels: VolcengineEndpointModel[] = [];
  const customRejections = new Map<string, number>();
  for (const item of customItems) {
    const mediaModel = endpointToMediaModel(item);
    if (mediaModel) {
      mediaById.set(`${mediaModel.kind}:${mediaModel.inferenceId}`, mediaModel);
      debug(`[volcengine] custom media accepted ${endpointSummary(item)} kind=${mediaModel.kind} inferenceId=${JSON.stringify(mediaModel.inferenceId)}`);
      continue;
    }
    const model = endpointToModel(item);
    if (model) {
      customModels.push(model);
      debug(`[volcengine] custom accepted ${endpointSummary(item)} displayId=${JSON.stringify(model.id)} inferenceId=${JSON.stringify(model.endpointId)}`);
      continue;
    }
    const reason = endpointRejectionReason(item) ?? "unknown";
    customRejections.set(reason, (customRejections.get(reason) ?? 0) + 1);
    debug(`[volcengine] custom filtered reason=${JSON.stringify(reason)} ${endpointSummary(item)}`);
  }
  const builtInModels = [...builtInById.values()];
  const uniqueCustomModels = uniqueEndpointModelIds(
    customModels,
    builtInModels.map((model) => model.id),
  );
  cachedMediaModels = [...mediaById.values()];
  debug(
    `[volcengine] refresh succeeded; builtInItems=${builtInItems.length} builtInAccepted=${builtInModels.length} builtInFiltered=${JSON.stringify(Object.fromEntries(builtInRejections))} customItems=${customItems.length} customAccepted=${uniqueCustomModels.length} customFiltered=${JSON.stringify(Object.fromEntries(customRejections))} media=${cachedMediaModels.length}`,
  );
  return [...builtInModels, ...uniqueCustomModels];
}
