export const PROVIDER_ID = "volcengine-agent-plan";
export const PROVIDER_NAME = "Volcengine Agent Plan";
export const BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
export const CONTROL_HOST = "ark.cn-beijing.volcengineapi.com";
export const PLAN_ACTION = "ListArkAgentPlanModel";
export const ENV_NAMES = {
  apiKey: "VOLCENGINE_AGENT_PLAN_API_KEY",
  legacyApiKey: "ARK_API_KEY",
  accessKeyId: "VOLCENGINE_ACCESS_KEY_ID",
  secretAccessKey: "VOLCENGINE_SECRET_ACCESS_KEY",
} as const;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const REQUEST_TIMEOUT_MS = 15_000;
export const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
