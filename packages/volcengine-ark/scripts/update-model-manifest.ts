#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ARKClient,
  GetFoundationModelVersionCommand,
  ListFoundationModelsCommand,
} from "@volcengine/ark";
import {
  ENV_NAMES,
  PAGE_SIZE,
  REQUEST_TIMEOUT_MS,
} from "../extensions/constants.ts";
import type {
  FoundationModel,
  FoundationModelManifestSource,
  LiteLLMManifestCache,
  ManifestModel,
  ManifestPriceTier,
  ModelManifestUpdateOptions,
} from "../extensions/types.ts";

const execFileAsync = promisify(execFile);
const REPOSITORY = "BerriAI/litellm";
const REF = "litellm_internal_staging";
const SOURCE_FILE = "model_prices_and_context_window.json";
const CACHE_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "data/litellm-model-manifest.json",
);
const OUTPUT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../extensions/data/model-manifest.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeModelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^volcengine[/:]/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  );
}

function parseArguments(argv: string[]): ModelManifestUpdateOptions {
  const options: ModelManifestUpdateOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") options.input = argv[++index];
    else if (argument === "--foundation-models-input") {
      options.foundationModelsInput = argv[++index];
    }
    else if (argument === "--commit") options.commit = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--cache") options.cache = argv[++index];
    else if (argument === "--use-cache") options.useCache = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.input && options.useCache) {
    throw new Error("--input and --use-cache cannot be used together.");
  }
  if (options.commit && options.useCache) {
    throw new Error("--commit cannot be used with --use-cache; the cache stores its source commit.");
  }
  return options;
}

async function resolveCommit(): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "ls-remote",
    `https://github.com/${REPOSITORY}.git`,
    `refs/heads/${REF}`,
  ]);
  const commit = stdout.trim().split(/\s+/)[0];
  if (!commit) throw new Error(`Could not resolve ${REPOSITORY}@${REF}`);
  return commit;
}

function parseSource(text: string): Record<string, unknown> {
  const source: unknown = JSON.parse(text);
  if (!isRecord(source)) throw new Error("LiteLLM model manifest must be a JSON object.");
  return source;
}

async function loadCache(cacheFile: string): Promise<{
  commit: string;
  source: Record<string, unknown>;
}> {
  const parsed: unknown = JSON.parse(await readFile(cacheFile, "utf8"));
  if (
    !isRecord(parsed)
    || !isRecord(parsed.source)
    || parsed.source.repository !== REPOSITORY
    || parsed.source.ref !== REF
    || typeof parsed.source.commit !== "string"
    || !parsed.source.commit
    || !isRecord(parsed.models)
  ) {
    throw new Error(`Invalid LiteLLM manifest cache: ${cacheFile}`);
  }
  return {
    commit: parsed.source.commit,
    source: parsed.models,
  };
}

