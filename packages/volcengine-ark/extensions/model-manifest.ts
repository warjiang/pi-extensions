import { readFileSync } from "node:fs";
import type { ModelCost } from "@earendil-works/pi-ai";
import { ZERO_COST } from "./constants.ts";
import type {
  EndpointModelInfo,
  ManifestModel,
  ModelManifest,
  ResolvedModelMetadata,
} from "./types.ts";

const PRICE_SCALE = 1_000_000;

const manifest = JSON.parse(
  readFileSync(new URL("./data/model-manifest.json", import.meta.url), "utf8"),
) as ModelManifest;

// Each normalized alias maps to every manifest model identified by that alias.
// For example:
// new Map([
//   ["ep-123", [{ id: "doubao-seed-pro-260215", model }]],
//   ["doubao-seed-pro-260215", [{ id: "doubao-seed-pro-260215", model }]],
//   ["doubao-seed-pro", [
//     { id: "doubao-seed-pro-250115", model: olderModel },
//     { id: "doubao-seed-pro-260215", model },
//   ]],
// ])
const manifestEntries = new Map<string, Array<{ id: string; model: ManifestModel }>>();
for (const [id, model] of Object.entries(manifest.models)) {
  const aliases = [
    id,
    model.name,
    model.name && model.primaryVersion
      ? `${model.name}-${model.primaryVersion}`
      : undefined,
  ];
  for (const alias of aliases) {
    if (!alias) continue;
    const key = normalizeModelKey(alias);
    const entries = manifestEntries.get(key) ?? [];
    if (!entries.some((entry) => entry.id === id)) entries.push({ id, model });
    manifestEntries.set(key, entries);
  }
}

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

// Normalize tag formatting before comparing it with the known tag sets.
// It separates camelCase words, lowercases the value, converts separators to
// spaces, and collapses repeated whitespace.
//
// Examples:
// - "TextEmbedding" -> "text embedding"
// - "speech_synthesis" -> "speech synthesis"
// - " image/video " -> "image video"
function normalizeTag(value: string): string {
  return value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_/-]+/g, " ")
    .replace(/\s+/g, " ");
}

// Convert a model ID, name, version, or alias into a stable manifest lookup key.
// This removes a leading Volcengine provider prefix, converts the value to
// lowercase, replaces non-alphanumeric separators with hyphens, and trims
// leading or trailing hyphens. Equivalent values therefore produce the same
// key when indexing or querying manifestEntries.
//
// Examples:
// - "Volcengine/Doubao_Seed 2.0-Pro-260215"
//   -> "doubao-seed-2-0-pro-260215"
// - "volcengine:DeepSeek-V3.2"
//   -> "deepseek-v3-2"
// - "V3.2"
//   -> "v3-2"
// - "  Seedream@5.0  "
//   -> "seedream-5-0"
export function normalizeModelKey(value: string): string {
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

// Build normalized manifest IDs from an Ark model name and version. When the
// model name already ends with the version, include both the normalized name
// and the explicitly combined form because upstream sources may use either.
// Otherwise, only the combined name-version form is a valid candidate.
//
// Examples:
// - versionedModelIds("Doubao Seed Pro", "260215")
//   -> ["doubao-seed-pro-260215"]
// - versionedModelIds("DeepSeek V3.2", "V3.2")
//   -> ["deepseek-v3-2", "deepseek-v3-2-v3-2"]
// - versionedModelIds("Doubao Seed Pro", undefined)
//   -> []
function versionedModelIds(name: string | undefined, version: string | undefined): string[] {
  if (!name || !version) return [];
  const normalizedName = normalizeModelKey(name);
  const normalizedVersion = normalizeModelKey(version);
  const combined = normalizeModelKey(`${name}-${version}`);
  return normalizedName.endsWith(normalizedVersion)
    ? [normalizedName, combined]
    : [combined];
}

// Resolve several possible endpoint/model identifiers to one manifest entry.
// Matches are deduplicated by manifest ID because different candidates may
// point to the same model. No matches means metadata is unavailable; one match
// is returned directly; multiple matches are reported as ambiguous.
//
// Examples using the manifestEntries index above:
// - findManifest(["ep-unknown"])
//   -> { ambiguousIds: [] }
// - findManifest(["ep-123", "Doubao Seed Pro 260215"])
//   -> {
//        match: { id: "doubao-seed-pro-260215", model },
//        ambiguousIds: [],
//      }
// - findManifest(["Doubao Seed Pro"])
//   -> {
//        ambiguousIds: [
//          "doubao-seed-pro-250115",
//          "doubao-seed-pro-260215",
//        ],
//      }
//
// Returns:
// - match: the resolved manifest entry when exactly one unique model is found.
// - ambiguousIds: the matching manifest IDs when more than one model is found.
//   It is empty when there are zero or one matches. An ambiguous result does
//   not include match because selecting a model would be unsafe.
function findManifest(
  candidates: readonly (string | undefined)[],
): {
  match?: { id: string; model: ManifestModel };
  ambiguousIds: readonly string[];
} {
  const matches = new Map<string, { id: string; model: ManifestModel }>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const match of manifestEntries.get(normalizeModelKey(candidate)) ?? []) {
      matches.set(match.id, match);
    }
  }
  return {
    ...(matches.size === 1 ? { match: [...matches.values()][0] } : {}),
    ambiguousIds: matches.size > 1 ? [...matches.keys()] : [],
  };
}

export function resolveModelMetadata(
  endpoint: EndpointModelInfo,
): ResolvedModelMetadata {
  const reference = endpoint.ModelReference?.FoundationModel;
  const diagnostics: string[] = [];

  // Resolve from the most specific identifier to the broadest one:
  // endpoint ID -> model name with version -> model name.
  // Stop on either a unique match or an ambiguity so a broader fallback cannot
  // silently override conflicting results from a more specific identifier.
  let selected = findManifest([endpoint.Id]);
  if (!selected.match && selected.ambiguousIds.length === 0) {
    selected = findManifest(
      versionedModelIds(reference?.Name, reference?.ModelVersion),
    );
  }
  if (!selected.match && selected.ambiguousIds.length === 0) {
    selected = findManifest([reference?.Name]);
  }
  if (selected.ambiguousIds.length) {
    diagnostics.push(`Ambiguous model manifest entries: ${selected.ambiguousIds.join(", ")}`);
  }
  const matched = selected.match;
  const taskTypes = matched?.model.taskTypes ?? [];
  const domains = matched?.model.domains ?? [];
  // Keep these calls separate to preserve source priority: manifest tags,
  // endpoint type, then manifest mode. Combining the values would instead let
  // classifyTags' video/image/other priority override the source priority.
  const kind = classifyTags([...taskTypes, ...domains])
    ?? classifyTags(endpoint.EndpointModelType ? [endpoint.EndpointModelType] : [])
    ?? classifyTags(matched?.model.mode ? [matched.model.mode] : [])
    ?? "chat";

  return {
    kind,
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
