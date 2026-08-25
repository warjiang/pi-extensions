import {
  createProvider,
  type Api,
  type ApiKeyCredential,
  type AuthInteraction,
  type Model,
  type ProviderStreams,
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
import { registerMediaTools } from "./media-tools.ts";
import { displayModelId, fetchEndpointModels } from "./models.ts";

export { BASE_URL, PROVIDER_ID } from "./constants.ts";
export type * from "./types.ts";

export function endpointIdFromDisplayId(id: string): string {
  const separator = id.lastIndexOf("@");
  const endpointId = separator >= 0 ? id.slice(separator + 1) : id;
  return endpointId.startsWith("ep-") ? endpointId : id;
}

export function endpointIdFromModel<TApi extends Api>(model: Model<TApi>): string {
  const endpointId = (model as Model<TApi> & { endpointId?: unknown }).endpointId;
  return typeof endpointId === "string" && endpointId.startsWith("ep-")
    ? endpointId
    : endpointIdFromDisplayId(model.id);
}

export function withEndpointModelIds(upstream: ProviderStreams): ProviderStreams {
  return {
    stream(model, context, options) {
      return upstream.stream(
        { ...model, id: endpointIdFromModel(model) },
        context,
        options,
      );
    },
    streamSimple(model, context, options) {
      return upstream.streamSimple(
        { ...model, id: endpointIdFromModel(model) },
        context,
        options,
      );
    },
  };
}

export function migrateCachedModels(
  stored: RefreshModelsContext["stored"],
): RefreshModelsContext["stored"] {
  if (!stored) return stored;
  let changed = false;
  const used = new Set<string>();
  const models = stored.models.map((model) => {
    if (model.provider !== PROVIDER_ID) return model;
    const endpointId = endpointIdFromModel(model);
    if (!endpointId.startsWith("ep-")) return model;
    let id = displayModelId(model.name, endpointId);
    if (used.has(id)) {
      const suffix = endpointId.split("-").at(-1) || "endpoint";
      id = `${id}-${suffix}`;
      for (let index = 2; used.has(id); index += 1) {
        id = `${displayModelId(model.name, endpointId)}-${suffix}-${index}`;
      }
    }
    used.add(id);
    const currentEndpointId = (model as Model<Api> & { endpointId?: unknown }).endpointId;
    if (model.id === id && currentEndpointId === endpointId) return model;
    changed = true;
    return { ...model, id, endpointId };
  });
  return changed ? { ...stored, models } : stored;
}

export async function login(interaction: AuthInteraction): Promise<ApiKeyCredential> {
  const key = await interaction.prompt({
    type: "secret",
    message: "Enter your Volcengine Ark API Key:",
    placeholder: "Volcengine Ark API Key",
  });
  const accessKeyId = await interaction.prompt({
    type: "secret",
    message: "Enter your Volcengine Ark Access Key ID:",
    placeholder: "Volcengine Ark Access Key ID",
  });
  const secretAccessKey = await interaction.prompt({
    type: "secret",
    message: "Enter your Volcengine Ark Secret Access Key:",
    placeholder: "Volcengine Ark Secret Access Key",
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

export function createVolcengineProvider() {
  const provider = createProvider<"openai-completions">({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "Volcengine Ark API Key + AK/SK",
        login,
        async resolve({ credential }) {
          const key = credential?.key;
          const accessKeyId = credential?.env?.[ENV_NAMES.accessKeyId];
          const secretAccessKey = credential?.env?.[ENV_NAMES.secretAccessKey];
          if (!key && !accessKeyId && !secretAccessKey) return undefined;
          return {
            auth: key ? { apiKey: key } : {},
            env: {
              ...(accessKeyId ? { [ENV_NAMES.accessKeyId]: accessKeyId } : {}),
              ...(secretAccessKey ? { [ENV_NAMES.secretAccessKey]: secretAccessKey } : {}),
            },
            source: "stored Volcengine credentials",
          };
        },
      },
    },
    models: [] as Model<"openai-completions">[],
    async fetchModels(context: RefreshModelsContext) {
      return fetchEndpointModels(context);
    },
    api: withEndpointModelIds(openAICompletionsApi()),
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

export default function volcengineArk(pi: ExtensionAPI): void {
  pi.registerProvider(createVolcengineProvider());
  registerMediaTools(pi);
}
