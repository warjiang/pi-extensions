import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getCachedMediaModels,
  type VolcengineMediaModel,
} from "./models.ts";
import {
  resolveMediaOutputDir,
  type DownloadedVideoTask,
  type VideoTask,
  VolcengineMediaService,
} from "./media-service.ts";

const PROVIDER_ID = "volcengine";
const TERMINAL_VIDEO_STATES = new Set(["succeeded", "failed", "cancelled"]);

interface MediaToolDetails {
  kind: "image" | "video";
  model?: string;
  taskId?: string;
  status?: string;
  localPaths?: string[];
  metadataPath?: string;
}

async function refreshMediaModels(
  ctx: ExtensionContext,
  signal?: AbortSignal,
  force = false,
): Promise<readonly VolcengineMediaModel[]> {
  if (!force && getCachedMediaModels().length > 0) return getCachedMediaModels();
  const result = await ctx.modelRegistry.refresh({
    allowNetwork: true,
    providers: [PROVIDER_ID],
    force: true,
    signal,
  });
  const error = result.errors.get(PROVIDER_ID);
  if (error) throw error;
  return getCachedMediaModels();
}

async function createService(ctx: ExtensionContext): Promise<{
  service: VolcengineMediaService;
  env: Record<string, string>;
}> {
  const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
  const apiKey = auth?.auth.apiKey;
  if (!apiKey) {
    throw new Error("生图和生视频需要方舟 API Key；请先运行 /login 或设置 VOLCENGINE_API_KEY。");
  }
  const env = { ...process.env, ...auth.env } as Record<string, string>;
  return {
    service: new VolcengineMediaService({
      apiKey,
      baseUrl: auth.auth.baseUrl,
      cwd: ctx.cwd,
      outputDir: resolveMediaOutputDir(ctx.cwd, env.VOLCENGINE_MEDIA_DIR),
    }),
    env,
  };
}

function candidatesText(models: readonly VolcengineMediaModel[]): string {
  return models.map((model) => `${model.inferenceId} (${model.name}, ${model.source})`).join("\n");
}

export function chooseMediaModel(
  models: readonly VolcengineMediaModel[],
  kind: "image" | "video",
  explicit: string | undefined,
  configured: string | undefined,
): VolcengineMediaModel {
  const candidates = models.filter((model) => model.kind === kind);
  const requested = explicit || configured;
  if (requested) {
    const selected = candidates.find((model) => model.inferenceId === requested);
    if (selected) return selected;
    const otherKind = models.find((model) => model.inferenceId === requested);
    if (otherKind) {
      throw new Error(`模型 ${requested} 是 ${otherKind.kind} 模型，不能用于 ${kind} 生成。`);
    }
    throw new Error(
      `媒体目录中找不到 ${kind} 模型 ${requested}。可用模型：\n${candidatesText(candidates) || "（无）"}`,
    );
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new Error(`没有发现可用的 ${kind} 模型；请运行 /media-refresh 检查模型目录。`);
  }
  const envName = kind === "image" ? "VOLCENGINE_IMAGE_MODEL" : "VOLCENGINE_VIDEO_MODEL";
  throw new Error(
    `发现多个 ${kind} 模型，请显式传入 model 或设置 ${envName}：\n${candidatesText(candidates)}`,
  );
}

function videoStatusText(task: VideoTask): string {
  const error = task.error?.message || task.error?.code;
  return `视频任务 ${task.id}：${task.status}${error ? `（${error}）` : ""}`;
}

async function finishVideo(
  service: VolcengineMediaService,
  task: VideoTask,
  signal?: AbortSignal,
): Promise<DownloadedVideoTask> {
  if (task.status === "failed" || task.status === "cancelled") {
    const reason = task.error?.message || task.error?.code || "服务端未提供原因";
    throw new Error(`视频任务 ${task.id} ${task.status}：${reason}`);
  }
  return service.downloadVideoTask(task, signal);
}

