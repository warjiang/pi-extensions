import { readFileSync } from "node:fs";
import type { ModelCost } from "@earendil-works/pi-ai";
import { ZERO_COST } from "./constants.ts";

const PRICE_SCALE = 1_000_000;

export interface FoundationModelInfo {
  Name?: string;
  DisplayName?: string;
  PrimaryVersion?: string;
  FoundationModelTag?: {
    Domains?: string[];
    TaskTypes?: string[];
  };
}

export interface EndpointModelInfo {
  Id?: string;
  EndpointModelType?: string;
  ModelReference?: {
    FoundationModel?: {
      Name?: string;
      ModelVersion?: string;
    };
  };
}

export interface ManifestPriceTier {
  inputTokensAbove: number;
  inputCostPerToken: number;
  outputCostPerToken: number;
}

export interface ManifestModel {
  mode?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTokens?: number;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsFunctionCalling?: boolean;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  tieredPricing?: ManifestPriceTier[];
}

interface ModelManifest {
  source: {
    repository: string;
    ref: string;
    commit: string;
    generatedAt: string;
  };
  models: Record<string, ManifestModel>;
}

export interface ResolvedModelMetadata {
  kind: "chat" | "image" | "video" | "other";
  foundation?: FoundationModelInfo;
  manifestId?: string;
  manifest?: ManifestModel;
  taskTypes: readonly string[];
  domains: readonly string[];
  diagnostics: readonly string[];
}

const manifest = JSON.parse(
  readFileSync(new URL("./data/model-manifest.json", import.meta.url), "utf8"),
) as ModelManifest;

const manifestEntries = new Map(
  Object.entries(manifest.models).map(([id, model]) => [normalizeModelId(id), { id, model }]),
);

const IMAGE_TAGS = new Set([
  "image",
  "image generation",
  "image editing",
  "text to image",
  "图像",
  "图像生成",
  "图像编辑",
  "图片生成",
  "文生图",
]);
const VIDEO_TAGS = new Set([
  "video",
  "video generation",
  "text to video",
  "image to video",
  "视频",
  "视频生成",
  "文生视频",
  "图生视频",
]);
const OTHER_TAGS = new Set([
  "audio",
  "embedding",
  "embeddings",
  "speech",
  "speech recognition",
  "speech synthesis",
  "text embedding",
  "asr",
  "tts",
  "音频",
  "语音",
  "向量",
  "向量化",
]);

function normalizeTag(value: string): string {
  return value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_/-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function normalizeModelId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^volcengine[/:]/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function classifyTags(values: readonly string[]): ResolvedModelMetadata["kind"] | undefined {
  const tags = values.map(normalizeTag);
  if (tags.some((tag) => VIDEO_TAGS.has(tag))) return "video";
  if (tags.some((tag) => IMAGE_TAGS.has(tag))) return "image";
  if (tags.some((tag) => OTHER_TAGS.has(tag))) return "other";
  return undefined;
}

function versionedModelIds(name: string | undefined, version: string | undefined): string[] {
  if (!name || !version) return [];
  const normalizedName = normalizeModelId(name);
  const normalizedVersion = normalizeModelId(version);
  const combined = normalizeModelId(`${name}-${version}`);
  return normalizedName.endsWith(normalizedVersion)
    ? [normalizedName, combined]
    : [combined];
}

function findManifest(
  candidates: readonly (string | undefined)[],
): {
  match?: { id: string; model: ManifestModel };
  ambiguousIds: readonly string[];
} {
  const matches = new Map<string, { id: string; model: ManifestModel }>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = manifestEntries.get(normalizeModelId(candidate));
    if (match) matches.set(match.id, match);
  }
  return {
    ...(matches.size === 1 ? { match: [...matches.values()][0] } : {}),
    ambiguousIds: matches.size > 1 ? [...matches.keys()] : [],
  };
}

export function createFoundationModelIndex(
  models: readonly FoundationModelInfo[],
): ReadonlyMap<string, readonly FoundationModelInfo[]> {
  const index = new Map<string, FoundationModelInfo[]>();
  for (const model of models) {
    if (!model.Name) continue;
    const key = normalizeModelId(model.Name);
    const existing = index.get(key);
    if (existing) existing.push(model);
    else index.set(key, [model]);
  }
  return index;
}

export function resolveModelMetadata(
  endpoint: EndpointModelInfo,
  foundationsByName: ReadonlyMap<string, readonly FoundationModelInfo[]>,
): ResolvedModelMetadata {
  const reference = endpoint.ModelReference?.FoundationModel;
  const foundationCandidates = reference?.Name
    ? foundationsByName.get(normalizeModelId(reference.Name)) ?? []
    : [];
  const foundation = foundationCandidates.length === 1
    ? foundationCandidates[0]
    : undefined;
  const diagnostics: string[] = [];
  if (foundationCandidates.length > 1) {
    diagnostics.push(`Ambiguous Ark foundation model: ${reference?.Name}`);
  }
  const taskTypes = foundation?.FoundationModelTag?.TaskTypes ?? [];
  const domains = foundation?.FoundationModelTag?.Domains ?? [];

  const endpointMatch = findManifest([endpoint.Id]);
  const referencedVersionMatch = findManifest(
    versionedModelIds(reference?.Name, reference?.ModelVersion),
  );
  const primaryVersionMatch = findManifest(
    versionedModelIds(foundation?.Name, foundation?.PrimaryVersion),
  );
  const selected = endpointMatch.match || endpointMatch.ambiguousIds.length
    ? endpointMatch
    : referencedVersionMatch.match || referencedVersionMatch.ambiguousIds.length
      ? referencedVersionMatch
      : primaryVersionMatch;
  if (selected.ambiguousIds.length) {
    diagnostics.push(`Ambiguous LiteLLM models: ${selected.ambiguousIds.join(", ")}`);
  }
  const matched = selected.match;
  const kind = classifyTags([...taskTypes, ...domains])
    ?? classifyTags(endpoint.EndpointModelType ? [endpoint.EndpointModelType] : [])
    ?? classifyTags(matched?.model.mode ? [matched.model.mode] : [])
    ?? "chat";

  return {
    kind,
    foundation,
    ...(matched ? { manifestId: matched.id, manifest: matched.model } : {}),
    taskTypes,
    domains,
    diagnostics,
  };
}

function scaledPrice(value: number | undefined): number {
  return Number(((value ?? 0) * PRICE_SCALE).toPrecision(12));
}

export function modelCost(model: ManifestModel | undefined): ModelCost {
  const tiers = model?.tieredPricing;
  if (tiers?.length) {
    const [base, ...rest] = tiers;
    return {
      input: scaledPrice(base.inputCostPerToken),
      output: scaledPrice(base.outputCostPerToken),
      cacheRead: 0,
      cacheWrite: 0,
      ...(rest.length
        ? {
            tiers: rest.map((tier) => ({
              inputTokensAbove: tier.inputTokensAbove,
              input: scaledPrice(tier.inputCostPerToken),
              output: scaledPrice(tier.outputCostPerToken),
              cacheRead: 0,
              cacheWrite: 0,
            })),
          }
        : {}),
    };
  }
  if (model?.inputCostPerToken !== undefined || model?.outputCostPerToken !== undefined) {
    return {
      input: scaledPrice(model.inputCostPerToken),
      output: scaledPrice(model.outputCostPerToken),
      cacheRead: 0,
      cacheWrite: 0,
    };
  }
  return { ...ZERO_COST };
}

export function getModelManifest(): ModelManifest {
  return manifest;
}
