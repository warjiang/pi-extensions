import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const PROVIDER_ID = "volcengine-ark";

type JsonObject = Record<string, unknown>;

function parseArgs(argv: readonly string[]): {
  agentDir: string;
  cleanConfig: boolean;
  cleanCache: boolean;
} {
  let agentDir = join(homedir(), ".pi", "agent");
  let cleanConfig = false;
  let cleanCache = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      cleanConfig = true;
    } else if (argument === "--cache") {
      cleanCache = true;
    } else if (argument === "--all") {
      cleanConfig = true;
      cleanCache = true;
    } else if (argument === "--agent-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--agent-dir requires a path.");
      agentDir = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!cleanConfig && !cleanCache) {
    throw new Error("Specify --config, --cache, or --all.");
  }
  return { agentDir, cleanConfig, cleanCache };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<JsonObject | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(value)) throw new Error("the root value must be an object");
    return value;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJson(path: string, value: JsonObject): Promise<void> {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function modelIds(provider: unknown): Set<string> {
  if (!isObject(provider) || !Array.isArray(provider.models)) return new Set();
  return new Set(
    provider.models.flatMap((model) =>
      isObject(model) && typeof model.id === "string" ? [model.id] : []
    ),
  );
}

async function cleanModelsConfig(agentDir: string): Promise<void> {
  const modelsPath = join(agentDir, "models.json");
  const models = await readJson(modelsPath);
  if (!models) {
    console.log(`Skipped missing ${modelsPath}`);
    return;
  }

  const providers = models.providers;
  if (!isObject(providers) || !(PROVIDER_ID in providers)) {
    console.log(`No static ${PROVIDER_ID} provider found in ${modelsPath}`);
    return;
  }

  const removedModelIds = modelIds(providers[PROVIDER_ID]);
  delete providers[PROVIDER_ID];
  await writeJson(modelsPath, models);
  console.log(`Removed static ${PROVIDER_ID} provider from ${modelsPath}`);

  const settingsPath = join(agentDir, "settings.json");
  const settings = await readJson(settingsPath);
  if (
    settings
    && settings.defaultProvider === PROVIDER_ID
    && typeof settings.defaultModel === "string"
    && removedModelIds.has(settings.defaultModel)
  ) {
    delete settings.defaultModel;
    await writeJson(settingsPath, settings);
    console.log(`Removed stale defaultModel from ${settingsPath}`);
  }
}

async function cleanModelsCache(agentDir: string): Promise<void> {
  const storePath = join(agentDir, "models-store.json");
  const store = await readJson(storePath);
  if (!store) {
    console.log(`Skipped missing ${storePath}`);
    return;
  }
  if (!(PROVIDER_ID in store)) {
    console.log(`No ${PROVIDER_ID} cache found in ${storePath}`);
    return;
  }

  delete store[PROVIDER_ID];
  await writeJson(storePath, store);
  console.log(`Removed ${PROVIDER_ID} cache from ${storePath}`);
}

const options = parseArgs(process.argv.slice(2));
if (options.cleanConfig) await cleanModelsConfig(options.agentDir);
if (options.cleanCache) await cleanModelsCache(options.agentDir);
