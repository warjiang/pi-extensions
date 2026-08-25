import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  PROVIDER_ID,
  TERMINAL_VIDEO_STATES,
} from "./constants.ts";
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
import {
  readProviderConfig,
  updateProviderConfig,
  type VolcengineProviderConfig,
} from "./provider-config.ts";

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
  config: VolcengineProviderConfig;
}> {
  const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
  const apiKey = auth?.auth.apiKey;
  if (!apiKey) {
    throw new Error("An Ark API key is required for image and video generation; run /login.");
  }
  const config = await readProviderConfig();
  return {
    service: new VolcengineMediaService({
      apiKey,
      baseUrl: auth.auth.baseUrl,
      cwd: ctx.cwd,
      outputDir: resolveMediaOutputDir(ctx.cwd, config.mediaDir),
    }),
    config,
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
      throw new Error(
        `Model ${requested} is a ${otherKind.kind} model and cannot be used for ${kind} generation.`,
      );
    }
    throw new Error(
      `${kind} model ${requested} was not found. Available models:\n${
        candidatesText(candidates) || "(none)"
      }`,
    );
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new Error(`No ${kind} models are available; run /media-refresh to refresh the model list.`);
  }
  const command = kind === "image" ? "/media-image-model" : "/media-video-model";
  throw new Error(
    `Multiple ${kind} models are available. Specify model or run ${command}:\n${
      candidatesText(candidates)
    }`,
  );
}

async function configureMediaModel(
  ctx: ExtensionContext,
  kind: "image" | "video",
  args: string,
): Promise<void> {
  const key = kind === "image" ? "imageModel" : "videoModel";
  if (args.trim() === "clear") {
    await updateProviderConfig({ [key]: undefined });
    ctx.ui.notify(`The default ${kind} model has been cleared.`, "info");
    return;
  }
  const models = (await refreshMediaModels(ctx)).filter((model) => model.kind === kind);
  if (models.length === 0) {
    throw new Error(`No ${kind} models are available; run /media-refresh to refresh the model list.`);
  }
  let selected = args.trim();
  if (!selected) {
    const options = models.map((model) => `${model.name} (${model.inferenceId})`);
    const choice = await ctx.ui.select(`Select the default ${kind} model`, options);
    if (!choice) return;
    selected = models[options.indexOf(choice)]?.inferenceId ?? "";
  }
  const model = models.find((candidate) => candidate.inferenceId === selected);
  if (!model) {
    throw new Error(`${kind} model ${selected || "(not selected)"} was not found.`);
  }
  await updateProviderConfig({ [key]: model.inferenceId });
  ctx.ui.notify(`The default ${kind} model is now ${model.inferenceId}.`, "info");
}

function videoStatusText(task: VideoTask): string {
  const error = task.error?.message || task.error?.code;
  return `Video task ${task.id}: ${task.status}${error ? ` (${error})` : ""}`;
}

async function finishVideo(
  service: VolcengineMediaService,
  task: VideoTask,
  signal?: AbortSignal,
): Promise<DownloadedVideoTask> {
  if (task.status === "failed" || task.status === "cancelled") {
    const reason = task.error?.message || task.error?.code || "No reason was provided by the server";
    throw new Error(`Video task ${task.id} ${task.status}: ${reason}`);
  }
  return service.downloadVideoTask(task, signal);
}

