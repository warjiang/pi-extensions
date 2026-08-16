import { createHash, createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ApiKeyCredential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";

const PROVIDER_ID = "volcengine-coding-plan";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
const CONTROL_URL = "https://ark.cn-beijing.volcengineapi.com/";
const ACTION = "ListArkCodingPlanModel";
const VERSION = "2024-01-01";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TIMEOUT_MS = 15_000;
const DEBUG_SETTING = process.env.VOLCENGINE_CODINGPLAN_DEBUG;
const DEBUG_LOG_PATH = DEBUG_SETTING
  ? DEBUG_SETTING === "1"
    ? join(tmpdir(), "volcengine-coding-plan-debug.log")
    : resolve(DEBUG_SETTING)
  : undefined;

type JsonObject = Record<string, unknown>;

function debug(message: string): void {
  if (!DEBUG_LOG_PATH) return;
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    appendFileSync(DEBUG_LOG_PATH, line, "utf8");
  } catch {
    // Debug logging must never break model refresh.
  }
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

export function signPlanModelRequest(
  action: string,
  body: string,
  accessKeyId: string,
  secretAccessKey: string,
  date = new Date(),
): { authorization: string; xDate: string; xContentSha256: string } {
  const xDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = xDate.slice(0, 8);
  const query = `Action=${action}&Version=${VERSION}`;
  const host = new URL(CONTROL_URL).host;
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

function credentials(context: RefreshModelsContext): { accessKeyId: string; secretAccessKey: string } {
  const credential = context.credential?.type === "api_key"
    ? context.credential as ApiKeyCredential
    : undefined;
  const accessKeyId = credential?.env?.VOLCENGINE_ACCESS_KEY_ID;
  const secretAccessKey = credential?.env?.VOLCENGINE_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("拉取 Coding Plan 模型需要 Access Key 和 Secret Key；请重新运行 /login。");
  }
  return { accessKeyId, secretAccessKey };
}

function parseModelIds(payload: unknown): string[] {
  const root = object(payload);
  const metadata = object(root?.ResponseMetadata);
  const apiError = object(metadata?.Error);
  if (apiError) {
    const code = text(apiError.Code) ?? "UnknownError";
    throw new Error(`Coding Plan 模型目录请求失败（${code}）`);
  }
  const result = object(root?.Result);
  if (!Array.isArray(result?.Datas)) {
    throw new Error("Coding Plan ListArkCodingPlanModel 返回格式已变化");
  }
  return result.Datas.map(object)
    .map((entry) => text(entry?.ModelID))
    .filter((id): id is string => Boolean(id));
}

function modelFromId(id: string): Model<"openai-completions"> {
  const normalized = id.toLowerCase();
  const reasoning = /(deepseek|reason|thinking|glm|kimi|minimax)/.test(normalized);
  const vision = /(vision|vl|doubao-seed|kimi|multimodal)/.test(normalized);
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: PROVIDER_ID,
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

export async function fetchPlanModels(
  context: RefreshModelsContext,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly Model<"openai-completions">[]> {
  if (!context.allowNetwork) return [];
  debug(`[volcengine-coding-plan] refresh started; log=${DEBUG_LOG_PATH}`);
  let accessKeyId: string;
  let secretAccessKey: string;
  try {
    ({ accessKeyId, secretAccessKey } = credentials(context));
  } catch (error) {
    debug(`[volcengine-coding-plan] credential error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  const body = "{}";
  const signed = signPlanModelRequest(ACTION, body, accessKeyId, secretAccessKey);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const requestUrl = `${CONTROL_URL}?Action=${ACTION}&Version=${VERSION}`;
  debug(`[volcengine-coding-plan] POST ${requestUrl}`);
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
      signal,
    });
  } catch (error) {
    debug(`[volcengine-coding-plan] request error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    throw error;
  }
  if (DEBUG_LOG_PATH) {
    let responseBody: string;
    try {
      responseBody = await response.clone().text();
    } catch (error) {
      responseBody = `<读取响应失败: ${error instanceof Error ? error.message : String(error)}>`;
    }
    debug(`[volcengine-coding-plan] HTTP ${response.status} ${response.statusText}\n${responseBody}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("Coding Plan 模型目录 AK/SK 鉴权失败，请重新运行 /login。");
  }
  if (!response.ok) throw new Error(`Coding Plan 模型目录请求失败（HTTP ${response.status}）`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    const error = new Error("Coding Plan 模型目录返回了畸形 JSON");
    debug(`[volcengine-coding-plan] parse error: ${error.message}`);
    throw error;
  }
  try {
    const models = parseModelIds(payload).map(modelFromId);
    debug(`[volcengine-coding-plan] refresh succeeded; models=${models.length}`);
    return models;
  } catch (error) {
    debug(`[volcengine-coding-plan] catalog error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
