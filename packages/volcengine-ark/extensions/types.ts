import type { Model } from "@earendil-works/pi-ai";
import type {
  ListEndpointsCommand,
  ListEndpointsCommandOutput,
  ListFoundationModelsCommandOutput,
} from "@volcengine/ark";
import type {
  ArkRuntimeClient,
  CreateContentGenerationContentItem as ArkCreateContentGenerationContentItem,
  CreateContentGenerationTaskRequest,
  GenerateImagesRequest,
  GetContentGenerationTaskResponse,
  Image,
  ImagesResponse,
} from "@volcengine/ark-runtime";
import type { CommandOutput } from "@volcengine/sdk-core";

export type CreateContentGenerationContentItem =
  ArkCreateContentGenerationContentItem;
export type {
  CreateContentGenerationTaskRequest,
  GenerateImagesRequest,
};

export interface EndpointModelInfo {
  Id?: string;
  Name?: string;
  EndpointModelType?: string;
  ModelReference?: {
    FoundationModel?: {
      Name?: string;
      ModelVersion?: string;
    };
  };
}

export interface ManifestPriceTier {
  inputTokensAbove: number;
  inputCostPerToken: number;
  outputCostPerToken: number;
}

export interface ManifestModel {
  name?: string;
  displayName?: string;
  primaryVersion?: string;
  taskTypes?: string[];
  domains?: string[];
  mode?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTokens?: number;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsFunctionCalling?: boolean;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  tieredPricing?: ManifestPriceTier[];
}

export interface ModelManifest {
  source: {
    repository: string;
    ref: string;
    commit: string;
    generatedAt: string;
    arkOperation?: "ListFoundationModels";
    localOverrides?: string;
  };
  models: Record<string, ManifestModel>;
}

export interface ResolvedModelMetadata {
  kind: "chat" | "image" | "video" | "other";
  manifestId?: string;
  manifest?: ManifestModel;
  taskTypes: readonly string[];
  domains: readonly string[];
  diagnostics: readonly string[];
}

export type InnerDescribeModelEndpointsRequest =
  ConstructorParameters<typeof ListEndpointsCommand>[0];
export type InnerDescribeModelEndpointsResponse =
  ListEndpointsCommandOutput extends CommandOutput<infer Response> ? Response : never;
export type Endpoint = NonNullable<InnerDescribeModelEndpointsResponse["Items"]>[number];
export type InnerDescribeModelEndpointsCommandOutput =
  CommandOutput<InnerDescribeModelEndpointsResponse>;
export type ListFoundationModelsResponse =
  ListFoundationModelsCommandOutput extends CommandOutput<infer Response> ? Response : never;
export type FoundationModel =
  NonNullable<ListFoundationModelsResponse["Items"]>[number];

export type FoundationModelManifestSource = FoundationModel;

export type VolcengineEndpointModel = Model<"openai-completions"> & {
  endpointId: string;
};

export interface VolcengineMediaModel {
  inferenceId: string;
  name: string;
  kind: "image" | "video";
  source: "built-in" | "custom";
  taskTypes?: readonly string[];
  domains?: readonly string[];
  manifestId?: string;
}

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
  client?: ArkMediaClient;
}

export interface ArkMediaClient {
  generateImages(
    request: GenerateImagesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<Pick<ImagesResponse, "model"> & {
    data: Array<Partial<Pick<Image, "url" | "b64_json">>>;
  }>;
  createContentGenerationTask(
    request: CreateContentGenerationTaskRequest,
    options?: { signal?: AbortSignal },
  ): ReturnType<ArkRuntimeClient["createContentGenerationTask"]>;
  getContentGenerationTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<
    Pick<GetContentGenerationTaskResponse, "id" | "status">
    & Partial<Pick<GetContentGenerationTaskResponse, "model" | "error">>
    & { content?: Partial<GetContentGenerationTaskResponse["content"]> }
  >;
}

export interface VolcengineProviderConfig {
  imageModel?: string;
  videoModel?: string;
  mediaDir?: string;
}

export interface MediaToolDetails {
  kind: "image" | "video";
  model?: string;
  taskId?: string;
  status?: string;
  localPaths?: string[];
  metadataPath?: string;
}

export interface ModelManifestUpdateOptions {
  input?: string;
  foundationModelsInput?: string;
  commit?: string;
  output?: string;
  cache?: string;
  overrides?: string;
  useCache?: boolean;
}

export interface LiteLLMManifestCache {
  source: {
    repository: string;
    ref: string;
    commit: string;
    cachedAt: string;
  };
  models: Record<string, unknown>;
}
