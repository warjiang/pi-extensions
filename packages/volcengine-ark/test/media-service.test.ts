import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveMediaOutputDir,
  VolcengineMediaService,
} from "../extensions/media-service.ts";
import type { ArkMediaClient } from "../extensions/types.ts";

test("resolves the default and configured media directories", () => {
  assert.equal(resolveMediaOutputDir("/work"), "/work/.pi/media");
  assert.equal(resolveMediaOutputDir("/work", "artifacts"), "/work/artifacts");
  assert.equal(resolveMediaOutputDir("/work", "/tmp/media"), "/tmp/media");
});

test("generates, downloads and returns image data without persisting input base64", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "volcengine-media-image-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const inputPath = join(cwd, "reference.png");
  await writeFile(inputPath, Buffer.from("reference"));
  let requestBody: Record<string, unknown> | undefined;
  const client: ArkMediaClient = {
    async generateImages(request) {
      requestBody = { ...request };
      return {
        model: "seedream",
        data: [{ url: "https://download.example/image" }],
      };
    },
    async createContentGenerationTask() {
      throw new Error("unexpected video request");
    },
    async getContentGenerationTask() {
      throw new Error("unexpected video request");
    },
  };
  const service = new VolcengineMediaService({
    apiKey: "api-key",
    cwd,
    outputDir: join(cwd, "output"),
    client,
    fetch: async (input) => {
      const url = String(input);
      assert.equal(url, "https://download.example/image");
      return new Response(Buffer.from("generated-image"), {
        headers: { "content-type": "image/png" },
      });
    },
  });
  const result = await service.generateImages({
    model: "seedream",
    prompt: "make it blue",
    referenceImages: [inputPath],
    count: 3,
    outputFormat: "png",
  });

  assert.equal(requestBody?.model, "seedream");
  assert.match(String(requestBody?.image), /^data:image\/png;base64,/);
  assert.deepEqual(requestBody?.sequential_image_generation_options, { max_images: 3 });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.mimeType, "image/png");
  assert.equal(Buffer.from(result.files[0]!.data, "base64").toString(), "generated-image");
  assert.equal((await readFile(result.files[0]!.path)).toString(), "generated-image");
  const metadata = await readFile(result.metadataPath, "utf8");
  assert.equal(metadata.includes("data:image/png;base64"), false);
  assert.match(metadata, /reference\.png/);
  assert.match(metadata, /generated_at/);
});

test("rejects missing local image inputs with a clear error", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "volcengine-media-missing-input-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const service = new VolcengineMediaService({
    apiKey: "api-key",
    cwd,
    outputDir: join(cwd, "output"),
  });

  await assert.rejects(
    service.generateImages({
      model: "seedream",
      prompt: "make it blue",
      referenceImages: ["missing.png"],
    }),
    /Local image not found: missing\.png/,
  );
});

test("creates a video task with frame roles and downloads a completed task", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "volcengine-media-video-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let createBody: Record<string, unknown> | undefined;
  let statusCalls = 0;
  const client: ArkMediaClient = {
    async generateImages() {
      throw new Error("unexpected image request");
    },
    async createContentGenerationTask(request) {
      createBody = { ...request };
      return { id: "task-1", status: "queued" };
    },
    async getContentGenerationTask(taskId) {
      statusCalls += 1;
      return {
        id: taskId,
        model: "seedance",
        status: "succeeded",
        content: { video_url: "https://download.example/video" },
      };
    },
  };
  const service = new VolcengineMediaService({
    apiKey: "api-key",
    cwd,
    outputDir: join(cwd, "output"),
    client,
    fetch: async (input) => {
      const url = String(input);
      assert.equal(url, "https://download.example/video");
      return new Response(Buffer.from("generated-video"), {
        headers: { "content-type": "video/mp4" },
      });
    },
  });
  const created = await service.createVideoTask({
    model: "seedance",
    prompt: "camera pulls back",
    firstFrame: "https://example.com/first.png",
    lastFrame: "https://example.com/last.png",
    ratio: "16:9",
    resolution: "720p",
    duration: 5,
    generateAudio: true,
  });
  const content = createBody?.content as Array<Record<string, unknown>>;
  assert.equal(content[1]?.role, "first_frame");
  assert.equal(content[2]?.role, "last_frame");
  assert.equal(createBody?.generate_audio, true);
  assert.equal(createBody?.duration, 5);

  const completed = await service.waitForVideoTask(created.id);
  const downloaded = await service.downloadVideoTask(completed);
  assert.equal(statusCalls, 1);
  assert.equal(downloaded.status, "succeeded");
  assert.equal((await readFile(downloaded.localPath!)).toString(), "generated-video");
  const metadata = JSON.parse(await readFile(downloaded.metadataPath!, "utf8"));
  assert.equal(metadata.request.model, "seedance");
  assert.equal(metadata.local_path, downloaded.localPath);
});

test("returns pending tasks on timeout and preserves completed task URLs on download failure", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "volcengine-media-recovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const client: ArkMediaClient = {
    async generateImages() {
      throw new Error("unexpected image request");
    },
    async createContentGenerationTask() {
      throw new Error("unexpected create request");
    },
    async getContentGenerationTask(taskId) {
      if (taskId === "task-running") {
        return { id: taskId, status: "running" };
      }
      return {
        id: taskId,
        status: "succeeded",
        content: { video_url: "https://download.example/missing" },
      };
    },
  };
  const service = new VolcengineMediaService({
    apiKey: "api-key",
    cwd,
    outputDir: join(cwd, "output"),
    client,
    fetch: async (input) => {
      const url = String(input);
      assert.equal(url, "https://download.example/missing");
      return new Response("missing", { status: 404 });
    },
  });

  const pending = await service.waitForVideoTask("task-running", { timeoutMs: 0 });
  assert.equal(pending.status, "running");

  const completed = await service.getVideoTask("task-done");
  const recovered = await service.downloadVideoTask(completed);
  assert.equal(recovered.outputUrl, "https://download.example/missing");
  assert.match(recovered.downloadError!, /HTTP 404/);
  const metadata = JSON.parse(await readFile(recovered.metadataPath!, "utf8"));
  assert.equal(metadata.task_id, "task-done");
  assert.equal(metadata.output_url, "https://download.example/missing");
  assert.match(metadata.download_error, /HTTP 404/);
  assert.equal(typeof metadata.generated_at, "string");
});

test("retries a transient transport failure when reading a video task", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "volcengine-media-retry-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let attempts = 0;
  const client: ArkMediaClient = {
    async generateImages() {
      throw new Error("unexpected image request");
    },
    async createContentGenerationTask() {
      throw new Error("unexpected create request");
    },
    async getContentGenerationTask(taskId) {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("socket reset");
        error.name = "AxiosError";
        throw error;
      }
      return { id: taskId, status: "running" };
    },
  };
  const service = new VolcengineMediaService({
    apiKey: "api-key",
    cwd,
    outputDir: join(cwd, "output"),
    client,
  });

  const task = await service.getVideoTask("task-retry");
  assert.equal(task.status, "running");
  assert.equal(attempts, 2);
});
