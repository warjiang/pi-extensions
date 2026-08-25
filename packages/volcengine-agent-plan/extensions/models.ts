import type { ApiKeyCredential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { ARKClient } from "@volcengine/ark";
import {
  buildRequestConfigFromMetaPath,
  Command,
  HttpRequestError,
  type CommandOutput,
} from "@volcengine/sdk-core";

const PROVIDER_ID = "volcengine-agent-plan";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const CONTROL_HOST = "ark.cn-beijing.volcengineapi.com";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TIMEOUT_MS = 15_000;
const BASE_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  thinkingFormat: "deepseek" as const,
  maxTokensField: "max_tokens" as const,
};

type PlanModelResponse = {
  Datas?: Array<{ ModelID?: string }>;
};
export type PlanModelCommandOutput =
  Omit<CommandOutput<PlanModelResponse>, "ResponseMetadata">
  & Partial<Pick<CommandOutput<PlanModelResponse>, "ResponseMetadata">>;

export class ListArkAgentPlanModelCommand extends Command<
  Record<string, never>,
  PlanModelCommandOutput,
  "ListArkAgentPlanModelCommand"
> {
  static readonly metaPath = "/ListArkAgentPlanModel/2024-01-01/ark/post/application_json/";

  constructor(input: Record<string, never>) {
    super(input);
    this.requestConfig = buildRequestConfigFromMetaPath(ListArkAgentPlanModelCommand.metaPath);
  }
}

export interface PlanModelClient {
  send(
    command: ListArkAgentPlanModelCommand,
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

function parseModelIds(payload: PlanModelCommandOutput): string[] {
  const apiError = payload.ResponseMetadata?.Error;
  if (apiError) {
    throw new Error(`Agent Plan 模型目录请求失败（${apiError.Code || "UnknownError"}）`);
  }
  const entries = payload.Result?.Datas;
  if (!Array.isArray(entries)) {
    throw new Error("Agent Plan ListArkAgentPlanModel 返回格式已变化");
  }
  return entries
    .map((entry) => entry.ModelID)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
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
  clientFactory: PlanModelClientFactory = createPlanModelClient,
): Promise<readonly Model<"openai-completions">[]> {
  if (!context.allowNetwork) return [];
  const { accessKeyId, secretAccessKey } = credentials(context);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let payload: PlanModelCommandOutput;
  try {
    payload = await clientFactory({ accessKeyId, secretAccessKey }).send(
      new ListArkAgentPlanModelCommand({}),
      { abortSignal: signal },
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (!(error instanceof HttpRequestError)) throw error;
    if (error.status === 401 || error.status === 403) {
      throw new Error("Agent Plan 模型目录 AK/SK 鉴权失败，请重新运行 /login。");
    }
    if (error.data) parseModelIds(error.data as PlanModelCommandOutput);
    if (error.status !== undefined) {
      throw new Error(`Agent Plan 模型目录请求失败（HTTP ${error.status}）`);
    }
    throw error;
  }
  return parseModelIds(payload).map(modelFromId);
}
