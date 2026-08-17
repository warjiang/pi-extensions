import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LarkBrand } from "./constants.ts";

export const BRIDGE_DIR = join(homedir(), ".pi", "agent", "lark");
export const BRIDGE_CONFIG_FILE = join(BRIDGE_DIR, "config.json");
export const BRIDGE_STATE_FILE = join(BRIDGE_DIR, "state.json");
export const BRIDGE_OWNER_FILE = join(BRIDGE_DIR, "owner.json");
export const BRIDGE_LOCK_FILE = join(BRIDGE_DIR, "daemon.lock");
export const BRIDGE_LOG_FILE = join(BRIDGE_DIR, "daemon.log");
export const BRIDGE_DEBUG_LOG_FILE = join(BRIDGE_DIR, "debug.log");
export const BRIDGE_TMP_DIR = join(BRIDGE_DIR, "tmp");
export const BRIDGE_MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface BridgeConfig {
  version: 1;
  appId: string;
  brand: LarkBrand;
  workspace: string;
  autostart: boolean;
  groupPolicy: "mention" | "open";
  groupKeywords: string[];
  groupAlsoOnReply: boolean;
  ignoreBotMessages: boolean;
  includeQuotedMessage: boolean;
  quotedMessageMaxChars: number;
  maxAttachmentBytes: number;
  debug: boolean;
}

export interface PairingState {
  salt: string;
  hash: string;
  expiresAt: number;
}

export interface BridgeState {
  version: 1;
  appId: string;
  ownerOpenId?: string;
  allowedOpenIds: string[];
  pairing?: PairingState;
  sessions: Record<string, string>;
  workspaces: Record<string, string>;
  botMessageIds: string[];
  messageIds: string[];
}

export interface DaemonOwner {
  version: 1;
  pid: number;
  appId: string;
  startedAt: number;
  heartbeatAt: number;
  status: "starting" | "connected" | "reconnecting" | "stopping" | "failed";
  error?: string;
}

export function defaultBridgeConfig(appId: string, brand: LarkBrand, workspace: string): BridgeConfig {
  return {
    version: 1,
    appId,
    brand,
    workspace: resolve(workspace),
    autostart: false,
    groupPolicy: "mention",
    groupKeywords: [],
    groupAlsoOnReply: true,
    ignoreBotMessages: true,
    includeQuotedMessage: true,
    quotedMessageMaxChars: 8_000,
    maxAttachmentBytes: 5 * 1024 * 1024,
    debug: false,
  };
}

export function defaultBridgeState(appId: string): BridgeState {
  return {
    version: 1,
    appId,
    allowedOpenIds: [],
    sessions: {},
    workspaces: {},
    botMessageIds: [],
    messageIds: [],
  };
}

export async function ensureBridgeDirs(): Promise<void> {
  await mkdir(BRIDGE_TMP_DIR, { recursive: true, mode: 0o700 });
}

export async function capBridgeLog(path: string, maxBytes = BRIDGE_MAX_LOG_BYTES): Promise<void> {
  try {
    if ((await stat(path)).size > maxBytes) await truncate(path, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureBridgeDirs();
  const temporary = join(dirname(path), `.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export const readBridgeConfig = () => readJson<BridgeConfig>(BRIDGE_CONFIG_FILE);
export const readBridgeState = () => readJson<BridgeState>(BRIDGE_STATE_FILE);
export const readDaemonOwner = () => readJson<DaemonOwner>(BRIDGE_OWNER_FILE);
export const writeBridgeConfig = (value: BridgeConfig) => writeJson(BRIDGE_CONFIG_FILE, value);
export const writeBridgeState = (value: BridgeState) => writeJson(BRIDGE_STATE_FILE, value);
export const writeDaemonOwner = (value: DaemonOwner) => writeJson(BRIDGE_OWNER_FILE, value);

export function createPairing(now = Date.now(), ttlMs = 10 * 60_000): { code: string; pairing: PairingState } {
  const code = randomBytes(4).toString("hex").toUpperCase();
  const salt = randomBytes(16);
  const hash = scryptSync(code, salt, 32);
  return {
    code,
    pairing: {
      salt: salt.toString("base64"),
      hash: hash.toString("base64"),
      expiresAt: now + ttlMs,
    },
  };
}

export function verifyPairing(pairing: PairingState | undefined, code: string, now = Date.now()): boolean {
  if (!pairing || pairing.expiresAt < now) return false;
  const expected = Buffer.from(pairing.hash, "base64");
  const actual = scryptSync(code.trim().toUpperCase(), Buffer.from(pairing.salt, "base64"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isAuthorized(state: BridgeState, openId: string): boolean {
  return state.ownerOpenId === openId || state.allowedOpenIds.includes(openId);
}

export async function acquireDaemonLock(): Promise<() => Promise<void>> {
  await ensureBridgeDirs();
  const handle = await open(BRIDGE_LOCK_FILE, "wx", 0o600);
  await handle.writeFile(`${process.pid}\n`);
  return async () => {
    await handle.close();
    await rm(BRIDGE_LOCK_FILE, { force: true });
  };
}

export async function resetBridgeFiles(): Promise<void> {
  await Promise.all([
    rm(BRIDGE_CONFIG_FILE, { force: true }),
    rm(BRIDGE_STATE_FILE, { force: true }),
    rm(BRIDGE_OWNER_FILE, { force: true }),
    rm(BRIDGE_LOCK_FILE, { force: true }),
    rm(BRIDGE_DEBUG_LOG_FILE, { force: true }),
    rm(BRIDGE_LOG_FILE, { force: true }),
  ]);
}