function videoResult(task: DownloadedVideoTask): {
  content: Array<{ type: "text"; text: string }>;
  details: MediaToolDetails;
} {
  const lines = [
    videoStatusText(task),
    task.localPath ? `Local file: ${task.localPath}` : undefined,
    task.metadataPath ? `Metadata: ${task.metadataPath}` : undefined,
    task.outputUrl && !task.localPath ? `Temporary URL: ${task.outputUrl}` : undefined,
    task.downloadError ? `Download failed: ${task.downloadError}` : undefined,
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
    description: "Generate or edit images with Volcengine Ark Seedream models and save them locally.",
    promptSnippet: "Generate or edit images with Volcengine Ark media models",
    promptGuidelines: [
      "Use generate_image when the user asks to create or edit an image with Volcengine Ark.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, description: "Image generation or editing prompt" }),
      model: Type.Optional(Type.String({ description: "Model ID or endpoint ID" })),
      reference_images: Type.Optional(Type.Array(Type.String(), {
        maxItems: 10,
        description: "Local image path, HTTP(S) URL, TOS URL, or data URL",
      })),
      size: Type.Optional(Type.String({ description: "Output size, such as 1920x1920 or adaptive" })),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 15, description: "Number of images" })),
      seed: Type.Optional(Type.Integer()),
      watermark: Type.Optional(Type.Boolean()),
      output_format: Type.Optional(Type.Union([Type.Literal("jpeg"), Type.Literal("png")])),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "Loading Ark image models..." }],
        details: { kind: "image", status: "loading_models" },
      });
      const models = await refreshMediaModels(ctx, signal);
      const { service, config } = await createService(ctx);
      const model = chooseMediaModel(models, "image", params.model, config.imageModel);
      onUpdate?.({
        content: [{ type: "text", text: `Generating images with ${model.inferenceId}...` }],
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
            text: `Generated ${paths.length} image(s):\n${paths.join("\n")}\nMetadata: ${
              result.metadataPath
            }`,
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
    description: "Create, wait for, and download videos with Volcengine Ark Seedance models.",
    promptSnippet: "Generate videos with Volcengine Ark media models",
    promptGuidelines: [
      "Use generate_video when the user asks to create a video with Volcengine Ark.",
      "If generate_video returns a pending task ID, use get_video_task instead of creating a duplicate task.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String({ description: "Model ID or endpoint ID" })),
      first_frame: Type.Optional(Type.String({ description: "Local path or URL for the first frame" })),
      last_frame: Type.Optional(Type.String({ description: "Local path or URL for the last frame" })),
      ratio: Type.Optional(Type.String({ description: "For example, 16:9, 9:16, or 1:1" })),
      resolution: Type.Optional(Type.String({ description: "For example, 480p, 720p, or 1080p" })),
      duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "Video duration in seconds" })),
      seed: Type.Optional(Type.Integer()),
      watermark: Type.Optional(Type.Boolean()),
      generate_audio: Type.Optional(Type.Boolean()),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const models = await refreshMediaModels(ctx, signal);
      const { service, config } = await createService(ctx);
      const model = chooseMediaModel(models, "video", params.model, config.videoModel);
      onUpdate?.({
        content: [{ type: "text", text: `Creating a video task with ${model.inferenceId}...` }],
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
    description: "Query, resume, and download an existing Volcengine Ark video task.",
    promptSnippet: "Query or resume a Volcengine Ark video task",
    promptGuidelines: [
      "Use get_video_task with the existing task ID after a video generation timeout or interruption.",
    ],
    parameters: Type.Object({
      task_id: Type.String({ minLength: 1 }),
      wait: Type.Optional(Type.Boolean({ description: "Wait for the task to finish" })),
      timeout_seconds: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 600,
        description: "Maximum number of seconds to wait; defaults to 600",
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
    description: "Show Volcengine Ark image and video models",
    handler: async (_args, ctx) => {
      try {
        const models = await refreshMediaModels(ctx);
        const config = await readProviderConfig();
        const lines = [
          `Default image model: ${config.imageModel || "not set"}`,
          ...models.filter((model) => model.kind === "image").map(
            (model) => `  ${model.inferenceId} — ${model.name} [${model.source}]`,
          ),
          `Default video model: ${config.videoModel || "not set"}`,
          ...models.filter((model) => model.kind === "video").map(
            (model) => `  ${model.inferenceId} — ${model.name} [${model.source}]`,
          ),
          `Output directory: ${config.mediaDir || ".pi/media in the current project"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("media-image-model", {
    description: "Set the default Volcengine Ark image model; pass clear to reset it",
    handler: async (args, ctx) => {
      try {
        await configureMediaModel(ctx, "image", args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("media-video-model", {
    description: "Set the default Volcengine Ark video model; pass clear to reset it",
    handler: async (args, ctx) => {
      try {
        await configureMediaModel(ctx, "video", args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("media-dir", {
    description: "Set the media output directory; pass clear to restore the default",
    handler: async (args, ctx) => {
      try {
        let input = args.trim();
        if (!input) {
          const entered = await ctx.ui.input(
            "Set the media output directory",
            "Enter a path relative to the current project or an absolute path; enter clear to reset",
          );
          if (entered === undefined) return;
          input = entered.trim();
        }
        if (!input) return;
        await updateProviderConfig({
          mediaDir: input === "clear" ? undefined : input,
        });
        ctx.ui.notify(
          input === "clear"
            ? "The media output directory has been reset to .pi/media in the current project."
            : `The media output directory is now ${input}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("media-refresh", {
    description: "Refresh Volcengine Ark media models",
    handler: async (_args, ctx) => {
      try {
        const models = await refreshMediaModels(ctx, undefined, true);
        const images = models.filter((model) => model.kind === "image").length;
        const videos = models.filter((model) => model.kind === "video").length;
        ctx.ui.notify(
          `Media models refreshed: ${images} image model(s), ${videos} video model(s).`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
