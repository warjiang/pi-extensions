import { closeSync, openSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_LOCK_FILE,
  BRIDGE_LOG_FILE,
  BRIDGE_OWNER_FILE,
  acquireDaemonLock,
  capBridgeLog,
  ensureBridgeDirs,
  readBridgeConfig,
  readDaemonOwner,
  writeDaemonOwner,
  type DaemonOwner,
} from "./bridge-store.ts";
import { BridgeRuntime } from "./bridge-runtime.ts";
import { LARK_CREDENTIAL_ENV } from "./constants.ts";
import { readAppCredential } from "./credentials.ts";

const HEARTBEAT_MS = 5_000;
const STALE_MS = 20_000;

export interface BridgeProcessStatus {
  running: boolean;
  stale: boolean;
  owner?: DaemonOwner;
}

export function bridgeDaemonSpawnSpec(
  baseEnv: NodeJS.ProcessEnv,
  entryPath: string,
  foreground = false,
): { args: string[]; env: NodeJS.ProcessEnv; detached: boolean } {
  const args = ["--experimental-strip-types", entryPath, "--daemon"];
  if (foreground) args.push("--foreground");
  const env: NodeJS.ProcessEnv = { ...baseEnv, PI_LARK_BRIDGE_CHILD_SESSION: "1" };
  for (const name of LARK_CREDENTIAL_ENV) delete env[name];
  return { args, env, detached: !foreground };
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isBridgeDaemonProcess(pid: number): boolean {
  if (!isPidAlive(pid)) return false;
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return command.includes("bridge-daemon.ts") && command.includes("--daemon");
  } catch {
    return false;
  }
}

export async function bridgeProcessStatus(now = Date.now()): Promise<BridgeProcessStatus> {
  const owner = await readDaemonOwner();
  if (!owner) return { running: false, stale: false };
  const alive = isBridgeDaemonProcess(owner.pid);
  const stale = !alive || now - owner.heartbeatAt > STALE_MS;
  return { running: alive && !stale, stale, owner };
}

export async function startBridgeDaemon(
  options: { foreground?: boolean; nodePath?: string; entryPath?: string } = {},
): Promise<number> {
  await ensureBridgeDirs();
  const current = await bridgeProcessStatus();
  if (current.running) return current.owner!.pid;
  if (current.stale) {
    if (current.owner && isBridgeDaemonProcess(current.owner.pid)) {
      process.kill(current.owner.pid, "SIGTERM");
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && isPidAlive(current.owner.pid)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await rm(BRIDGE_LOCK_FILE, { force: true });
  }
  const entry = options.entryPath ?? fileURLToPath(import.meta.url);
  const spec = bridgeDaemonSpawnSpec(process.env, entry, options.foreground);
  const log = openSync(BRIDGE_LOG_FILE, "a", 0o600);
  const child = spawn(options.nodePath ?? process.execPath, spec.args, {
    detached: spec.detached,
    stdio: ["ignore", log, log],
    env: spec.env,
    shell: false,
  });
  closeSync(log);
  if (!options.foreground) child.unref();
  if (!child.pid) throw new Error("无法启动 Lark Bridge daemon");
  return child.pid;
}

export async function stopBridgeDaemon(timeoutMs = 10_000): Promise<boolean> {
  const status = await bridgeProcessStatus();
  if (!status.owner || !isBridgeDaemonProcess(status.owner.pid)) return false;
  process.kill(status.owner.pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(status.owner.pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function restartBridgeDaemon(): Promise<number> {
  await stopBridgeDaemon();
  return startBridgeDaemon();
}

export async function runBridgeDaemon(): Promise<void> {
  const config = await readBridgeConfig();
  if (!config) throw new Error("Bridge 尚未 setup");
  const oldStatus = await bridgeProcessStatus();
  if (oldStatus.stale && !isBridgeDaemonProcess(oldStatus.owner?.pid ?? 0)) {
    await rm(BRIDGE_LOCK_FILE, { force: true });
  }
  const releaseLock = await acquireDaemonLock();
  let stopping = false;
  let failed = false;
  let owner: DaemonOwner = {
    version: 1,
    pid: process.pid,
    appId: config.appId,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    status: "starting",
  };
  const runtime = new BridgeRuntime(async (status) => {
    owner = { ...owner, status, heartbeatAt: Date.now() };
    await writeDaemonOwner(owner);
  });
  await writeDaemonOwner(owner);
  const heartbeat = setInterval(() => {
    owner = { ...owner, heartbeatAt: Date.now() };
    void writeDaemonOwner(owner);
    void capBridgeLog(BRIDGE_LOG_FILE);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const shutdown = async (preserveOwner = false) => {
    if (stopping) return;
    stopping = true;
    if (!preserveOwner) {
      owner = { ...owner, status: "stopping", heartbeatAt: Date.now() };
      await writeDaemonOwner(owner).catch(() => undefined);
    }
    clearInterval(heartbeat);
    await runtime.stop().catch(() => undefined);
    await releaseLock().catch(() => undefined);
    if (!preserveOwner) await rm(BRIDGE_OWNER_FILE, { force: true }).catch(() => undefined);
  };
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));

  try {
    await runtime.start();
    owner = { ...owner, status: "connected", heartbeatAt: Date.now() };
    await writeDaemonOwner(owner);
    await new Promise<void>((resolve) => {
      process.once("beforeExit", resolve);
    });
  } catch (error) {
    failed = true;
    const secret = readAppCredential()?.appSecret;
    const raw = error instanceof Error ? error.message : String(error);
    const sanitized = secret ? raw.replaceAll(secret, "[REDACTED]") : raw;
    owner = {
      ...owner,
      status: "failed",
      heartbeatAt: Date.now(),
      error: sanitized,
    };
    await writeDaemonOwner(owner);
    throw error;
  } finally {
    await shutdown(failed);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--daemon")) {
  runBridgeDaemon().catch((error) => {
    const secret = readAppCredential()?.appSecret;
    const raw = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Lark Bridge daemon failed: ${secret ? raw.replaceAll(secret, "[REDACTED]") : raw}\n`);
    process.exitCode = 1;
  });
}
