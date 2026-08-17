import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image } from "@earendil-works/pi-tui";
import { registerApp } from "@larksuiteoapi/node-sdk";
import {
  bridgeProcessStatus,
  restartBridgeDaemon,
  startBridgeDaemon,
  stopBridgeDaemon,
} from "./bridge-daemon.ts";
import {
  BRIDGE_CALLBACKS,
  BRIDGE_EVENTS,
  bridgeAddons,
  bridgeBootstrapAddons,
  bridgeTenantScopes,
  diffBridgePermissions,
  formatBridgePermissionDiff,
  hasBridgePermissionDiff,
} from "./bridge-permissions.ts";
import {
  createPairing,
  defaultBridgeConfig,
  defaultBridgeState,
  readBridgeConfig,
  readBridgeState,
  resetBridgeFiles,
  writeBridgeConfig,
  writeBridgeState,
} from "./bridge-store.ts";
import {
  compactLauncherUrl,
  QR_IMAGE_MAX_HEIGHT_CELLS,
  QR_IMAGE_MAX_WIDTH_CELLS,
  renderQrPngBase64,
} from "./bridge-qr.ts";
import { readAppCredential } from "./credentials.ts";
import {
  exchangeTenantToken,
  isAppManagementPermissionError,
  queryAppScopes,
  queryBotInfo,
} from "./lark-api.ts";

const AUTH_UI_KEY = "lark-bridge-auth";

function usage(): string {
  return [
    "/lark setup",
    "/lark pair",
    "/lark start | stop | restart | status",
    "/lark debug on|off",
    "/lark autostart on|off",
    "/lark allow add|remove|list [open_id]",
    "/lark reset",
  ].join("\n");
}

function isStaleContextError(error: unknown): boolean {
  return error instanceof Error &&
    error.message.includes("ctx is stale after session replacement or reload");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info") {
  try {
    ctx.ui.notify(message, type);
  } catch (error) {
    if (!isStaleContextError(error)) throw error;
  }
}

function updateAuthUi(signal: AbortSignal | undefined, update: () => void): void {
  if (signal?.aborted) return;
  try {
    update();
  } catch (error) {
    if (!isStaleContextError(error)) throw error;
  }
}

