import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_DIR = resolve(import.meta.dirname, "..");

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("removes only the static Volcengine provider and its stale default model", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "volcengine-clean-config-"));
  const modelsPath = join(agentDir, "models.json");
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      "volcengine-ark": {
        models: [{ id: "deepseek-v4-pro-260425" }],
      },
      other: {
        models: [{ id: "other-model" }],
      },
    },
  }));
  await writeFile(settingsPath, JSON.stringify({
    defaultProvider: "volcengine-ark",
    defaultModel: "deepseek-v4-pro-260425",
    theme: "dark",
  }));

  try {
    await execFileAsync(process.execPath, [
      "scripts/clean-local-models.ts",
      "--config",
      "--agent-dir",
      agentDir,
    ], { cwd: PACKAGE_DIR });

    assert.deepEqual(await readJson(modelsPath), {
      providers: {
        other: {
          models: [{ id: "other-model" }],
        },
      },
    });
    assert.deepEqual(await readJson(settingsPath), {
      defaultProvider: "volcengine-ark",
      theme: "dark",
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("removes only the Volcengine model cache", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "volcengine-clean-cache-"));
  const storePath = join(agentDir, "models-store.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(storePath, JSON.stringify({
    "volcengine-ark": {
      models: [{ id: "deepseek-v4-pro" }],
    },
    other: {
      models: [{ id: "other-model" }],
    },
  }));

  try {
    await execFileAsync(process.execPath, [
      "scripts/clean-local-models.ts",
      "--cache",
      "--agent-dir",
      agentDir,
    ], { cwd: PACKAGE_DIR });

    assert.deepEqual(await readJson(storePath), {
      other: {
        models: [{ id: "other-model" }],
      },
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
