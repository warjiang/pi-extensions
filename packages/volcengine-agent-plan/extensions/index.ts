import {
  createProvider,
  type ApiKeyCredential,
  type AuthInteraction,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchPlanModels } from "./models.ts";

export const PROVIDER_ID = "volcengine-agent-plan";
export const BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

export async function login(interaction: AuthInteraction): Promise<ApiKeyCredential> {
  const key = await interaction.prompt({
    type: "secret",
    message: "Enter your Volcengine Agent Plan API Key:",
    placeholder: "Volcengine Agent Plan API Key",
  });
  const accessKeyId = await interaction.prompt({
    type: "secret",
    message: "Enter your Volcengine Agent Plan Access Key ID:",
    placeholder: "Volcengine Agent Plan Access Key ID",
  });
  const secretAccessKey = await interaction.prompt({
    type: "secret",
    message: "Enter your Volcengine Agent Plan Secret Access Key:",
    placeholder: "Volcengine Agent Plan Secret Access Key",
  });
  return {
    type: "api_key",
    key: key || undefined,
    env: {
      VOLCENGINE_ACCESS_KEY_ID: accessKeyId,
      VOLCENGINE_SECRET_ACCESS_KEY: secretAccessKey,
    },
  };
}

async function resolveField(
  ctx: { env(name: string): Promise<string | undefined> },
  credential: ApiKeyCredential | undefined,
  name: string,
): Promise<string | undefined> {
  return credential?.env?.[name] || (await ctx.env(name));
}

export function createAgentPlanProvider() {
  return createProvider<"openai-completions">({
    id: PROVIDER_ID,
    name: "Volcengine Agent Plan",
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "Volcengine Agent Plan API Key + AK/SK",
        login,
        async resolve({ ctx, credential }) {
          const key = credential?.key
            || (await ctx.env("VOLCENGINE_AGENT_PLAN_API_KEY"))
            || (await ctx.env("ARK_API_KEY"));
          const accessKeyId = await resolveField(ctx, credential, "VOLCENGINE_ACCESS_KEY_ID");
          const secretAccessKey = await resolveField(ctx, credential, "VOLCENGINE_SECRET_ACCESS_KEY");
          if (!key && !accessKeyId && !secretAccessKey) return undefined;
          return {
            auth: key ? { apiKey: key } : {},
            env: {
              ...(accessKeyId ? { VOLCENGINE_ACCESS_KEY_ID: accessKeyId } : {}),
              ...(secretAccessKey ? { VOLCENGINE_SECRET_ACCESS_KEY: secretAccessKey } : {}),
            },
            source: credential ? "stored Agent Plan credentials" : "Agent Plan environment variables",
          };
        },
      },
    },
    models: [] as Model<"openai-completions">[],
    fetchModels: (context) => fetchPlanModels(context),
    api: openAICompletionsApi(),
  });
}

export default function volcengineAgentPlan(pi: ExtensionAPI): void {
  pi.registerProvider(createAgentPlanProvider());
}
