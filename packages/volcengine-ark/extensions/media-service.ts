import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const REQUEST_TIMEOUT_MS = 60_000;
const IMAGE_GENERATION_TIMEOUT_MS = 3 * 60_000;
const MAX_LOCAL_INPUT_BYTES = 20 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export interface GeneratedFile {
  path: string;
  mimeType: string;
  data: string;
  sourceUrl?: string;
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  referenceImages?: readonly string[];
  size?: string;
  count?: number;
  seed?: number;
  watermark?: boolean;
  outputFormat?: "jpeg" | "png";
}

export interface ImageGenerationResult {
  model: string;
  files: GeneratedFile[];
  response: unknown;
  metadataPath: string;
}

export interface VideoGenerationRequest {
  model: string;
  prompt: string;
  firstFrame?: string;
  lastFrame?: string;
  ratio?: string;
  resolution?: string;
  duration?: number;
  seed?: number;
  watermark?: boolean;
  generateAudio?: boolean;
}

export interface VideoTask {
  id: string;
  model?: string;
  status: string;
  outputUrl?: string;
  lastFrameUrl?: string;
  error?: { code?: string; message?: string };
  request?: unknown;
  raw: unknown;
}

export interface DownloadedVideoTask extends VideoTask {
  localPath?: string;
  metadataPath?: string;
  downloadError?: string;
}

export interface MediaServiceOptions {
  apiKey: string;
  baseUrl?: string;
  outputDir: string;
  cwd: string;
  fetch?: typeof fetch;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mimeForPath(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return undefined;
  }
}

function extensionForMime(mimeType: string, fallback: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return ".jpeg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "video/webm":
      return ".webm";
    case "video/quicktime":
      return ".mov";
    case "video/mp4":
      return ".mp4";
    default:
      return fallback;
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? abortError();
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? abortError());
    }, { once: true });
  });
}

function apiError(payload: unknown, status: number): Error {
  const root = object(payload);
  const error = object(root?.error);
  const code = text(error?.code) ?? text(root?.code);
  const message = text(error?.message) ?? text(root?.message);
  return new Error(
    `方舟媒体请求失败（HTTP ${status}${code ? `, ${code}` : ""}）${message ? `：${message}` : ""}`,
  );
}

