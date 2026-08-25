import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  ]), "utf8");

  try {
    await execFileAsync(process.execPath, [
      "scripts/update-model-manifest.ts",
      "--input",
      input,
      "--foundation-models-input",
      foundationModelsInput,
      "--commit",
      "0123456789abcdef0123456789abcdef01234567",
      "--output",
      output,
    ], { cwd: PACKAGE_DIR });
    const manifestText = await readFile(output, "utf8");
    const generated = JSON.parse(manifestText);
    const metadata = JSON.parse(await readFile(
      join(directory, "nested", "manifest.metadata.json"),
      "utf8",
    ));
    assert.deepEqual(
      Object.keys(generated.models),
      ["a-model", "image-model-1-0", "z-model"],
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
    assert.equal(generated.models["other-model"], undefined);
    assert.equal(
      generated.source.commit,
      "0123456789abcdef0123456789abcdef01234567",
    );
    assert.equal(generated.source.arkOperation, "ListFoundationModels");
    assert.equal(metadata.generatedAt, generated.source.generatedAt);
    assert.equal(
      metadata.sha256,
      createHash("sha256").update(manifestText).digest("hex"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