function showAuthQrDialog(
  ctx: ExtensionCommandContext,
  pngBase64: string,
  expireIn: number,
  signal?: AbortSignal,
): (() => void) | undefined {
  if (ctx.mode !== "tui" || signal?.aborted || !getCapabilities().images) return undefined;
  let close = () => {};
  let closeRequested = false;
  const dialog = ctx.ui.custom((_tui, theme, _keybindings, done) => {
    let closed = false;
    const image = new Image(
      pngBase64,
      "image/png",
      { fallbackColor: (text) => theme.fg("dim", text) },
      {
        maxWidthCells: QR_IMAGE_MAX_WIDTH_CELLS,
        maxHeightCells: QR_IMAGE_MAX_HEIGHT_CELLS,
        filename: "lark-bridge-authorization.png",
      },
    );
    close = () => {
      if (closed) return;
      closed = true;
      done(undefined);
    };
    signal?.addEventListener("abort", close, { once: true });
    if (closeRequested || signal?.aborted) queueMicrotask(close);
    return {
      render(width: number) {
        return [
          `Lark Bridge 扫码授权（${expireIn} 秒内有效）`,
          "",
          ...image.render(width),
          "",
          "请使用飞书/Lark 扫码；按 Esc 或 Enter 关闭此界面，授权轮询仍会继续。",
        ];
      },
      invalidate() {
        image.invalidate();
      },
      handleInput(data: string) {
        if (data === "\u001b" || data === "\r" || data === "\n") close();
      },
      dispose() {
        signal?.removeEventListener("abort", close);
      },
    };
  });
  void dialog.catch((error) => {
    if (!signal?.aborted && !isStaleContextError(error)) {
      notify(ctx, `二维码界面显示失败：${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
  return () => {
    closeRequested = true;
    close();
  };
}

async function verifyBridge(groupPolicy: "mention" | "open") {
  const app = readAppCredential();
  if (!app) throw new Error("请先完成“飞书/Lark 应用配置”（lark-app）");
  const token = await exchangeTenantToken(app.appId, app.appSecret, app.brand);
  const actual = await queryAppScopes(app.appId, token.token, app.brand);
  if (!actual.botCapability) {
    actual.botCapability = await queryBotInfo(token.token, app.brand)
      .then(() => true)
      .catch(() => false);
  }
  return { app, token, actual, diff: diffBridgePermissions(actual, groupPolicy) };
}

async function augmentBridge(
  ctx: ExtensionCommandContext,
  app: NonNullable<ReturnType<typeof readAppCredential>>,
  groupPolicy: "mention" | "open",
  signal?: AbortSignal,
  bootstrapOnly = false,
): Promise<void> {
  let closeQrDialog = () => {};
  let qrRequestId = 0;
  try {
    const result = await registerApp({
      source: "pi-lark-bridge",
      appId: app.appId,
      addons: bootstrapOnly ? bridgeBootstrapAddons() : bridgeAddons(groupPolicy),
      signal,
      onQRCodeReady(info) {
        const requestId = ++qrRequestId;
        const qrUrl = compactLauncherUrl(info.url);
        updateAuthUi(signal, () => {
          ctx.ui.setWidget(AUTH_UI_KEY, [
            "Lark Bridge 扫码授权",
            `正在生成独立扫码界面，有效期 ${info.expireIn} 秒。`,
            "也可以直接打开下面的授权链接：",
            info.url,
            "终端支持链接时可直接点击，否则复制到浏览器打开。",
          ], { placement: "aboveEditor" });
          ctx.ui.setStatus(AUTH_UI_KEY, "等待扫码确认");
        });
        void renderQrPngBase64(qrUrl)
          .then((pngBase64) => {
            if (requestId !== qrRequestId) return;
            updateAuthUi(signal, () => {
              closeQrDialog();
              const closeDialog = showAuthQrDialog(
                ctx,
                pngBase64,
                info.expireIn,
                signal,
              );
              closeQrDialog = closeDialog ?? (() => {});
              const imageProtocol = getCapabilities().images;
              ctx.ui.setWidget(AUTH_UI_KEY, [
                "Lark Bridge 扫码授权",
                closeDialog
                  ? `二维码已在独立扫码界面显示（${QR_IMAGE_MAX_WIDTH_CELLS}×${QR_IMAGE_MAX_HEIGHT_CELLS} 个终端单元格），有效期 ${info.expireIn} 秒。`
                  : `当前终端不支持 Kitty/iTerm2 内联图片（检测结果：${imageProtocol ?? "none"}），无法在终端内显示二维码。`,
                "也可以直接打开下面的授权链接：",
                info.url,
                "终端支持链接时可直接点击，否则复制到浏览器打开。",
              ], { placement: "aboveEditor" });
              notify(
                ctx,
                closeDialog
                  ? "Bridge 二维码已按宽高等比缩放，授权链接已固定显示在输入框上方。"
                  : "当前终端不支持内联图片，请点击或复制授权链接完成扫码授权。",
                closeDialog ? "info" : "warning",
              );
            });
          })
          .catch((error) => {
            if (requestId !== qrRequestId) return;
            updateAuthUi(signal, () => {
              ctx.ui.setWidget(AUTH_UI_KEY, [
                "Lark Bridge 扫码授权",
                `二维码图片生成失败：${error instanceof Error ? error.message : String(error)}`,
                "请直接打开下面的授权链接：",
                info.url,
              ], { placement: "aboveEditor" });
              notify(ctx, "二维码图片生成失败，请使用授权链接。", "warning");
            });
          });
      },
      onStatusChange(info) {
        updateAuthUi(signal, () => {
          if (info.status === "polling") {
            ctx.ui.setStatus(AUTH_UI_KEY, "等待扫码确认");
          } else if (info.status === "slow_down") {
            ctx.ui.setStatus(AUTH_UI_KEY, "等待扫码确认（平台要求降低轮询频率）");
          } else {
            ctx.ui.setStatus(AUTH_UI_KEY, "已切换至 Lark 国际站，等待扫码确认");
          }
        });
      },
    });
    if (result.client_id !== app.appId) {
      throw new Error("扫码返回了不同的 App ID，已拒绝写入 Bridge 配置");
    }
  } finally {
    qrRequestId++;
    closeQrDialog();
    updateAuthUi(signal, () => {
      ctx.ui.setStatus(AUTH_UI_KEY, undefined);
      ctx.ui.setWidget(AUTH_UI_KEY, undefined);
    });
  }
}

async function setup(ctx: ExtensionCommandContext, signal?: AbortSignal): Promise<void> {
  const app = readAppCredential();
  if (!app) throw new Error("请先完成“飞书/Lark 应用配置”（lark-app）");
  let daemonWasRunning = (await bridgeProcessStatus()).running;
  const oldConfig = await readBridgeConfig();
  if (oldConfig?.appId && oldConfig.appId !== app.appId) {
    await stopBridgeDaemon();
    daemonWasRunning = false;
    await resetBridgeFiles();
    notify(ctx, "检测到 App ID 已改变，旧 owner、allowlist 和 Bridge 运行状态已清除。", "warning");
  }
  const selected = await ctx.ui.select("群聊触发策略", [
    "mention（仅 @、关键词或回复 Bot）",
    "open（授权用户的全部群消息）",
  ]);
  if (!selected) return;
  const groupPolicy: "mention" | "open" = selected.startsWith("open") ? "open" : "mention";
  let verification: Awaited<ReturnType<typeof verifyBridge>>;
  try {
    verification = await verifyBridge(groupPolicy);
  } catch (error) {
    if (!isAppManagementPermissionError(error)) throw error;
    notify(
      ctx,
      "当前应用缺少应用自管理读取权限，Bridge 无法核验自身的权限、事件和回调配置。",
      "warning",
    );
    const augment = await ctx.ui.confirm(
      "扫码开通 Bridge 基础权限",
      "二维码仅增量开通 application:application:self_manage，用于读取并核验当前应用配置。",
    );
    if (!augment) throw error;
    await augmentBridge(ctx, app, groupPolicy, signal, true);
    verification = await verifyBridge(groupPolicy);
  }
  if (hasBridgePermissionDiff(verification.diff)) {
    notify(ctx, `Bridge 配置尚不完整：\n${formatBridgePermissionDiff(verification.diff)}`, "warning");
    const addonsCanHelp = verification.diff.tenantScopes.length > 0 ||
      verification.diff.callbacks.length > 0 ||
      !verification.diff.botCapability;
    const augment = addonsCanHelp && await ctx.ui.confirm(
      "扫码补齐 Bridge 权限",
      "将打开飞书/Lark 扫码页面，对当前应用增量添加 Bridge scopes、events 和 CardKit callback。addons 不能切换订阅方式；平台未应用的事件仍需在开放平台手动配置。",
    );
    if (augment) {
      await augmentBridge(ctx, app, groupPolicy, signal);
      verification = await verifyBridge(groupPolicy);
    }
  }
  if (hasBridgePermissionDiff(verification.diff)) {
    notify(ctx, [
      "Bridge 仍需在飞书/Lark 开放平台手动完成以下配置：",
      "1. 打开当前应用的“事件与回调”。",
      "2. 将事件订阅方式设为“使用长连接接收事件”。",
      verification.diff.events.length
        ? `3. 添加事件：${verification.diff.events.join(", ")}`
        : "",
      verification.diff.callbacks.length
        ? `4. 添加回调：${verification.diff.callbacks.join(", ")}`
        : "",
      "完成后重新执行 /lark setup 核验。",
    ].filter(Boolean).join("\n"), "warning");
  }

  const config = {
    ...defaultBridgeConfig(app.appId, app.brand, ctx.cwd),
    ...(oldConfig?.appId === app.appId ? oldConfig : {}),
    appId: app.appId,
    brand: app.brand,
    workspace: oldConfig?.appId === app.appId ? oldConfig.workspace : ctx.cwd,
    groupPolicy,
  };
  const existingState = await readBridgeState();
  const state = existingState?.appId === app.appId
    ? existingState
    : defaultBridgeState(app.appId);
  const { code, pairing } = createPairing();
  if (!state.ownerOpenId) state.pairing = pairing;
  await writeBridgeConfig(config);
  await writeBridgeState(state);
  const finalDiff = formatBridgePermissionDiff(verification.diff);
  notify(ctx, [
    "Lark Bridge setup 已保存（尚未启动 daemon）。",
    finalDiff,
    state.ownerOpenId
      ? `owner 已配对：${state.ownerOpenId}`
      : `一次性配对码：${code}\n请在飞书/Lark 私聊 Bot 发送：/pair ${code}\n配对码 10 分钟后过期。`,
    daemonWasRunning
      ? "daemon 当前仍使用旧配置；请执行 /lark restart 使本次 setup 生效。"
      : "",
  ].filter(Boolean).join("\n\n"), hasBridgePermissionDiff(verification.diff) || daemonWasRunning ? "warning" : "info");
}

async function pair(ctx: ExtensionCommandContext): Promise<void> {
  const config = await readBridgeConfig();
  const state = await readBridgeState();
  if (!config || !state) throw new Error("请先执行 /lark setup");
  if (state.ownerOpenId) throw new Error(`owner 已配对：${state.ownerOpenId}；如需重置请执行 /lark reset`);
  const { code, pairing } = createPairing();
  state.pairing = pairing;
  await writeBridgeState(state);
  const restart = (await bridgeProcessStatus()).running
    ? "\ndaemon 正在运行；请先执行 /lark restart 以加载新配对码。"
    : "";
  notify(ctx, `一次性配对码：${code}\n请在 10 分钟内私聊 Bot 发送：/pair ${code}${restart}`);
}

async function status(ctx: ExtensionCommandContext): Promise<void> {
  const config = await readBridgeConfig();
  const state = await readBridgeState();
  const processStatus = await bridgeProcessStatus();
  notify(ctx, [
    `setup: ${config ? "yes" : "no"}`,
    `daemon: ${processStatus.running ? "running" : processStatus.stale ? "stale" : "stopped"}`,
    processStatus.owner ? `pid: ${processStatus.owner.pid}` : "",
    processStatus.owner ? `connection: ${processStatus.owner.status}` : "",
    processStatus.owner?.error ? `error: ${processStatus.owner.error}` : "",
    config ? `appId: ${config.appId}` : "",
    config ? `workspace: ${config.workspace}` : "",
    config ? `autostart: ${config.autostart}` : "",
    config ? `groupPolicy: ${config.groupPolicy}` : "",
    state?.ownerOpenId ? `owner: ${state.ownerOpenId}` : "owner: not paired",
    state ? `allowlist: ${state.allowedOpenIds.length}` : "",
  ].filter(Boolean).join("\n"));
}

async function allow(ctx: ExtensionCommandContext, action: string | undefined, openId: string | undefined) {
  const state = await readBridgeState();
  if (!state) throw new Error("请先执行 /lark setup");
  if (action === "list" || !action) {
    notify(ctx, state.allowedOpenIds.length ? state.allowedOpenIds.join("\n") : "allowlist 为空");
    return;
  }
  if (!openId) throw new Error("需要提供 open_id");
  if (action === "add") {
    if (!state.allowedOpenIds.includes(openId)) state.allowedOpenIds.push(openId);
  } else if (action === "remove") {
    state.allowedOpenIds = state.allowedOpenIds.filter((item) => item !== openId);
  } else {
    throw new Error("用法：/lark allow add|remove|list <open_id>");
  }
  await writeBridgeState(state);
  const restart = (await bridgeProcessStatus()).running
    ? "；请执行 /lark restart 使变更生效"
    : "";
  notify(ctx, `allowlist 已更新：${state.allowedOpenIds.length} 个额外用户${restart}`);
}

async function setConfigFlag(
  ctx: ExtensionCommandContext,
  field: "autostart" | "debug",
  value: string | undefined,
) {
  const config = await readBridgeConfig();
  if (!config) throw new Error("请先执行 /lark setup");
  if (value !== "on" && value !== "off") throw new Error(`用法：/lark ${field} on|off`);
  config[field] = value === "on";
  await writeBridgeConfig(config);
  notify(ctx, `${field} 已${config[field] ? "开启" : "关闭"}${field === "debug" ? "；重启 daemon 后生效" : ""}`);
}

export async function handleLarkCommand(
  args: string,
  ctx: ExtensionCommandContext,
  lifecycleSignal?: AbortSignal,
): Promise<void> {
  if (lifecycleSignal?.aborted) return;
  const [command, subcommand, value] = args.trim().split(/\s+/);
  try {
    switch (command || "status") {
      case "setup":
        await setup(ctx, lifecycleSignal);
        break;
      case "pair":
        await pair(ctx);
        break;
      case "start": {
        const config = await readBridgeConfig();
        const app = readAppCredential();
        if (!config || !app) throw new Error("请先配置 lark-app 并执行 /lark setup");
        if (config.appId !== app.appId) throw new Error("App ID 已改变，请重新执行 /lark setup");
        const pid = await startBridgeDaemon();
        notify(ctx, `Lark Bridge daemon 已启动，PID ${pid}`);
        break;
      }
      case "stop":
        notify(ctx, await stopBridgeDaemon() ? "Lark Bridge daemon 已停止" : "Lark Bridge daemon 未运行");
        break;
      case "restart":
        if (!(await readBridgeConfig()) || !readAppCredential()) {
          throw new Error("请先配置 lark-app 并执行 /lark setup");
        }
        notify(ctx, `Lark Bridge daemon 已重启，PID ${await restartBridgeDaemon()}`);
        break;
      case "status":
        await status(ctx);
        break;
      case "debug":
        await setConfigFlag(ctx, "debug", subcommand);
        break;
      case "autostart":
        await setConfigFlag(ctx, "autostart", subcommand);
        break;
      case "allow":
        await allow(ctx, subcommand, value);
        break;
      case "reset": {
        const confirmed = await ctx.ui.confirm(
          "重置 Lark Bridge",
          "将停止 daemon 并清除 Bridge 配置、owner、allowlist、会话映射和 dedupe；不会删除 Pi 会话历史或 lark-app/lark-user credentials。",
        );
        if (!confirmed) return;
        await stopBridgeDaemon();
        await resetBridgeFiles();
        notify(ctx, "Lark Bridge 已重置。");
        break;
      }
      default:
        notify(ctx, usage(), "warning");
    }
  } catch (error) {
    if (lifecycleSignal?.aborted || isStaleContextError(error)) return;
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

export function registerBridge(pi: ExtensionAPI): void {
  const lifecycle = new AbortController();
  pi.registerCommand("lark", {
    description: "配置和管理 Feishu/Lark WebSocket 聊天桥接",
    handler: (args, ctx) => handleLarkCommand(args, ctx, lifecycle.signal),
  });
  pi.on("session_shutdown", (_event, ctx) => {
    lifecycle.abort();
    ctx.ui.setStatus(AUTH_UI_KEY, undefined);
    ctx.ui.setWidget(AUTH_UI_KEY, undefined);
  });
  pi.on("session_start", async () => {
    if (process.env.PI_LARK_BRIDGE_CHILD_SESSION === "1") return;
    const config = await readBridgeConfig().catch(() => undefined);
    if (!config?.autostart) return;
    if (readAppCredential()?.appId !== config.appId) return;
    const status = await bridgeProcessStatus().catch(() => ({ running: false, stale: false }));
    if (!status.running) await startBridgeDaemon().catch(() => undefined);
  });
}
