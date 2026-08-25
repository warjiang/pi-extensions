import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./constants.ts";

export interface VolcengineProviderConfig {
  imageModel?: string;
  videoModel?: string;
  mediaDir?: string;
}

export const PROVIDER_CONFIG_PATH = join(
  getAgentDir(),
  "providers",
  `${PROVIDER_ID}.json`,
);

export async function readProviderConfig(
  path = PROVIDER_CONFIG_PATH,
): Promise<VolcengineProviderConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Volcengine provider config: ${path}`);
  }
  const config = value as Record<string, unknown>;
  return {
    ...(typeof config.imageModel === "string" ? { imageModel: config.imageModel } : {}),
    ...(typeof config.videoModel === "string" ? { videoModel: config.videoModel } : {}),
    ...(typeof config.mediaDir === "string" ? { mediaDir: config.mediaDir } : {}),
  };
}

export async function updateProviderConfig(
  update: Partial<Record<keyof VolcengineProviderConfig, string | undefined>>,
  path = PROVIDER_CONFIG_PATH,
): Promise<VolcengineProviderConfig> {
  const config = { ...await readProviderConfig(path) };
  for (const [key, value] of Object.entries(update) as Array<
    [keyof VolcengineProviderConfig, string | undefined]
  >) {
    if (value) config[key] = value;
    else delete config[key];
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return config;
}
