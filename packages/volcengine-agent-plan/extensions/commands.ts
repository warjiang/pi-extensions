import { ARKClient } from "@volcengine/ark";
import {
  buildRequestConfigFromMetaPath,
  Command,
} from "@volcengine/sdk-core";
import { CONTROL_HOST } from "./constants.ts";
import type { PlanModelCommandOutput } from "./types.ts";

export class ListArkAgentPlanModelCommand extends Command<
  Record<string, never>,
  PlanModelCommandOutput,
  "ListArkAgentPlanModelCommand"
> {
  static readonly metaPath =
    "/ListArkAgentPlanModel/2024-01-01/ark/post/application_json/";

  constructor(input: Record<string, never>) {
    super(input);
    this.requestConfig = buildRequestConfigFromMetaPath(
      ListArkAgentPlanModelCommand.metaPath,
    );
  }
}

export interface PlanModelClient {
  send(
    command: ListArkAgentPlanModelCommand,
    options: { abortSignal: AbortSignal; timeout: number },
  ): Promise<PlanModelCommandOutput>;
}

export type PlanModelClientFactory = (
  credentials: { accessKeyId: string; secretAccessKey: string },
) => PlanModelClient;

export const createPlanModelClient: PlanModelClientFactory = (
  { accessKeyId, secretAccessKey },
) =>
  new ARKClient({
    accessKeyId,
    secretAccessKey,
    host: CONTROL_HOST,
    region: "cn-beijing",
  });
