#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePlanManifest } from "../../../scripts/plan-model-manifest.ts";
import { ENV_NAMES } from "../extensions/constants.ts";
import {
  createPlanModelClient,
  ListArkAgentPlanModelCommand,
} from "../extensions/commands.ts";
import { parseModelIds } from "../extensions/models.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const modelsInput = value("--models-input");

async function modelIds(): Promise<string[]> {
  if (modelsInput) {
    const parsed: unknown = JSON.parse(await readFile(resolve(modelsInput), "utf8"));
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === "string");
    }
    return parseModelIds(parsed as Parameters<typeof parseModelIds>[0]);
  }
  const accessKeyId = process.env[ENV_NAMES.accessKeyId];
  const secretAccessKey = process.env[ENV_NAMES.secretAccessKey];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`${ENV_NAMES.accessKeyId} and ${ENV_NAMES.secretAccessKey} are required.`);
  }
  return parseModelIds(await createPlanModelClient({
    accessKeyId,
    secretAccessKey,
  }).send(new ListArkAgentPlanModelCommand({}), {
    abortSignal: AbortSignal.timeout(15_000),
    timeout: 15_000,
  }));
}

const result = await generatePlanManifest({
  operation: "ListArkAgentPlanModel",
  modelIds: await modelIds(),
  output: resolve(value("--output") ?? `${directory}/../extensions/data/model-manifest.json`),
  liteLLMInput: value("--input"),
  liteLLMCache: resolve(
    value("--cache") ?? `${directory}/../../volcengine-ark/scripts/data/litellm-model-manifest.json`,
  ),
  useCache: has("--use-cache"),
  commit: value("--commit"),
  arkManifest: resolve(
    value("--ark-manifest") ?? `${directory}/../../volcengine-ark/extensions/data/model-manifest.json`,
  ),
  overrides: resolve(value("--overrides") ?? `${directory}/data/model-overrides.json`),
});
for (const diagnostic of result.diagnostics) console.warn(diagnostic);
console.log(`Wrote ${result.count} Agent Plan models; sha256=${result.sha256}`);
