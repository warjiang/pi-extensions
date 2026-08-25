import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ApiKeyCredential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { ARKClient } from "@volcengine/ark";
import {
  buildRequestConfigFromMetaPath,
  Command,
  HttpRequestError,
  type CommandOutput,
} from "@volcengine/sdk-core";

const PROVIDER_ID = "volcengine-coding-plan";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
const ACTION = "ListArkCodingPlanModel";
const CONTROL_HOST = "ark.cn-beijing.volcengineapi.com";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TIMEOUT_MS = 15_000;
const DEBUG_SETTING = process.env.VOLCENGINE_CODINGPLAN_DEBUG;
const DEBUG_LOG_PATH = DEBUG_SETTING
  ? DEBUG_SETTING === "1"
    ? join(tmpdir(), "volcengine-coding-plan-debug.log")
    : resolve(DEBUG_SETTING)
  : undefined;

type PlanModelResponse = {
  Datas?: Array<{ ModelID?: string }>;
};
export type PlanModelCommandOutput =
  Omit<CommandOutput<PlanModelResponse>, "ResponseMetadata">
  & Partial<Pick<CommandOutput<PlanModelResponse>, "ResponseMetadata">>;

export class ListArkCodingPlanModelCommand extends Command<
  Record<string, never>,
  PlanModelCommandOutput,
  "ListArkCodingPlanModelCommand"
> {
  static readonly metaPath = "/ListArkCodingPlanModel/2024-01-01/ark/post/application_json/";

  constructor(input: Record<string, never>) {
    super(input);
    this.requestConfig = buildRequestConfigFromMetaPath(ListArkCodingPlanModelCommand.metaPath);
  }
}

export interface PlanModelClient {
  send(
    command: ListArkCodingPlanModelCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<PlanModelCommandOutput>;
}

export type PlanModelClientFactory = (
  credentials: { accessKeyId: string; secretAccessKey: string },
) => PlanModelClient;

const createPlanModelClient: PlanModelClientFactory = ({ accessKeyId, secretAccessKey }) =>
  new ARKClient({
    accessKeyId,
    secretAccessKey,
    host: CONTROL_HOST,
    region: "cn-beijing",
  });

function debug(message: string): void {
  if (!DEBUG_LOG_PATH) return;
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    appendFileSync(DEBUG_LOG_PATH, line, "utf8");
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
    throw new Error("拉取 Coding Plan 模型需要 Access Key 和 Secret Key；请重新运行 /login。");
  }
  return { accessKeyId, secretAccessKey };
}

function parseModelIds(payload: PlanModelCommandOutput): string[] {
  const apiError = payload.ResponseMetadata?.Error;
  if (apiError) {
    throw new Error(`Coding Plan 模型目录请求失败（${apiError.Code || "UnknownError"}）`);
  }
  const entries = payload.Result?.Datas;
  if (!Array.isArray(entries)) {
    throw new Error("Coding Plan ListArkCodingPlanModel 返回格式已变化");
  }
  return entries
    .map((entry) => entry.ModelID)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
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
  clientFactory: PlanModelClientFactory = createPlanModelClient,
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
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  debug(`[volcengine-coding-plan] POST https://${CONTROL_HOST}/?Action=${ACTION}&Version=2024-01-01`);
  let payload: PlanModelCommandOutput;
  try {
    payload = await clientFactory({ accessKeyId, secretAccessKey }).send(
      new ListArkCodingPlanModelCommand({}),
      { abortSignal: signal },
    );
  } catch (error) {
    debug(`[volcengine-coding-plan] request error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    if (signal.aborted) throw signal.reason;
    if (!(error instanceof HttpRequestError)) throw error;
    if (error.status === 401 || error.status === 403) {
      throw new Error("Coding Plan 模型目录 AK/SK 鉴权失败，请重新运行 /login。");
    }
    if (error.data) parseModelIds(error.data as PlanModelCommandOutput);
    if (error.status !== undefined) {
      throw new Error(`Coding Plan 模型目录请求失败（HTTP ${error.status}）`);
    }
    throw error;
  }
  debug(`[volcengine-coding-plan] HTTP 200 OK\n${JSON.stringify(payload)}`);
  try {
    const models = parseModelIds(payload).map(modelFromId);
    debug(`[volcengine-coding-plan] refresh succeeded; models=${models.length}`);
    return models;
  } catch (error) {
    debug(`[volcengine-coding-plan] catalog error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
