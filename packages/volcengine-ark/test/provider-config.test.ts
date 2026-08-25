import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readProviderConfig,
  updateProviderConfig,
} from "../extensions/provider-config.ts";

test("persists and updates provider media config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "volcengine-config-"));
  const path = join(dir, "providers", "volcengine.json");
  try {
    assert.deepEqual(await readProviderConfig(path), {});
    await updateProviderConfig({
      imageModel: "image-a",
      videoModel: "video-a",
      mediaDir: "./media",
    }, path);
    await updateProviderConfig({ imageModel: "image-b", videoModel: undefined }, path);
    assert.deepEqual(await readProviderConfig(path), {
      imageModel: "image-b",
      mediaDir: "./media",
    });
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
