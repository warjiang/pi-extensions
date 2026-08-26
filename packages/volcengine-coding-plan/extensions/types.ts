import type { CommandOutput } from "@volcengine/sdk-core";

export interface PlanModelEntry {
  ModelID?: string;
}

export interface PlanModelResponse {
  Datas?: PlanModelEntry[];
}

export type PlanModelCommandOutput =
  Omit<CommandOutput<PlanModelResponse>, "ResponseMetadata">
  & Partial<Pick<CommandOutput<PlanModelResponse>, "ResponseMetadata">>;

export interface PlanManifestModel {
  id: string;
  displayName?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTokens?: number;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsFunctionCalling?: boolean;
  supportsMaxThinking?: boolean;
}

export interface PlanModelManifest {
  source: {
    operation: "ListArkCodingPlanModel";
    generatedAt: string;
    liteLLM?: {
      repository: string;
      ref: string;
      commit: string;
    };
    arkManifest?: string;
    localOverrides?: string;
  };
  models: Record<string, PlanManifestModel>;
}
