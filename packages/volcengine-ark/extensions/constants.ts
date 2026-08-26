import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PROVIDER_ID = "volcengine-ark";
export const PROVIDER_NAME = "Volcengine Ark";
export const BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const ENV_NAMES = {
  accessKeyId: "VOLCENGINE_ACCESS_KEY_ID",
  secretAccessKey: "VOLCENGINE_SECRET_ACCESS_KEY",
} as const;

export const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export const PAGE_SIZE = 100;
export const REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const MEDIA_REQUEST_TIMEOUT_MS = 60_000;
export const IMAGE_GENERATION_TIMEOUT_MS = 3 * 60_000;
export const MAX_LOCAL_INPUT_BYTES = 20 * 1024 * 1024;
export const TERMINAL_VIDEO_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

const DEBUG_SETTING = process.env.VOLCENGINE_DEBUG;
export const DEBUG_LOG_PATH = DEBUG_SETTING
  ? DEBUG_SETTING === "1"
    ? join(tmpdir(), "volcengine-ark-debug.log")
    : resolve(DEBUG_SETTING)
  : undefined;