async function writeCache(
  cacheFile: string,
  commit: string,
  source: Record<string, unknown>,
): Promise<void> {
  const cache: LiteLLMManifestCache = {
    source: {
      repository: REPOSITORY,
      ref: REF,
      commit,
      cachedAt: new Date().toISOString(),
    },
    models: source,
  };
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function loadSource(
  options: ModelManifestUpdateOptions,
): Promise<{ commit: string; source: Record<string, unknown> }> {
  const cacheFile = resolve(options.cache ?? CACHE_FILE);
  if (options.useCache) return loadCache(cacheFile);

  const commit = options.commit ?? await resolveCommit();
  if (options.input) {
    return {
      commit,
      source: parseSource(await readFile(resolve(options.input), "utf8")),
    };
  }

  const text = (await execFileAsync("curl", [
    "--fail",
    "--location",
    "--retry",
    "3",
    `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${SOURCE_FILE}`,
  ], { maxBuffer: 10 * 1024 * 1024 })).stdout;
  const source = parseSource(text);
  await writeCache(cacheFile, commit, source);
  return { commit, source };
}

function convertTier(tier: unknown): ManifestPriceTier | undefined {
  if (!isRecord(tier) || !Array.isArray(tier.range)) return undefined;
  const start = optionalNumber(tier.range[0]);
  const inputCostPerToken = optionalNumber(tier.input_cost_per_token);
  const outputCostPerToken = optionalNumber(tier.output_cost_per_token);
  if (start === undefined || inputCostPerToken === undefined || outputCostPerToken === undefined) {
    return undefined;
  }
  return { inputTokensAbove: start, inputCostPerToken, outputCostPerToken };
}

function convertCapabilities(value: Record<string, unknown>): ManifestModel {
  return compactRecord({
    mode: typeof value.mode === "string" ? value.mode : undefined,
    maxInputTokens: optionalNumber(value.max_input_tokens),
    maxOutputTokens: optionalNumber(value.max_output_tokens),
    maxTokens: optionalNumber(value.max_tokens),
    supportsVision: optionalBoolean(value.supports_vision),
    supportsReasoning: optionalBoolean(value.supports_reasoning),
    supportsFunctionCalling: optionalBoolean(value.supports_function_calling),
  });
}

function convertModel(value: Record<string, unknown>): ManifestModel {
  const tiers = Array.isArray(value.tiered_pricing)
    ? value.tiered_pricing
        .map(convertTier)
        .filter((tier): tier is ManifestPriceTier => tier !== undefined)
    : undefined;
  return compactRecord({
    ...convertCapabilities(value),
    inputCostPerToken: optionalNumber(value.input_cost_per_token),
    outputCostPerToken: optionalNumber(value.output_cost_per_token),
    ...(tiers?.length ? { tieredPricing: tiers } : {}),
  });
}

function capabilityScore(model: ManifestModel): number {
  return [
    model.mode,
    model.maxInputTokens,
    model.maxOutputTokens,
    model.maxTokens,
    model.supportsVision,
    model.supportsReasoning,
    model.supportsFunctionCalling,
  ].filter((value) => value !== undefined).length;
}

async function listFoundationModels(
  input: string | undefined,
): Promise<FoundationModelManifestSource[]> {
  if (input) {
    const parsed: unknown = JSON.parse(await readFile(resolve(input), "utf8"));
    if (Array.isArray(parsed)) return parsed as FoundationModelManifestSource[];
    if (
      isRecord(parsed)
      && isRecord(parsed.Result)
      && Array.isArray(parsed.Result.Items)
    ) {
      return parsed.Result.Items as FoundationModelManifestSource[];
    }
    throw new Error("Ark foundation model input must be an array or an SDK response.");
  }

  const accessKeyId = process.env[ENV_NAMES.accessKeyId];
  const secretAccessKey = process.env[ENV_NAMES.secretAccessKey];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `${ENV_NAMES.accessKeyId} and ${ENV_NAMES.secretAccessKey} are required to list Ark foundation models.`,
    );
  }
  const client = new ARKClient({
    accessKeyId,
    secretAccessKey,
    region: "cn-beijing",
  });
  const models: FoundationModel[] = [];
  for (let pageNumber = 1; ; pageNumber += 1) {
    const response = await client.send(new ListFoundationModelsCommand({
      PageNumber: pageNumber,
      PageSize: PAGE_SIZE,
    }), {
      timeout: REQUEST_TIMEOUT_MS,
    });
    const items = response.Result?.Items ?? [];
    models.push(...items);
    const totalCount = response.Result?.TotalCount;
    if (
      items.length === 0
      || (totalCount !== undefined && models.length >= totalCount)
      || (totalCount === undefined && items.length < PAGE_SIZE)
    ) {
      break;
    }
  }

  const enriched: FoundationModelManifestSource[] = [];
  const failedVersionLookups: string[] = [];
  // ListFoundationModels does not expose context-window limits. Resolve each
  // primary version once while generating the static manifest so runtime model
  // discovery never needs model-name-specific overrides or extra API calls.
  for (let offset = 0; offset < models.length; offset += 10) {
    const batch = models.slice(offset, offset + 10);
    enriched.push(...await Promise.all(batch.map(async (model) => {
      if (!model.Name || !model.PrimaryVersion) return model;
      try {
        const response = await client.send(new GetFoundationModelVersionCommand({
          FoundationModelName: model.Name,
          ModelVersion: model.PrimaryVersion,
        }), {
          timeout: REQUEST_TIMEOUT_MS,
        });
        const maxInputTokens =
          response.Result?.Configuration?.AppSettings?.MaxInputTokenLength;
        return maxInputTokens === undefined
          ? model
          : { ...model, maxInputTokens };
      } catch {
        failedVersionLookups.push(`${model.Name}@${model.PrimaryVersion}`);
        return model;
      }
    })));
  }
  if (failedVersionLookups.length) {
    console.warn(
      `Could not load Ark version metadata for ${failedVersionLookups.length} models: `
        + failedVersionLookups.join(", "),
    );
  }
  return enriched;
}

