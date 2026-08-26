import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PROVIDER_ID = "volcengine-coding-plan";
export const PROVIDER_NAME = "Volcengine Coding Plan";
export const BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
export const CONTROL_HOST = "ark.cn-beijing.volcengineapi.com";
export const PLAN_ACTION = "ListArkCodingPlanModel";
export const ENV_NAMES = {
  apiKey: "VOLCENGINE_CODING_PLAN_API_KEY",
  legacyApiKey: "VOLCENGINE_PLAN_API_KEY",
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

const DEBUG_SETTING = process.env.VOLCENGINE_CODINGPLAN_DEBUG;
export const DEBUG_LOG_PATH = DEBUG_SETTING
  ? DEBUG_SETTING === "1"
    ? join(tmpdir(), "volcengine-coding-plan-debug.log")
    : resolve(DEBUG_SETTING)
  : undefined;
