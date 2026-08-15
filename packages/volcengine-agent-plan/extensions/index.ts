import {
  createProvider,
  type ApiKeyCredential,
  type AuthInteraction,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BASELINE_MODELS, fetchPlanModels } from "./models.ts";

export const PROVIDER_ID = "volcengine-agent-plan";
export const BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

export async function login(interaction: AuthInteraction): Promise<ApiKeyCredential> {
  const key = await interaction.prompt({
    type: "secret",
    message: "Volcengine Agent Plan API Key",
    placeholder: "ark-...",
  });
  return { type: "api_key", key: key || undefined };
}

export function createAgentPlanProvider() {
  return createProvider<"openai-completions">({
    id: PROVIDER_ID,
    name: "Volcengine Agent Plan（个人版）",
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "Volcengine Agent Plan API Key",
        login,
        async resolve({ ctx, credential }) {
          const key = credential?.key
            || (await ctx.env("VOLCENGINE_AGENT_PLAN_API_KEY"))
            || (await ctx.env("ARK_API_KEY"));
          return key
            ? { auth: { apiKey: key }, source: credential ? "stored API key" : "Agent Plan environment variable" }
            : undefined;
        },
      },
    },
    models: BASELINE_MODELS,
    fetchModels: (context) => fetchPlanModels(context),
    api: openAICompletionsApi(),
  });
}

export default function volcengineAgentPlan(pi: ExtensionAPI): void {
  pi.registerProvider(createAgentPlanProvider());
}
