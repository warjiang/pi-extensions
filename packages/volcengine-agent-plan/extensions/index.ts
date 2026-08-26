import {
  createProvider,
  type Api,
  type ApiKeyCredential,
  type AuthInteraction,
  type Model,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BASE_URL,
  ENV_NAMES,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./constants.ts";
import { applyCurrentManifestMetadata } from "./model-manifest.ts";
import { fetchPlanModels } from "./models.ts";

export { BASE_URL, PROVIDER_ID } from "./constants.ts";
export type * from "./types.ts";

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
      ...(accessKeyId ? { [ENV_NAMES.accessKeyId]: accessKeyId } : {}),
      ...(secretAccessKey ? { [ENV_NAMES.secretAccessKey]: secretAccessKey } : {}),
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
  const provider = createProvider<"openai-completions">({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "Volcengine Agent Plan API Key + AK/SK",
        login,
        async resolve({ ctx, credential }) {
          const key = credential?.key
            || (await ctx.env(ENV_NAMES.apiKey))
            || (await ctx.env(ENV_NAMES.legacyApiKey));
          const accessKeyId = await resolveField(ctx, credential, ENV_NAMES.accessKeyId);
          const secretAccessKey = await resolveField(ctx, credential, ENV_NAMES.secretAccessKey);
          if (!key && !accessKeyId && !secretAccessKey) return undefined;
          return {
            auth: key ? { apiKey: key } : {},
            env: {
              ...(accessKeyId ? { [ENV_NAMES.accessKeyId]: accessKeyId } : {}),
              ...(secretAccessKey ? { [ENV_NAMES.secretAccessKey]: secretAccessKey } : {}),
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
  const refreshModels = provider.refreshModels!;
  provider.refreshModels = async (context) => {
    const stored = migrateCachedModels(context.stored);
    const migrated = stored !== context.stored;
    await refreshModels({
      ...context,
      stored,
      publish: (publication) => context.publish(
        migrated && publication.persist === undefined
          ? { ...publication, persist: stored }
          : publication,
      ),
    });
  };
  return provider;
}

export function migrateCachedModels(
  stored: RefreshModelsContext["stored"],
): RefreshModelsContext["stored"] {
  if (!stored) return stored;
  let changed = false;
  const models = stored.models.map((model) => {
    if (model.provider !== PROVIDER_ID || model.api !== "openai-completions") {
      return model;
    }
    changed = true;
    return applyCurrentManifestMetadata(
      model as Model<"openai-completions">,
    ) as Model<Api>;
  });
  return changed ? { ...stored, models } : stored;
}

export default function volcengineAgentPlan(pi: ExtensionAPI): void {
  pi.registerProvider(createAgentPlanProvider());
}
