import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  APP_ID_ENV,
  APP_PROVIDER_ID,
  BRAND_ENV,
  LARK_CREDENTIAL_ENV,
  USER_PROVIDER_ID,
  type LarkBrand,
  type LarkIdentity,
} from "./constants.ts";
import { TenantTokenCache } from "./token-cache.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const tokenCache = new TenantTokenCache();

export interface LarkCliInput {
  args: string[];
  identity?: LarkIdentity;
  stdin?: string;
  timeoutMs?: number;
}

export interface LarkCliResult {
  command: string[];
  identity: LarkIdentity;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

const BLOCKED_COMMANDS = new Set([
  "auth",
  "config",
  "install",
  "profile",
  "profiles",
  "self-update",
  "update",
  "upgrade",
]);

const BLOCKED_FLAGS = [
  "--app-id",
  "--app-secret",
  "--brand",
  "--profile",
  "--tenant-access-token",
  "--user-access-token",
];

export function validateArgs(args: string[]): void {
  if (args.length === 0) throw new Error("args 不能为空");
  for (const arg of args) {
    if (arg.includes("\0")) throw new Error("参数不能包含 NUL 字符");
    const normalized = arg.toLowerCase();
    if (BLOCKED_COMMANDS.has(normalized)) {
      throw new Error(`禁止执行由 Pi 管理的 lark-cli 命令：${arg}`);
    }
    if (normalized === "--as" || normalized.startsWith("--as=")) {
      throw new Error("identity 只能通过工具的 identity 参数设置");
    }
    if (BLOCKED_FLAGS.some((flag) => normalized === flag || normalized.startsWith(`${flag}=`))) {
      throw new Error(`禁止覆盖由 Pi 管理的凭据参数：${arg}`);
    }
  }
}

export function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  values: { appId: string; token: string; brand: LarkBrand; identity: LarkIdentity },
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith("LARKSUITE_CLI_")) delete env[key];
  }
  for (const key of LARK_CREDENTIAL_ENV) delete env[key];
  env.LARKSUITE_CLI_APP_ID = values.appId;
  env.LARKSUITE_CLI_BRAND = values.brand;
  env.LARKSUITE_CLI_DEFAULT_AS = values.identity;
  env.LARKSUITE_CLI_STRICT_MODE = values.identity;
  if (values.identity === "bot") {
    env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN = values.token;
  } else {
    env.LARKSUITE_CLI_USER_ACCESS_TOKEN = values.token;
  }
  return env;
}

function nativeBinaryPath(): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return fileURLToPath(
    new URL(`../node_modules/@larksuite/cli/bin/lark-cli${suffix}`, import.meta.url),
  );
}

function appendLimited(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
): void {
  if (state.bytes >= MAX_OUTPUT_BYTES) {
    state.truncated = true;
    return;
  }
  const remaining = MAX_OUTPUT_BYTES - state.bytes;
  chunks.push(chunk.subarray(0, remaining));
  state.bytes += Math.min(chunk.length, remaining);
  if (chunk.length > remaining) state.truncated = true;
}

export async function spawnLarkCli(
  binary: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & {
    stdin?: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<Omit<LarkCliResult, "command" | "identity">> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outputState = { bytes: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const onAbort = () => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => appendLimited(stdout, chunk, outputState));
    child.stderr.on("data", (chunk: Buffer) => appendLimited(stderr, chunk, outputState));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const marker = outputState.truncated ? "\n[output truncated by Pi]\n" : "";
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8") + marker,
        stderr: Buffer.concat(stderr).toString("utf8") + marker,
        timedOut,
        truncated: outputState.truncated,
      });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function getAppFields(
  auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>,
): { appId: string; appSecret: string; brand: LarkBrand } {
  const appId = auth?.env?.[APP_ID_ENV];
  const brand = auth?.env?.[BRAND_ENV];
  const appSecret = auth?.auth.apiKey;
  if (!appId || !appSecret || (brand !== "feishu" && brand !== "lark")) {
    throw new Error("尚未完成“飞书/Lark 应用配置”；请先通过 /login 创建或复用开放平台应用");
  }
  return { appId, appSecret, brand };
}

export async function runLarkCli(
  input: LarkCliInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<LarkCliResult> {
  signal ??= ctx.signal;
  validateArgs(input.args);
  const identity = input.identity ?? "bot";
  const app = getAppFields(await ctx.modelRegistry.getProviderAuth(APP_PROVIDER_ID));
  let token: string;
  if (identity === "bot") {
    token = await tokenCache.get(app.appId, app.appSecret, app.brand, signal);
  } else {
    const user = await ctx.modelRegistry.getProviderAuth(USER_PROVIDER_ID);
    token = user?.auth.apiKey ?? "";
    if (!token) {
      throw new Error("该操作需要用户身份；请先通过 /login 完成“飞书/Lark 用户授权”");
    }
  }

  const binary = nativeBinaryPath();
  if (!existsSync(binary)) {
    throw new Error(
      "lark-cli 原生二进制未安装。请允许 @larksuite/cli 的受信任 build script 后重新执行 pnpm install。",
    );
  }
  const args = [...input.args, "--as", identity];
  const result = await spawnLarkCli(binary, args, {
    cwd: ctx.cwd,
    env: sanitizedEnvironment(process.env, { appId: app.appId, token, brand: app.brand, identity }),
    stdin: input.stdin,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal,
  });
  return { command: input.args, identity, ...result };
}

export function clearTenantTokenCache(): void {
  tokenCache.clear();
}
