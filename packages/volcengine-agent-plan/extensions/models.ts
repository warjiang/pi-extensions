import type { ApiKeyCredential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";

const PROVIDER_ID = "volcengine-agent-plan";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const BASE_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  thinkingFormat: "deepseek" as const,
  maxTokensField: "max_tokens" as const,
};
const THINKING = { minimal: null } as const;
const THINKING_MAX = { minimal: null, xhigh: "max" } as const;

interface Baseline {
  id: string;
  name: string;
  vision?: boolean;
  contextWindow: number;
  maxTokens: number;
  maxThinking?: boolean;
}

const BASELINE: Baseline[] = [
  { id: "doubao-seed-2.1-turbo", name: "Doubao Seed 2.1 Turbo", vision: true, contextWindow: 256000, maxTokens: 256000 },
  { id: "doubao-seed-evolving", name: "Doubao Seed Evolving", vision: true, contextWindow: 1024000, maxTokens: 256000 },
  { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1024000, maxTokens: 128000 },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 1024000, maxTokens: 384000, maxThinking: true },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1024000, maxTokens: 384000, maxThinking: true },
  { id: "doubao-seed-2.0-code", name: "Doubao Seed 2.0 Code", vision: true, contextWindow: 256000, maxTokens: 128000 },
  { id: "doubao-seed-2.0-pro", name: "Doubao Seed 2.0 Pro", vision: true, contextWindow: 256000, maxTokens: 128000 },
  { id: "doubao-seed-2.0-lite", name: "Doubao Seed 2.0 Lite", vision: true, contextWindow: 256000, maxTokens: 128000 },
  { id: "minimax-m2.7", name: "MiniMax M2.7", contextWindow: 200000, maxTokens: 128000 },
  { id: "minimax-m3", name: "MiniMax M3", vision: true, contextWindow: 1024000, maxTokens: 128000 },
  { id: "kimi-k2.6", name: "Kimi K2.6", vision: true, contextWindow: 256000, maxTokens: 32000 },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 256000, maxTokens: 32000 },
  { id: "kimi-k3", name: "Kimi K3", vision: true, contextWindow: 1024000, maxTokens: 128000 },
];

function buildModel(model: Baseline): Model<"openai-completions"> {
  return {
    id: model.id,
    name: `${model.name}（Ark Agent Plan）`,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { ...(model.maxThinking ? THINKING_MAX : THINKING) },
    input: model.vision ? ["text", "image"] : ["text"],
    cost: { ...ZERO_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: { ...BASE_COMPAT },
  };
}

export const BASELINE_MODELS = BASELINE.map(buildModel);
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

function parseList(payload: unknown): JsonObject[] {
  const root = object(payload);
  const data = root?.data ?? root?.models ?? object(root?.result)?.items;
  if (!Array.isArray(data)) throw new Error("Agent Plan /models 返回格式已变化");
  return data.map(object).filter((entry): entry is JsonObject => Boolean(entry));
}

export function remoteToModel(entry: JsonObject): Model<"openai-completions"> | undefined {
  const id = text(entry.id ?? entry.model ?? entry.model_id);
  const name = text(entry.name ?? entry.display_name) ?? id;
  const type = text(entry.type ?? entry.object ?? entry.task_type)?.toLowerCase() ?? "";
  const haystack = `${id ?? ""} ${name ?? ""} ${type}`.toLowerCase();
  if (!id || /(embedding|image|video|audio|speech|seedream|seedance)/.test(haystack)) return undefined;
  const limits = object(entry.token_limits ?? entry.limits);
  const modalities = object(entry.modalities);
  const inputs = Array.isArray(modalities?.input_modalities) ? modalities.input_modalities : entry.input_modalities;
  const baseline = BASELINE.find((model) => model.id === id);
  return buildModel({
    id,
    name: name ?? id,
    vision: (Array.isArray(inputs) && inputs.includes("image")) || baseline?.vision,
    contextWindow: positive(limits?.context_window ?? entry.context_window) ?? baseline?.contextWindow ?? 128000,
    maxTokens: positive(limits?.max_output_token_length ?? entry.max_tokens) ?? baseline?.maxTokens ?? 16384,
    maxThinking: baseline?.maxThinking,
  });
}

export async function fetchPlanModels(
  context: RefreshModelsContext,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly Model<"openai-completions">[]> {
  if (!context.allowNetwork) return [];
  const credential = context.credential?.type === "api_key"
    ? context.credential as ApiKeyCredential
    : undefined;
  if (!credential?.key) throw new Error("请运行 /login 配置 Agent Plan API Key。");
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
  const response = await fetchImpl(`${BASE_URL}/models`, {
    headers: { authorization: `Bearer ${credential.key}` },
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Agent Plan API Key 无效或无权限，请重新运行 /login。");
  }
  if (!response.ok) throw new Error(`Agent Plan 模型目录请求失败（HTTP ${response.status}）`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Agent Plan 模型目录返回了畸形 JSON"); }
  return parseList(payload)
    .map(remoteToModel)
    .filter((model): model is Model<"openai-completions"> => Boolean(model));
}
