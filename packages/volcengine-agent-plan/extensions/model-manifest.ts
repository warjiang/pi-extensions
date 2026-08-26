import { readFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import {
  BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  PROVIDER_ID,
  ZERO_COST,
} from "./constants.ts";
import type {
  PlanManifestModel,
  PlanModelManifest,
} from "./types.ts";

const manifest = JSON.parse(
  readFileSync(new URL("./data/model-manifest.json", import.meta.url), "utf8"),
) as PlanModelManifest;

export function normalizeModelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^volcengine[/:]/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

const entries = new Map<string, PlanManifestModel>();
for (const [key, model] of Object.entries(manifest.models)) {
  for (const alias of [key, model.id, model.displayName]) {
    if (alias) entries.set(normalizeModelKey(alias), model);
  }
}

export function resolveModelMetadata(id: string): PlanManifestModel | undefined {
  return entries.get(normalizeModelKey(id));
}

export function applyCurrentManifestMetadata(
  model: Model<"openai-completions">,
): Model<"openai-completions"> {
  const metadata = resolveModelMetadata(model.id);
  const reasoning = metadata?.supportsReasoning ?? true;
  return {
    ...model,
    name: metadata?.displayName ?? model.name,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning,
    thinkingLevelMap: reasoning
      ? metadata?.supportsMaxThinking
        ? { minimal: null, xhigh: "max" }
        : { minimal: null }
      : undefined,
    input: metadata?.supportsVision ? ["text", "image"] : ["text"],
    cost: { ...ZERO_COST },
    contextWindow: metadata?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      metadata?.maxOutputTokens
      ?? metadata?.maxTokens
      ?? DEFAULT_MAX_TOKENS,
    compat: {
      ...model.compat,
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
      thinkingFormat: reasoning ? "deepseek" : undefined,
      maxTokensField: "max_tokens",
    },
  };
}

export function modelFromId(id: string): Model<"openai-completions"> {
  return applyCurrentManifestMetadata({
    id,
    name: id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { minimal: null },
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  });
}

export function getModelManifest(): PlanModelManifest {
  return manifest;
}
