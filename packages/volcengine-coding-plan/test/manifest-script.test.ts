import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generatePlanManifest } from "../../../scripts/plan-model-manifest.ts";

test("generator keeps official IDs, handles ambiguity and writes a valid hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-manifest-"));
  const cache = join(directory, "cache.json");
  const ark = join(directory, "ark.json");
  const overrides = join(directory, "overrides.json");
  const output = join(directory, "model-manifest.json");
  await Promise.all([
    writeFile(cache, JSON.stringify({
      source: { commit: "abc" },
      models: {
        "vendor/model-a": { max_input_tokens: 100 },
        "other/model-a": { max_input_tokens: 200 },
      },
    })),
    writeFile(ark, JSON.stringify({
      models: {
        "model-b-260101": {
          name: "model-b",
          displayName: "Model B",
          maxInputTokens: 300,
          maxOutputTokens: 30,
          supportsVision: true,
        },
      },
    })),
    writeFile(overrides, JSON.stringify({
      "model-a": {
        id: "must-not-replace-official-id",
        displayName: "Overridden A",
        maxInputTokens: 400,
      },
    })),
  ]);
  const result = await generatePlanManifest({
    operation: "ListArkCodingPlanModel",
    modelIds: [" model-b ", "model-a", "model-a", ""],
    output,
    liteLLMCache: cache,
    useCache: true,
    arkManifest: ark,
    overrides,
    generatedAt: "2026-08-26T00:00:00.000Z",
  });
  const text = await readFile(output, "utf8");
  const manifest = JSON.parse(text);
  assert.deepEqual(Object.keys(manifest.models), ["model-a", "model-b"]);
  assert.equal(manifest.models["model-a"].id, "model-a");
  assert.equal(manifest.models["model-a"].maxInputTokens, 400);
  assert.equal(manifest.models["model-b"].maxInputTokens, 300);
  assert.ok(result.diagnostics.some((message) => message.includes("ambiguous LiteLLM")));
  assert.equal(result.sha256, createHash("sha256").update(text).digest("hex"));
  const metadata = JSON.parse(
    await readFile(join(directory, "model-manifest.metadata.json"), "utf8"),
  );
  assert.equal(metadata.sha256, result.sha256);
});

test("generator refuses an ambiguous match without a Plan override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-manifest-"));
  const cache = join(directory, "cache.json");
  const ark = join(directory, "ark.json");
  const overrides = join(directory, "overrides.json");
  await Promise.all([
    writeFile(cache, JSON.stringify({
      source: { commit: "abc" },
      models: {
        "vendor/model-a": { max_input_tokens: 100 },
        "other/model-a": { max_input_tokens: 200 },
      },
    })),
    writeFile(ark, JSON.stringify({ models: {} })),
    writeFile(overrides, JSON.stringify({})),
  ]);
  await assert.rejects(
    generatePlanManifest({
      operation: "ListArkCodingPlanModel",
      modelIds: ["model-a"],
      output: join(directory, "model-manifest.json"),
      liteLLMCache: cache,
      useCache: true,
      arkManifest: ark,
      overrides,
    }),
    /requires an explicit Plan override/,
  );
});
