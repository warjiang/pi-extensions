import assert from "node:assert/strict";
import test from "node:test";
import type { VolcengineMediaModel } from "../extensions/models.ts";
import { chooseMediaModel } from "../extensions/media-tools.ts";

const models: readonly VolcengineMediaModel[] = [
  {
    inferenceId: "image-a",
    name: "Seedream A",
    kind: "image",
    source: "built-in",
  },
  {
    inferenceId: "image-b",
    name: "Seedream B",
    kind: "image",
    source: "custom",
  },
  {
    inferenceId: "video-a",
    name: "Seedance A",
    kind: "video",
    source: "built-in",
  },
];

test("explicit media model takes precedence over the configured default", () => {
  assert.equal(
    chooseMediaModel(models, "image", "image-b", "image-a").inferenceId,
    "image-b",
  );
});

test("configured media model is used when no explicit model is provided", () => {
  assert.equal(
    chooseMediaModel(models, "image", undefined, "image-a").inferenceId,
    "image-a",
  );
});

test("a single media model candidate is selected automatically", () => {
  assert.equal(
    chooseMediaModel(models, "video", undefined, undefined).inferenceId,
    "video-a",
  );
});

test("multiple media model candidates require an explicit selection", () => {
  assert.throws(
    () => chooseMediaModel(models, "image", undefined, undefined),
    (error: unknown) => {
      assert.match(String(error), /发现多个 image 模型/);
      assert.match(String(error), /image-a/);
      assert.match(String(error), /image-b/);
      assert.match(String(error), /VOLCENGINE_IMAGE_MODEL/);
      return true;
    },
  );
});

test("a model of the wrong modality is rejected", () => {
  assert.throws(
    () => chooseMediaModel(models, "image", "video-a", undefined),
    /模型 video-a 是 video 模型，不能用于 image 生成/,
  );
});
