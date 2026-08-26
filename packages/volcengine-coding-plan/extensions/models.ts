import { appendFileSync } from "node:fs";
import type { ApiKeyCredential, RefreshModelsContext } from "@earendil-works/pi-ai";
import { HttpRequestError } from "@volcengine/sdk-core";
import {
  createPlanModelClient,
  ListArkCodingPlanModelCommand,
  type PlanModelClientFactory,
} from "./commands.ts";
import {
  CONTROL_HOST,
  DEBUG_LOG_PATH,
  ENV_NAMES,
  PLAN_ACTION,
  REQUEST_TIMEOUT_MS,
} from "./constants.ts";
import { modelFromId } from "./model-manifest.ts";
import type { PlanModelCommandOutput } from "./types.ts";

export {
  ListArkCodingPlanModelCommand,
  type PlanModelClient,
  type PlanModelClientFactory,
} from "./commands.ts";
export type { PlanModelCommandOutput } from "./types.ts";

function debug(message: string): void {
  if (!DEBUG_LOG_PATH) return;
  try {
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Debug logging must never break model refresh.
  }
}

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
    throw new Error("拉取 Coding Plan 模型需要 Access Key 和 Secret Key；请重新运行 /login。");
  }
  return { accessKeyId, secretAccessKey };
}

export function parseModelIds(payload: PlanModelCommandOutput): string[] {
  const apiError = payload.ResponseMetadata?.Error;
  if (apiError) {
    throw new Error(`Coding Plan 模型目录请求失败（${apiError.Code || "UnknownError"}）`);
  }
  const entries = payload.Result?.Datas;
  if (!Array.isArray(entries)) {
    throw new Error("Coding Plan ListArkCodingPlanModel 返回格式已变化");
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Coding Plan ListArkCodingPlanModel 返回格式已变化");
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
  debug(`[volcengine-coding-plan] refresh started; log=${DEBUG_LOG_PATH}`);
  const { accessKeyId, secretAccessKey } = credentials(context);
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ]);
  debug(
    `[volcengine-coding-plan] POST https://${CONTROL_HOST}/?Action=${PLAN_ACTION}&Version=2024-01-01`,
  );
  let payload: PlanModelCommandOutput;
  try {
    payload = await clientFactory({ accessKeyId, secretAccessKey }).send(
      new ListArkCodingPlanModelCommand({}),
      { abortSignal: signal, timeout: REQUEST_TIMEOUT_MS },
    );
  } catch (error) {
    debug(
      `[volcengine-coding-plan] request error: ${
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }`,
    );
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
  try {
    const models = parseModelIds(payload).map(modelFromId);
    debug(`[volcengine-coding-plan] refresh succeeded; models=${models.length}`);
    return models;
  } catch (error) {
    debug(
      `[volcengine-coding-plan] catalog error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}
