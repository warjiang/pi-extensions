import { createHash, createHmac } from "node:crypto";
import type { ApiKeyCredential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";

const PROVIDER_ID = "volcengine-agent-plan";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const CONTROL_URL = "https://ark.cn-beijing.volcengineapi.com/";
const ACTION = "ListArkAgentPlanModel";
const VERSION = "2024-01-01";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TIMEOUT_MS = 15_000;
const BASE_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  thinkingFormat: "deepseek" as const,
  maxTokensField: "max_tokens" as const,
};

type JsonObject = Record<string, unknown>;

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
    throw new Error("拉取 Agent Plan 模型需要 Access Key 和 Secret Key；请重新运行 /login。");
  }
  return { accessKeyId, secretAccessKey };
}

function parseModelIds(payload: unknown): string[] {
  const root = object(payload);
  const metadata = object(root?.ResponseMetadata);
  const apiError = object(metadata?.Error);
  if (apiError) {
    const code = text(apiError.Code) ?? "UnknownError";
    throw new Error(`Agent Plan 模型目录请求失败（${code}）`);
  }
  const result = object(root?.Result);
  if (!Array.isArray(result?.Datas)) {
    throw new Error("Agent Plan ListArkAgentPlanModel 返回格式已变化");
  }
  return result.Datas.map(object)
    .map((entry) => text(entry?.ModelID))
    .filter((id): id is string => Boolean(id));
}

function modelFromId(id: string): Model<"openai-completions"> {
  const normalized = id.toLowerCase();
  const vision = /(vision|vl|doubao-seed|kimi|multimodal)/.test(normalized);
  const supportsMaxThinking = /deepseek/.test(normalized);
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: supportsMaxThinking ? { minimal: null, xhigh: "max" } : { minimal: null },
    input: vision ? ["text", "image"] : ["text"],
    cost: { ...ZERO_COST },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: { ...BASE_COMPAT },
  };
}

export async function fetchPlanModels(
  context: RefreshModelsContext,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly Model<"openai-completions">[]> {
  if (!context.allowNetwork) return [];
  const { accessKeyId, secretAccessKey } = credentials(context);
  const body = "{}";
  const signed = signPlanModelRequest(ACTION, body, accessKeyId, secretAccessKey);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const response = await fetchImpl(`${CONTROL_URL}?Action=${ACTION}&Version=${VERSION}`, {
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
  if (response.status === 401 || response.status === 403) {
    throw new Error("Agent Plan 模型目录 AK/SK 鉴权失败，请重新运行 /login。");
  }
  if (!response.ok) throw new Error(`Agent Plan 模型目录请求失败（HTTP ${response.status}）`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Agent Plan 模型目录返回了畸形 JSON"); }
  return parseModelIds(payload).map(modelFromId);
}
