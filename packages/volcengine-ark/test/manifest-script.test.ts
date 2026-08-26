import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_DIR = resolve(import.meta.dirname, "..");

test("generates a filtered and stable Volcengine manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "volcengine-manifest-"));
  const input = join(directory, "input.json");
  const foundationModelsInput = join(directory, "foundation-models.json");
  const overrides = join(directory, "overrides.json");
  const output = join(directory, "nested", "manifest.json");
  await writeFile(input, JSON.stringify({
    "volcengine/Z_Model": {
      litellm_provider: "volcengine",
      mode: "chat",
      max_input_tokens: 10,
      supports_reasoning: true,
      ignored: "value",
    },
    "a-model": {
      litellm_provider: "volcengine",
      mode: "chat",
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
    },
    "other-model": {
      litellm_provider: "other",
      mode: "chat",
    },
    "dashscope/glm-5.2": {
      litellm_provider: "dashscope",
      mode: "chat",
      max_input_tokens: 1048576,
      max_output_tokens: 131072,
      max_tokens: 131072,
      supports_reasoning: true,
      supports_function_calling: true,
      input_cost_per_token: 0.0000014,
      output_cost_per_token: 0.0000044,
    },
    "deepseek/deepseek-v4-pro": {
      litellm_provider: "deepseek",
      mode: "chat",
      max_input_tokens: 1048576,
      max_output_tokens: 384000,
      supports_reasoning: true,
    },
    "volcengine/doubao-seed-evolving-latest-version": {
      litellm_provider: "volcengine",
      mode: "chat",
      max_input_tokens: 128000,
    },
  }), "utf8");
  await writeFile(foundationModelsInput, JSON.stringify([
    {
      Name: "Z Model",
      DisplayName: "Z Model Display",
      FoundationModelTag: {
        TaskTypes: ["Text Generation"],
        Domains: ["Multimodal"],
      },
    },
    {
      Name: "A Model",
    },
    {
      Name: "Image Model 1.0",
      PrimaryVersion: "1.0",
      FoundationModelTag: {
        TaskTypes: ["Image Generation"],
      },
    },
    {
      Name: "glm-5-2",
      DisplayName: "GLM-5.2",
      PrimaryVersion: "260617",
      FoundationModelTag: {
        Domains: ["LLM"],
      },
    },
    {
      Name: "deepseek-v4-pro-ga",
      DisplayName: "DeepSeek-V4-Pro正式版",
      PrimaryVersion: "260813",
      FoundationModelTag: {
        TaskTypes: ["Chat"],
        Domains: ["LLM"],
      },
    },
    {
      Name: "doubao-seed-evolving",
      DisplayName: "Doubao-Seed-Evolving",
      PrimaryVersion: "latest-version",
      FoundationModelTag: {
        TaskTypes: ["Chat", "VisualQuestionAnswering"],
        Domains: ["LLM"],
      },
    },
  ]), "utf8");
  await writeFile(overrides, JSON.stringify({
    "volcengine/doubao-seed-evolving-latest-version": {
      litellm_provider: "volcengine",
      max_input_tokens: 1048576,
      max_output_tokens: 262144,
      max_tokens: 262144,
      supports_vision: true,
      supports_reasoning: true,
      supports_function_calling: true,
    },
  }), "utf8");

  try {
    const { stderr } = await execFileAsync(process.execPath, [
      "scripts/update-model-manifest.ts",
      "--input",
      input,
      "--foundation-models-input",
      foundationModelsInput,
      "--overrides",
      overrides,
      "--commit",
      "0123456789abcdef0123456789abcdef01234567",
      "--output",
      output,
    ], { cwd: PACKAGE_DIR });
    assert.match(
      stderr,
      /No LiteLLM or local override metadata for 1 Ark models:\n- image-model-1-0/,
    );
    assert.match(stderr, /Incomplete token metadata for \d+ Ark chat models:/);
    const manifestText = await readFile(output, "utf8");
    const generated = JSON.parse(manifestText);
    const metadata = JSON.parse(await readFile(
      join(directory, "nested", "manifest.metadata.json"),
      "utf8",
    ));
    assert.deepEqual(
      Object.keys(generated.models),
      [
        "a-model",
        "deepseek-v4-pro-ga-260813",
        "doubao-seed-evolving-latest-version",
        "glm-5-2-260617",
        "image-model-1-0",
        "z-model",
      ],
    );
    assert.deepEqual(generated.models["z-model"], {
      name: "Z Model",
      displayName: "Z Model Display",
      taskTypes: ["Text Generation"],
      domains: ["Multimodal"],
      mode: "chat",
      maxInputTokens: 10,
      supportsReasoning: true,
    });
    assert.deepEqual(generated.models["image-model-1-0"], {
      name: "Image Model 1.0",
      primaryVersion: "1.0",
      taskTypes: ["Image Generation"],
    });
    assert.deepEqual(generated.models["glm-5-2-260617"], {
      name: "glm-5-2",
      displayName: "GLM-5.2",
      primaryVersion: "260617",
      domains: ["LLM"],
      mode: "chat",
      maxInputTokens: 1_048_576,
      maxOutputTokens: 131_072,
      maxTokens: 131_072,
      supportsReasoning: true,
      supportsFunctionCalling: true,
    });
    assert.deepEqual(generated.models["deepseek-v4-pro-ga-260813"], {
      name: "deepseek-v4-pro-ga",
      displayName: "DeepSeek-V4-Pro正式版",
      primaryVersion: "260813",
      taskTypes: ["Chat"],
      domains: ["LLM"],
      mode: "chat",
      maxInputTokens: 1_048_576,
      maxOutputTokens: 384_000,
      supportsReasoning: true,
    });
    assert.deepEqual(generated.models["doubao-seed-evolving-latest-version"], {
      name: "doubao-seed-evolving",
      displayName: "Doubao-Seed-Evolving",
      primaryVersion: "latest-version",
      taskTypes: ["Chat", "VisualQuestionAnswering"],
      domains: ["LLM"],
      mode: "chat",
      maxInputTokens: 1_048_576,
      maxOutputTokens: 262_144,
      maxTokens: 262_144,
      supportsVision: true,
      supportsReasoning: true,
      supportsFunctionCalling: true,
    });
    assert.equal(generated.models["other-model"], undefined);
    assert.equal(
      generated.source.commit,
      "0123456789abcdef0123456789abcdef01234567",
    );
    assert.equal(generated.source.arkOperation, "ListFoundationModels");
    assert.equal(generated.source.localOverrides, "overrides.json");
    assert.equal(metadata.generatedAt, generated.source.generatedAt);
    assert.equal(
      metadata.sha256,
      createHash("sha256").update(manifestText).digest("hex"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates from the local LiteLLM cache without a remote lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "volcengine-manifest-cache-"));
  const cache = join(directory, "litellm-cache.json");
  const foundationModelsInput = join(directory, "foundation-models.json");
  const overrides = join(directory, "overrides.json");
  const output = join(directory, "manifest.json");
  const commit = "fedcba9876543210fedcba9876543210fedcba98";
  await writeFile(cache, JSON.stringify({
    source: {
      repository: "BerriAI/litellm",
      ref: "litellm_internal_staging",
      commit,
      cachedAt: "2026-08-25T00:00:00.000Z",
    },
    models: {
      "volcengine/cached-model": {
        litellm_provider: "volcengine",
        mode: "chat",
        max_input_tokens: 4096,
      },
    },
  }), "utf8");
  await writeFile(foundationModelsInput, JSON.stringify([
    { Name: "cached-model" },
  ]), "utf8");
  await writeFile(overrides, "{}\n", "utf8");

  try {
    await execFileAsync(process.execPath, [
      "scripts/update-model-manifest.ts",
      "--use-cache",
      "--cache",
      cache,
      "--foundation-models-input",
      foundationModelsInput,
      "--overrides",
      overrides,
      "--output",
      output,
    ], {
      cwd: PACKAGE_DIR,
      env: {
        ...process.env,
        PATH: "",
      },
    });
    const generated = JSON.parse(await readFile(output, "utf8"));
    assert.equal(generated.source.commit, commit);
    assert.deepEqual(generated.models["cached-model"], {
      name: "cached-model",
      mode: "chat",
      maxInputTokens: 4096,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshes the local LiteLLM cache after downloading the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "volcengine-manifest-refresh-"));
  const bin = join(directory, "bin");
  const curl = join(bin, "curl");
  const cache = join(directory, "litellm-cache.json");
  const foundationModelsInput = join(directory, "foundation-models.json");
  const overrides = join(directory, "overrides.json");
  const output = join(directory, "manifest.json");
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const source = {
    "volcengine/downloaded-model": {
      litellm_provider: "volcengine",
      mode: "chat",
      max_output_tokens: 2048,
    },
  };
  await mkdir(bin);
  await writeFile(curl, "#!/bin/sh\nprintf '%s' \"$LITELLM_TEST_SOURCE\"\n", "utf8");
  await chmod(curl, 0o755);
  await writeFile(foundationModelsInput, JSON.stringify([
    { Name: "downloaded-model" },
  ]), "utf8");
  await writeFile(overrides, "{}\n", "utf8");

  try {
    await execFileAsync(process.execPath, [
      "scripts/update-model-manifest.ts",
      "--commit",
      commit,
      "--cache",
      cache,
      "--foundation-models-input",
      foundationModelsInput,
      "--overrides",
      overrides,
      "--output",
      output,
    ], {
      cwd: PACKAGE_DIR,
      env: {
        ...process.env,
        LITELLM_TEST_SOURCE: JSON.stringify(source),
        PATH: bin,
      },
    });
    const cached = JSON.parse(await readFile(cache, "utf8"));
    assert.equal(cached.source.repository, "BerriAI/litellm");
    assert.equal(cached.source.ref, "litellm_internal_staging");
    assert.equal(cached.source.commit, commit);
    assert.equal(typeof cached.source.cachedAt, "string");
    assert.deepEqual(cached.models, source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
