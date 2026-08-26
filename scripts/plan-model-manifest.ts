import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY = "BerriAI/litellm";
const REF = "litellm_internal_staging";
const SOURCE_FILE = "model_prices_and_context_window.json";

type RecordValue = Record<string, unknown>;

export interface GeneratedPlanModel {
  id: string;
  displayName?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTokens?: number;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsFunctionCalling?: boolean;
  supportsMaxThinking?: boolean;
}

export interface PlanManifestGeneratorOptions {
  operation: "ListArkCodingPlanModel" | "ListArkAgentPlanModel";
  modelIds: readonly string[];
  output: string;
  liteLLMInput?: string;
  liteLLMCache: string;
  useCache?: boolean;
  commit?: string;
  arkManifest: string;
  overrides: string;
  generatedAt?: string;
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeModelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^volcengine[/:]/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function compact<T extends RecordValue>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

function sourcePath(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  const packages = normalized.lastIndexOf("/packages/");
  return packages >= 0 ? normalized.slice(packages + 1) : basename(path);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function capabilities(value: RecordValue): Omit<GeneratedPlanModel, "id"> {
  return compact({
    displayName: typeof value.displayName === "string"
      ? value.displayName
      : typeof value.display_name === "string"
      ? value.display_name
      : undefined,
    maxInputTokens: optionalNumber(value.maxInputTokens)
      ?? optionalNumber(value.max_input_tokens),
    maxOutputTokens: optionalNumber(value.maxOutputTokens)
      ?? optionalNumber(value.max_output_tokens),
    maxTokens: optionalNumber(value.maxTokens) ?? optionalNumber(value.max_tokens),
    supportsVision: optionalBoolean(value.supportsVision)
      ?? optionalBoolean(value.supports_vision),
    supportsReasoning: optionalBoolean(value.supportsReasoning)
      ?? optionalBoolean(value.supports_reasoning),
    supportsFunctionCalling: optionalBoolean(value.supportsFunctionCalling)
      ?? optionalBoolean(value.supports_function_calling),
    supportsMaxThinking: optionalBoolean(value.supportsMaxThinking)
      ?? optionalBoolean(value.supports_max_thinking),
  });
}

function parseObject(text: string, label: string): RecordValue {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed;
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

async function loadLiteLLM(options: PlanManifestGeneratorOptions): Promise<{
  commit: string;
  models: RecordValue;
}> {
  if (options.useCache) {
    const cache = parseObject(
      await readFile(resolve(options.liteLLMCache), "utf8"),
      "LiteLLM cache",
    );
    if (
      !isRecord(cache.source)
      || typeof cache.source.commit !== "string"
      || !isRecord(cache.models)
    ) {
      throw new Error(`Invalid LiteLLM cache: ${options.liteLLMCache}`);
    }
    return { commit: cache.source.commit, models: cache.models };
  }

  const commit = options.commit ?? await resolveCommit();
  const text = options.liteLLMInput
    ? await readFile(resolve(options.liteLLMInput), "utf8")
    : (await execFileAsync("curl", [
      "--fail",
      "--location",
      "--retry",
      "3",
      `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${SOURCE_FILE}`,
    ], { maxBuffer: 10 * 1024 * 1024 })).stdout;
  const models = parseObject(text, "LiteLLM manifest");
  const cache = {
    source: {
      repository: REPOSITORY,
      ref: REF,
      commit,
      cachedAt: new Date().toISOString(),
    },
    models,
  };
  await mkdir(dirname(resolve(options.liteLLMCache)), { recursive: true });
  await writeFile(
    resolve(options.liteLLMCache),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );
  return { commit, models };
}

function addIndex<T>(
  index: Map<string, Array<{ id: string; value: T }>>,
  alias: string | undefined,
  id: string,
  value: T,
): void {
  if (!alias) return;
  const key = normalizeModelKey(alias);
  if (!key) return;
  const entries = index.get(key) ?? [];
  if (!entries.some((entry) => entry.id === id)) entries.push({ id, value });
  index.set(key, entries);
}

function buildLiteLLMIndex(source: RecordValue) {
  const index = new Map<string, Array<{ id: string; value: Omit<GeneratedPlanModel, "id"> }>>();
  for (const [id, raw] of Object.entries(source)) {
    if (!isRecord(raw)) continue;
    const value = capabilities(raw);
    addIndex(index, id, id, value);
    addIndex(index, id.split("/").at(-1), id, value);
  }
  return index;
}

function buildArkIndex(source: RecordValue) {
  const models = isRecord(source.models) ? source.models : {};
  const index = new Map<string, Array<{ id: string; value: Omit<GeneratedPlanModel, "id"> }>>();
  for (const [id, raw] of Object.entries(models)) {
    if (!isRecord(raw)) continue;
    const value = capabilities(raw);
    addIndex(index, id, id, value);
    addIndex(index, typeof raw.name === "string" ? raw.name : undefined, id, value);
    addIndex(
      index,
      typeof raw.displayName === "string" ? raw.displayName : undefined,
      id,
      value,
    );
    const versionless = id
      .replace(/-(?:ga-)?\d{6}$/u, "")
      .replace(/-latest-version$/u, "");
    if (versionless !== id) addIndex(index, versionless, id, value);
  }
  return index;
}

function uniqueMatch<T>(
  index: Map<string, Array<{ id: string; value: T }>>,
  id: string,
): { value?: T; ambiguous: string[] } {
  const matches = index.get(normalizeModelKey(id)) ?? [];
  return {
    ...(matches.length === 1 ? { value: matches[0].value } : {}),
    ambiguous: matches.length > 1 ? matches.map((match) => match.id) : [],
  };
}

export async function generatePlanManifest(
  options: PlanManifestGeneratorOptions,
): Promise<{ count: number; sha256: string; diagnostics: string[] }> {
  const [{ commit, models: liteLLM }, arkText, overridesText] = await Promise.all([
    loadLiteLLM(options),
    readFile(resolve(options.arkManifest), "utf8"),
    readFile(resolve(options.overrides), "utf8"),
  ]);
  const ark = parseObject(arkText, "Ark manifest");
  const overrides = parseObject(overridesText, "Plan overrides");
  const liteIndex = buildLiteLLMIndex(liteLLM);
  const arkIndex = buildArkIndex(ark);
  const diagnostics: string[] = [];
  const uniqueIds = [...new Set(options.modelIds.map((id) => id.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const models: Record<string, GeneratedPlanModel> = {};

  for (const id of uniqueIds) {
    const lite = uniqueMatch(liteIndex, id);
    const arkMatch = uniqueMatch(arkIndex, id);
    const override = overrides[id];
    if (lite.ambiguous.length) {
      diagnostics.push(`${id}: ambiguous LiteLLM matches: ${lite.ambiguous.join(", ")}`);
    }
    if (arkMatch.ambiguous.length) {
      diagnostics.push(`${id}: ambiguous Ark matches: ${arkMatch.ambiguous.join(", ")}`);
    }
    if (override !== undefined && !isRecord(override)) {
      throw new Error(`Plan override must be an object: ${id}`);
    }
    if (!lite.value && !arkMatch.value && !override) {
      if (lite.ambiguous.length || arkMatch.ambiguous.length) {
        throw new Error(
          `${id}: ambiguous capability metadata requires an explicit Plan override`,
        );
      }
      diagnostics.push(`${id}: no capability metadata; runtime defaults will apply`);
    }
    models[id] = compact({
      ...lite.value,
      ...arkMatch.value,
      ...(override as RecordValue | undefined),
      id,
    }) as GeneratedPlanModel;
  }

  const generatedAt = options.generatedAt
    ?? (process.env.SOURCE_DATE_EPOCH
      ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
      : new Date().toISOString());
  const manifest = {
    source: {
      operation: options.operation,
      generatedAt,
      liteLLM: { repository: REPOSITORY, ref: REF, commit },
      arkManifest: sourcePath(options.arkManifest),
      localOverrides: basename(options.overrides),
    },
    models,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const sha256 = createHash("sha256").update(manifestText).digest("hex");
  const output = resolve(options.output);
  const metadata = resolve(dirname(output), "model-manifest.metadata.json");
  await mkdir(dirname(output), { recursive: true });
  await Promise.all([
    writeFile(output, manifestText, "utf8"),
    writeFile(
      metadata,
      `${JSON.stringify({ generatedAt, sha256 }, null, 2)}\n`,
      "utf8",
    ),
  ]);
  return { count: uniqueIds.length, sha256, diagnostics };
}
