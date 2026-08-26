import type { ApiKeyCredential, RefreshModelsContext } from "@earendil-works/pi-ai";
import { HttpRequestError } from "@volcengine/sdk-core";
import {
  createPlanModelClient,
  ListArkAgentPlanModelCommand,
  type PlanModelClientFactory,
} from "./commands.ts";
import {
  ENV_NAMES,
  REQUEST_TIMEOUT_MS,
} from "./constants.ts";
import { modelFromId } from "./model-manifest.ts";
import type { PlanModelCommandOutput } from "./types.ts";

export {
  ListArkAgentPlanModelCommand,
  type PlanModelClient,
  type PlanModelClientFactory,
} from "./commands.ts";
export type { PlanModelCommandOutput } from "./types.ts";

function credentials(context: RefreshModelsContext): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  const credential = context.credential?.type === "api_key"
    ? context.credential as ApiKeyCredential
    : undefined;
  const accessKeyId = credential?.env?.[ENV_NAMES.accessKeyId];
  const secretAccessKey = credential?.env?.[ENV_NAMES.secretAccessKey];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("拉取 Agent Plan 模型需要 Access Key 和 Secret Key；请重新运行 /login。");
  }
  return { accessKeyId, secretAccessKey };
}

export function parseModelIds(payload: PlanModelCommandOutput): string[] {
  const apiError = payload.ResponseMetadata?.Error;
  if (apiError) {
    throw new Error(`Agent Plan 模型目录请求失败（${apiError.Code || "UnknownError"}）`);
  }
  const entries = payload.Result?.Datas;
  if (!Array.isArray(entries)) {
    throw new Error("Agent Plan ListArkAgentPlanModel 返回格式已变化");
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Agent Plan ListArkAgentPlanModel 返回格式已变化");
    }
    const id = entry.ModelID?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export async function fetchPlanModels(
  context: RefreshModelsContext,
  clientFactory: PlanModelClientFactory = createPlanModelClient,
) {
  if (!context.allowNetwork) return [];
  const { accessKeyId, secretAccessKey } = credentials(context);
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ]);
  let payload: PlanModelCommandOutput;
  try {
    payload = await clientFactory({ accessKeyId, secretAccessKey }).send(
      new ListArkAgentPlanModelCommand({}),
      { abortSignal: signal, timeout: REQUEST_TIMEOUT_MS },
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