function videoResult(task: DownloadedVideoTask): {
  content: Array<{ type: "text"; text: string }>;
  details: MediaToolDetails;
} {
  const lines = [
    videoStatusText(task),
    task.localPath ? `本地文件：${task.localPath}` : undefined,
    task.metadataPath ? `元数据：${task.metadataPath}` : undefined,
    task.outputUrl && !task.localPath ? `临时 URL：${task.outputUrl}` : undefined,
    task.downloadError ? `下载失败：${task.downloadError}` : undefined,
  ].filter(Boolean);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      kind: "video",
      model: task.model,
      taskId: task.id,
      status: task.status,
      localPaths: task.localPath ? [task.localPath] : [],
      metadataPath: task.metadataPath,
    },
  };
}

export function registerMediaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "generate_image",
    label: "Generate Image",
    description: "使用火山方舟 Seedream 图片模型生成或编辑图片，并将结果下载到本地。",
    promptSnippet: "Generate or edit images with Volcengine Ark media models",
    promptGuidelines: [
      "Use generate_image when the user asks to create or edit an image with Volcengine Ark.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, description: "图片生成或编辑提示词" }),
      model: Type.Optional(Type.String({ description: "媒体目录中的模型 ID 或 Endpoint ID" })),
      reference_images: Type.Optional(Type.Array(Type.String(), {
        maxItems: 10,
        description: "本地图片路径、HTTP(S) URL、TOS URL 或 data URL",
      })),
      size: Type.Optional(Type.String({ description: "输出尺寸，例如 1920x1920 或 adaptive" })),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 15, description: "输出图片数量" })),
      seed: Type.Optional(Type.Integer()),
      watermark: Type.Optional(Type.Boolean()),
      output_format: Type.Optional(Type.Union([Type.Literal("jpeg"), Type.Literal("png")])),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "正在加载方舟图片模型目录…" }],
        details: { kind: "image", status: "loading_models" },
      });
      const models = await refreshMediaModels(ctx, signal);
      const { service, env } = await createService(ctx);
      const model = chooseMediaModel(models, "image", params.model, env.VOLCENGINE_IMAGE_MODEL);
      onUpdate?.({
        content: [{ type: "text", text: `正在使用 ${model.inferenceId} 生成图片…` }],
        details: { kind: "image", model: model.inferenceId, status: "generating" },
      });
      const result = await service.generateImages({
        model: model.inferenceId,
        prompt: params.prompt,
        referenceImages: params.reference_images,
        size: params.size,
        count: params.count,
        seed: params.seed,
        watermark: params.watermark,
        outputFormat: params.output_format,
      }, signal);
      const paths = result.files.map((file) => file.path);
      return {
        content: [
          {
            type: "text",
            text: `已生成 ${paths.length} 张图片：\n${paths.join("\n")}\n元数据：${result.metadataPath}`,
          },
          ...result.files.map((file) => ({
            type: "image" as const,
            data: file.data,
            mimeType: file.mimeType,
          })),
        ],
        details: {
          kind: "image" as const,
          model: result.model,
          status: "succeeded",
          localPaths: paths,
          metadataPath: result.metadataPath,
        },
      };
    },
  });

  pi.registerTool({
    name: "generate_video",
    label: "Generate Video",
    description: "使用火山方舟 Seedance 视频模型创建任务、等待生成并下载视频。",
    promptSnippet: "Generate videos with Volcengine Ark media models",
    promptGuidelines: [
      "Use generate_video when the user asks to create a video with Volcengine Ark.",
      "If generate_video returns a pending task ID, use get_video_task instead of creating a duplicate task.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String({ description: "媒体目录中的模型 ID 或 Endpoint ID" })),
      first_frame: Type.Optional(Type.String({ description: "首帧本地路径或 URL" })),
      last_frame: Type.Optional(Type.String({ description: "尾帧本地路径或 URL" })),
      ratio: Type.Optional(Type.String({ description: "例如 16:9、9:16 或 1:1" })),
      resolution: Type.Optional(Type.String({ description: "例如 480p、720p 或 1080p" })),
      duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "视频秒数" })),
      seed: Type.Optional(Type.Integer()),
      watermark: Type.Optional(Type.Boolean()),
      generate_audio: Type.Optional(Type.Boolean()),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const models = await refreshMediaModels(ctx, signal);
      const { service, env } = await createService(ctx);
      const model = chooseMediaModel(models, "video", params.model, env.VOLCENGINE_VIDEO_MODEL);
      onUpdate?.({
        content: [{ type: "text", text: `正在使用 ${model.inferenceId} 创建视频任务…` }],
        details: { kind: "video", model: model.inferenceId, status: "creating" },
      });
      const created = await service.createVideoTask({
        model: model.inferenceId,
        prompt: params.prompt,
        firstFrame: params.first_frame,
        lastFrame: params.last_frame,
        ratio: params.ratio,
        resolution: params.resolution,
        duration: params.duration,
        seed: params.seed,
        watermark: params.watermark,
        generateAudio: params.generate_audio,
      }, signal);
      try {
        const task = await service.waitForVideoTask(created.id, {
          signal,
          timeoutMs: 10 * 60_000,
          onStatus(update) {
            onUpdate?.({
              content: [{ type: "text", text: videoStatusText(update) }],
              details: {
                kind: "video",
                model: model.inferenceId,
                taskId: update.id,
                status: update.status,
              },
            });
          },
        });
        if (!TERMINAL_VIDEO_STATES.has(task.status)) {
          return videoResult({
            ...task,
            model: task.model ?? model.inferenceId,
          });
        }
        return videoResult(await finishVideo(service, task, signal));
      } catch (error) {
        if (signal?.aborted) {
          return videoResult({
            ...created,
            model: model.inferenceId,
            status: "waiting_cancelled",
          });
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "get_video_task",
    label: "Get Video Task",
    description: "查询、恢复等待并下载已有的火山方舟视频生成任务。",
    promptSnippet: "Query or resume a Volcengine Ark video task",
    promptGuidelines: [
      "Use get_video_task with the existing task ID after a video generation timeout or interruption.",
    ],
    parameters: Type.Object({
      task_id: Type.String({ minLength: 1 }),
      wait: Type.Optional(Type.Boolean({ description: "是否继续等待任务完成" })),
      timeout_seconds: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 600,
        description: "继续等待的最长秒数，默认 600",
      })),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { service } = await createService(ctx);
      let task = await service.getVideoTask(params.task_id, signal);
      if (params.wait && !TERMINAL_VIDEO_STATES.has(task.status)) {
        task = await service.waitForVideoTask(params.task_id, {
          signal,
          timeoutMs: (params.timeout_seconds ?? 600) * 1_000,
          onStatus(update) {
            onUpdate?.({
              content: [{ type: "text", text: videoStatusText(update) }],
              details: {
                kind: "video",
                model: update.model,
                taskId: update.id,
                status: update.status,
              },
            });
          },
        });
      }
      return videoResult(
        TERMINAL_VIDEO_STATES.has(task.status)
          ? await finishVideo(service, task, signal)
          : task,
      );
    },
  });

  pi.registerCommand("media-models", {
    description: "查看火山方舟图片和视频模型",
    handler: async (_args, ctx) => {
      try {
        const models = await refreshMediaModels(ctx);
        const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
        const imageDefault = auth?.env?.VOLCENGINE_IMAGE_MODEL || process.env.VOLCENGINE_IMAGE_MODEL;
        const videoDefault = auth?.env?.VOLCENGINE_VIDEO_MODEL || process.env.VOLCENGINE_VIDEO_MODEL;
        const lines = [
          `图片默认：${imageDefault || "未设置"}`,
          ...models.filter((model) => model.kind === "image").map(
            (model) => `  ${model.inferenceId} — ${model.name} [${model.source}]`,
          ),
          `视频默认：${videoDefault || "未设置"}`,
          ...models.filter((model) => model.kind === "video").map(
            (model) => `  ${model.inferenceId} — ${model.name} [${model.source}]`,
          ),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("media-refresh", {
    description: "重新拉取火山方舟媒体模型目录",
    handler: async (_args, ctx) => {
      try {
        const models = await refreshMediaModels(ctx, undefined, true);
        const images = models.filter((model) => model.kind === "image").length;
        const videos = models.filter((model) => model.kind === "video").length;
        ctx.ui.notify(`媒体模型目录已刷新：${images} 个图片模型，${videos} 个视频模型。`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