const options = parseArguments(process.argv.slice(2));
const { commit, source } = await loadSource(options);
const foundationModels = await listFoundationModels(options.foundationModelsInput);
const outputFile = resolve(options.output ?? OUTPUT_FILE);
const outputDirectory = dirname(outputFile);
const outputBaseName = basename(outputFile, extname(outputFile));
const metadataFile = join(outputDirectory, `${outputBaseName}.metadata.json`);
const liteLLMModels = new Map<string, ManifestModel>();
// Cross-provider entries provide model-level capabilities only. Pricing remains
// Volcengine-specific and is never copied from this fallback index.
const fallbackCapabilities = new Map<string, ManifestModel>();

for (const [upstreamId, value] of Object.entries(source)) {
  if (!isRecord(value)) continue;
  if (value.litellm_provider === "volcengine") {
    const id = normalizeModelKey(upstreamId);
    if (!id) continue;
    if (liteLLMModels.has(id)) {
      throw new Error(`Duplicate normalized Volcengine model id: ${id}`);
    }
    liteLLMModels.set(id, convertModel(value));
    continue;
  }

  // Match provider-prefixed IDs such as "dashscope/glm-5.2" to the Ark model
  // name "glm-5-2". Prefer the candidate with the most capability metadata.
  const modelName = upstreamId.split("/").at(-1);
  const id = modelName ? normalizeModelKey(modelName) : "";
  if (!id) continue;
  const capabilities = convertCapabilities(value);
  const existing = fallbackCapabilities.get(id);
  if (!existing || capabilityScore(capabilities) > capabilityScore(existing)) {
    fallbackCapabilities.set(id, capabilities);
  }
}

const models: Record<string, ManifestModel> = {};
for (const foundation of foundationModels) {
  const name = foundation.Name?.trim();
  if (!name) continue;
  const primaryVersion = foundation.PrimaryVersion?.trim();
  const normalizedName = normalizeModelKey(name);
  const normalizedVersion = primaryVersion
    ? normalizeModelKey(primaryVersion)
    : undefined;
  const id = normalizedVersion && !normalizedName.endsWith(normalizedVersion)
    ? normalizeModelKey(`${name}-${primaryVersion}`)
    : normalizedName;
  if (!id) continue;
  if (models[id]) {
    throw new Error(`Duplicate normalized Ark foundation model id: ${id}`);
  }
  const baseModelName = normalizedName.endsWith("-ga")
    ? normalizedName.slice(0, -3)
    : undefined;
  const liteLLM = liteLLMModels.get(id)
    ?? liteLLMModels.get(normalizedName)
    ?? fallbackCapabilities.get(id)
    ?? fallbackCapabilities.get(normalizedName)
    ?? (baseModelName ? fallbackCapabilities.get(baseModelName) : undefined);
  models[id] = {
    name,
    ...(foundation.DisplayName ? { displayName: foundation.DisplayName } : {}),
    ...(primaryVersion ? { primaryVersion } : {}),
    ...(foundation.FoundationModelTag?.TaskTypes?.length
      ? { taskTypes: foundation.FoundationModelTag.TaskTypes }
      : {}),
    ...(foundation.FoundationModelTag?.Domains?.length
      ? { domains: foundation.FoundationModelTag.Domains }
      : {}),
    ...liteLLM,
    ...(foundation.maxInputTokens !== undefined
      ? { maxInputTokens: foundation.maxInputTokens }
      : {}),
  };
}

const sortedModels = Object.fromEntries(
  Object.entries(models).sort(([left], [right]) => left.localeCompare(right)),
);
const generatedAt = new Date().toISOString();
const manifest = {
  source: {
    repository: REPOSITORY,
    ref: REF,
    commit,
    generatedAt,
    arkOperation: "ListFoundationModels",
  },
  models: sortedModels,
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const sha256 = createHash("sha256").update(manifestText).digest("hex");
const metadataText = `${JSON.stringify({ generatedAt, sha256 }, null, 2)}\n`;

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(outputFile, manifestText, "utf8"),
  writeFile(metadataFile, metadataText, "utf8"),
]);
console.log(`Wrote ${Object.keys(sortedModels).length} Ark foundation models to ${outputFile}`);
