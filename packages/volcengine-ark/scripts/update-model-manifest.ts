#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY = "BerriAI/litellm";
const REF = "litellm_internal_staging";
const SOURCE_FILE = "model_prices_and_context_window.json";
const OUTPUT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../extensions/data/model-manifest.json",
);

interface Options {
  input?: string;
  commit?: string;
  output?: string;
}

interface ManifestPriceTier {
  inputTokensAbove: number;
  inputCostPerToken: number;
  outputCostPerToken: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeModelId(value: string): string {
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

function parseArguments(argv: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") options.input = argv[++index];
    else if (argument === "--commit") options.commit = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
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

async function loadSource(
  input: string | undefined,
  commit: string,
): Promise<Record<string, unknown>> {
  const text = input
    ? await readFile(resolve(input), "utf8")
    : (await execFileAsync("curl", [
        "--fail",
        "--location",
        "--retry",
        "3",
        `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${SOURCE_FILE}`,
      ], { maxBuffer: 10 * 1024 * 1024 })).stdout;
  const source: unknown = JSON.parse(text);
  if (!isRecord(source)) throw new Error("LiteLLM model manifest must be a JSON object.");
  return source;
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

function convertModel(value: Record<string, unknown>): Record<string, unknown> {
  const tiers = Array.isArray(value.tiered_pricing)
    ? value.tiered_pricing
        .map(convertTier)
        .filter((tier): tier is ManifestPriceTier => tier !== undefined)
    : undefined;
  return compactRecord({
    mode: typeof value.mode === "string" ? value.mode : undefined,
    maxInputTokens: optionalNumber(value.max_input_tokens),
    maxOutputTokens: optionalNumber(value.max_output_tokens),
    maxTokens: optionalNumber(value.max_tokens),
    supportsVision: optionalBoolean(value.supports_vision),
    supportsReasoning: optionalBoolean(value.supports_reasoning),
    supportsFunctionCalling: optionalBoolean(value.supports_function_calling),
    inputCostPerToken: optionalNumber(value.input_cost_per_token),
    outputCostPerToken: optionalNumber(value.output_cost_per_token),
    ...(tiers?.length ? { tieredPricing: tiers } : {}),
  });
}

const options = parseArguments(process.argv.slice(2));
const commit = options.commit ?? await resolveCommit();
const source = await loadSource(options.input, commit);
const outputFile = resolve(options.output ?? OUTPUT_FILE);
const outputDirectory = dirname(outputFile);
const outputBaseName = basename(outputFile, extname(outputFile));
const metadataFile = join(outputDirectory, `${outputBaseName}.metadata.json`);
const models: Record<string, Record<string, unknown>> = {};

for (const [upstreamId, value] of Object.entries(source)) {
  if (!isRecord(value) || value.litellm_provider !== "volcengine") {
    continue;
  }
  const id = normalizeModelId(upstreamId);
  if (!id) continue;
  if (models[id]) {
    throw new Error(`Duplicate normalized Volcengine model id: ${id}`);
  }
  models[id] = convertModel(value);
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
console.log(`Wrote ${Object.keys(sortedModels).length} Volcengine models to ${outputFile}`);