export function resolveMediaOutputDir(cwd: string, configured?: string): string {
  const value = configured?.trim();
  if (!value) return join(cwd, ".pi", "media");
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export class VolcengineMediaService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly outputDir: string;
  private readonly cwd: string;
  private readonly fetchImpl: typeof fetch;
  private readonly videoRequests = new Map<string, unknown>();

  constructor(options: MediaServiceOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.outputDir = options.outputDir;
    this.cwd = options.cwd;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async generateImages(
    request: ImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ImageGenerationResult> {
    const references = await Promise.all(
      (request.referenceImages ?? []).map((value) => this.resolveImageInput(value)),
    );
    const count = request.count ?? 1;
    const body: JsonObject = {
      model: request.model,
      prompt: request.prompt,
      response_format: "url",
      ...(references.length > 0 ? { image: references.length === 1 ? references[0] : references } : {}),
      ...(request.size ? { size: request.size } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.watermark !== undefined ? { watermark: request.watermark } : {}),
      ...(request.outputFormat ? { output_format: request.outputFormat } : {}),
      ...(count > 1
        ? {
            sequential_image_generation: "auto",
            sequential_image_generation_options: { max_images: count },
          }
        : {}),
    };
    const payload = await this.requestJson("/images/generations", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      timeoutMs: IMAGE_GENERATION_TIMEOUT_MS,
    });
    const root = object(payload);
    const data = Array.isArray(root?.data) ? root.data : [];
    if (data.length === 0) throw new Error("方舟图片生成成功响应中没有图片数据。");

    const files: GeneratedFile[] = [];
    for (const [index, rawItem] of data.entries()) {
      const item = object(rawItem);
      const url = text(item?.url);
      const base64 = text(item?.b64_json);
      if (url) {
        files.push(await this.download(
          url,
          `image-${index + 1}`,
          request.outputFormat === "png" ? ".png" : ".jpeg",
          signal,
        ));
      } else if (base64) {
        const mimeType = request.outputFormat === "png" ? "image/png" : "image/jpeg";
        files.push(await this.saveBase64(base64, `image-${index + 1}`, mimeType));
      }
    }
    if (files.length === 0) throw new Error("方舟图片生成响应中既没有 URL，也没有 base64 图片。");
    const metadataPath = await this.writeMetadata("image", {
      generated_at: new Date().toISOString(),
      request: {
        model: request.model,
        prompt: request.prompt,
        reference_images: request.referenceImages,
        size: request.size,
        count,
        seed: request.seed,
        watermark: request.watermark,
        output_format: request.outputFormat,
      },
      response: payload,
      local_paths: files.map((file) => file.path),
    });
    return {
      model: text(root?.model) ?? request.model,
      files,
      response: payload,
      metadataPath,
    };
  }

  async createVideoTask(
    request: VideoGenerationRequest,
    signal?: AbortSignal,
  ): Promise<VideoTask> {
    const content: JsonObject[] = [{ type: "text", text: request.prompt }];
    if (request.firstFrame) {
      content.push({
        type: "image_url",
        image_url: { url: await this.resolveImageInput(request.firstFrame) },
        role: "first_frame",
      });
    }
    if (request.lastFrame) {
      content.push({
        type: "image_url",
        image_url: { url: await this.resolveImageInput(request.lastFrame) },
        role: "last_frame",
      });
    }
    const body = {
      model: request.model,
      content,
      ...(request.ratio ? { ratio: request.ratio } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.duration !== undefined ? { duration: request.duration } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.watermark !== undefined ? { watermark: request.watermark } : {}),
      ...(request.generateAudio !== undefined ? { generate_audio: request.generateAudio } : {}),
    };
    const payload = await this.requestJson("/contents/generations/tasks", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    });
    const id = text(object(payload)?.id);
    if (!id) throw new Error("方舟创建视频任务成功响应中没有任务 ID。");
    this.videoRequests.set(id, body);
    return {
      id,
      model: request.model,
      status: text(object(payload)?.status) ?? "queued",
      request: body,
      raw: payload,
    };
  }

  async getVideoTask(taskId: string, signal?: AbortSignal): Promise<VideoTask> {
    const payload = await this.requestJson(
      `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      { method: "GET", signal },
      true,
    );
    const root = object(payload);
    const content = object(root?.content);
    const error = object(root?.error) ?? object(root?.failure_reason);
    return {
      id: text(root?.id) ?? taskId,
      model: text(root?.model),
      status: text(root?.status) ?? "unknown",
      outputUrl: text(content?.video_url) ?? text(content?.file_url) ?? text(root?.output_url),
      lastFrameUrl: text(content?.last_frame_url),
      error: error
        ? { code: text(error.code), message: text(error.message) }
        : undefined,
      request: this.videoRequests.get(taskId),
      raw: payload,
    };
  }

  async waitForVideoTask(
    taskId: string,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onStatus?: (task: VideoTask) => void;
    } = {},
  ): Promise<VideoTask> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    let delayMs = 2_000;
    while (true) {
      const task = await this.getVideoTask(taskId, options.signal);
      options.onStatus?.(task);
      if (["succeeded", "failed", "cancelled"].includes(task.status)) return task;
      if (Date.now() - startedAt >= timeoutMs) return task;
      await sleep(delayMs, options.signal);
      delayMs = Math.min(10_000, delayMs + 2_000);
    }
  }

  async downloadVideoTask(task: VideoTask, signal?: AbortSignal): Promise<DownloadedVideoTask> {
    if (task.status !== "succeeded") return task;
    if (!task.outputUrl) {
      const downloadError = `视频任务 ${task.id} 已完成，但响应中没有视频 URL。`;
      const metadataPath = await this.writeVideoMetadata(task, { download_error: downloadError });
      return {
        ...task,
        metadataPath,
        downloadError,
      };
    }
    let file: GeneratedFile;
    try {
      file = await this.download(task.outputUrl, `video-${task.id}`, ".mp4", signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const downloadError = error instanceof Error ? error.message : String(error);
      const metadataPath = await this.writeVideoMetadata(task, { download_error: downloadError });
      return {
        ...task,
        metadataPath,
        downloadError,
      };
    }
    try {
      const metadataPath = await this.writeVideoMetadata(task, { local_path: file.path });
      return { ...task, localPath: file.path, metadataPath };
    } catch (error) {
      return {
        ...task,
        localPath: file.path,
        downloadError: `视频已下载，但元数据保存失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  private async resolveImageInput(value: string): Promise<string> {
    if (/^(https?:|tos:|data:)/i.test(value)) return value;
    const path = isAbsolute(value) ? value : resolve(this.cwd, value);
    const mimeType = mimeForPath(path);
    if (!mimeType) throw new Error(`不支持的本地图片格式：${value}`);
    let fileStat;
    try {
      fileStat = await stat(path);
    } catch {
      throw new Error(`找不到本地图片：${value}`);
    }
    if (!fileStat.isFile()) throw new Error(`本地图片不是普通文件：${value}`);
    if (fileStat.size > MAX_LOCAL_INPUT_BYTES) {
      throw new Error(`本地图片超过 20 MiB 限制：${value}`);
    }
    const data = await readFile(path);
    return `data:${mimeType};base64,${data.toString("base64")}`;
  }

  private async requestJson(
    path: string,
    init: { method: string; body?: string; signal?: AbortSignal; timeoutMs?: number },
    retrySafe = false,
  ): Promise<unknown> {
    const attempts = retrySafe ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: init.method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: init.body,
          signal: combinedSignal(init.signal, init.timeoutMs),
        });
      } catch (error) {
        if (attempt < attempts && !init.signal?.aborted) {
          await sleep(500, init.signal);
          continue;
        }
        throw error;
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`方舟媒体接口返回了畸形 JSON（HTTP ${response.status}）。`);
      }
      if (response.ok) return payload;
      if (attempt < attempts && (response.status === 429 || response.status >= 500)) {
        await sleep(500, init.signal);
        continue;
      }
      throw apiError(payload, response.status);
    }
    throw new Error("方舟媒体请求失败。");
  }

  private async download(
    url: string,
    prefix: string,
    fallbackExtension: string,
    signal?: AbortSignal,
  ): Promise<GeneratedFile> {
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          signal: combinedSignal(signal),
        });
      } catch (error) {
        if (attempt === 2 || signal?.aborted) throw error;
        await sleep(500, signal);
        continue;
      }
      if (response.ok) break;
      if (attempt === 2 || (response.status < 500 && response.status !== 429)) {
        throw new Error(`下载生成产物失败（HTTP ${response.status}）。`);
      }
      await sleep(500, signal);
    }
    if (!response?.ok) throw new Error("下载生成产物失败。");
    const fallbackMime = fallbackExtension === ".mp4"
      ? "video/mp4"
      : fallbackExtension === ".png"
        ? "image/png"
        : "image/jpeg";
    const responseMime = response.headers.get("content-type")?.split(";")[0]?.trim();
    const expectedPrefix = fallbackExtension === ".mp4" ? "video/" : "image/";
    const mimeType = responseMime?.startsWith(expectedPrefix) ? responseMime : fallbackMime;
    const data = Buffer.from(await response.arrayBuffer());
    const path = await this.outputPath(prefix, extensionForMime(mimeType, fallbackExtension));
    await writeFile(path, data, { flag: "wx" });
    return { path, mimeType, data: data.toString("base64"), sourceUrl: url };
  }

  private async saveBase64(
    base64: string,
    prefix: string,
    mimeType: string,
  ): Promise<GeneratedFile> {
    const path = await this.outputPath(prefix, extensionForMime(mimeType, ".jpeg"));
    await writeFile(path, Buffer.from(base64, "base64"), { flag: "wx" });
    return { path, mimeType, data: base64 };
  }

  private async writeMetadata(prefix: string, metadata: unknown): Promise<string> {
    const path = await this.outputPath(prefix, ".json");
    await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
    return path;
  }

  private writeVideoMetadata(
    task: VideoTask,
    result: { local_path?: string; download_error?: string },
  ): Promise<string> {
    return this.writeMetadata(`video-${task.id}`, {
      generated_at: new Date().toISOString(),
      task_id: task.id,
      model: task.model,
      request: task.request,
      task: task.raw,
      output_url: task.outputUrl,
      ...result,
    });
  }

  private async outputPath(prefix: string, extension: string): Promise<string> {
    await mkdir(this.outputDir, { recursive: true });
    const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "media";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(this.outputDir, `${safePrefix}-${timestamp}-${randomUUID().slice(0, 8)}${extension}`);
  }
}
