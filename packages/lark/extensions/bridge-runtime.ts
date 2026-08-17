import { mkdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { type Context, contentText } from "@earendil-works/pi-ai";
import {
  createLarkChannel,
  Domain,
  LoggerLevel,
  type CardActionEvent,
  type LarkChannel,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import { readAppCredential } from "./credentials.ts";
import {
  BRIDGE_DEBUG_LOG_FILE,
  BRIDGE_TMP_DIR,
  capBridgeLog,
  ensureBridgeDirs,
  isAuthorized,
  readBridgeConfig,
  readBridgeState,
  verifyPairing,
  writeBridgeState,
  type BridgeConfig,
  type BridgeState,
} from "./bridge-store.ts";

interface Conversation {
  key: string;
  workspace: string;
  session: AgentSession;
}

interface ActiveRun {
  runId: string;
  key: string;
  ownerOpenId: string;
  session: AgentSession;
  stopped: boolean;
}

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".csv", ".go", ".h", ".html", ".java", ".js", ".json",
  ".jsx", ".log", ".md", ".mjs", ".py", ".rs", ".sh", ".sql", ".svg", ".toml", ".ts",
  ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function conversationKey(message: NormalizedMessage, topicMode = false): string {
  if (message.chatType === "p2p") return `p2p:${message.chatId}`;
  const topicId = message.threadId || message.rootId;
  return topicMode && topicId
    ? `topic:${message.chatId}:${topicId}`
    : `group:${message.chatId}`;
}

export function shouldTriggerGroup(
  message: NormalizedMessage,
  config: Pick<BridgeConfig, "groupPolicy" | "groupKeywords" | "groupAlsoOnReply">,
  botMessageIds: readonly string[],
): boolean {
  if (message.chatType === "p2p") return true;
  if (message.mentionAll) return false;
  if (config.groupPolicy === "open" || message.mentionedBot) return true;
  if (config.groupKeywords.some((keyword) => keyword && message.content.includes(keyword))) return true;
  return config.groupAlsoOnReply &&
    Boolean(message.replyToMessageId && botMessageIds.includes(message.replyToMessageId));
}

function statusCard(
  status: "running" | "stopped" | "done" | "failed",
  body: string,
  key: string,
  runId: string,
  title?: string,
): object {
  // Visible unicode emoji in the header guarantees status feedback even when
  // the bot can't add message reactions (e.g. permission scope missing).
  const statusEmoji: Record<typeof status, string> = {
    running: "🤔",
    stopped: "🛑",
    done: "✅",
    failed: "💥",
  };
  const labels = { running: "思考中", stopped: "已停止", done: "完成", failed: "失败" };
  const elements: object[] = [{
    tag: "markdown",
    element_id: "bridge_output",
    content: body || (status === "running" ? "正在思考…" : "（无文本输出）"),
  }];
  if (status === "running") {
    // schema 2.0 dropped the `tag: action` container — put the button
    // directly in body.elements (with behaviors.callback for JSON 2.0).
    elements.push({
      tag: "button",
      type: "danger",
      text: { tag: "plain_text", content: "停止" },
      value: { action: "stop", key, runId },
      behaviors: [{ type: "callback", value: { action: "stop", key, runId } }],
    });
  }
  const headerText = title?.trim() ? `${statusEmoji[status]} ${title.trim()}` : `${statusEmoji[status]} ${labels[status]}`;
  return {
    schema: "2.0",
    config: {
      streaming_mode: status === "running",
      summary: { content: headerText },
    },
    header: {
      title: { tag: "plain_text", content: headerText },
      template: status === "failed" ? "red" : status === "done" ? "green" : "blue",
    },
    body: { elements },
  };
}

function choiceCard(title: string, description: string, actions: object[]): object {
  const elements: object[] = [{ tag: "markdown", content: description }];
  // schema 2.0: buttons go directly in body.elements, not in `tag: action`.
  for (const action of actions) elements.push(action);
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title }, template: "blue" },
    body: { elements },
  };
}

function choiceButton(label: string, value: Record<string, unknown>): object {
  // schema 2.0: buttons live directly in body.elements. Carry both `value`
  // (legacy callback) and `behaviors.callback` (JSON 2.0 callback).
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    value,
    behaviors: [{ type: "callback", value }],
  };
}

function fallbackTitle(input: string): string {
  const line = input.trim().split(/\r?\n/)[0]?.replace(/[#>*`_~\-]/g, "").trim() ?? "";
  if (!line) return "";
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

/** Feishu message-reaction emoji types per lifecycle stage. */
const REACT_EMOJI = {
  received: "Get", // 🉐 — message acknowledged, queued for the agent
  done: "Done", // ✅ — finished successfully
  stopped: "Shake", // 🤷 — aborted by the user
  failed: "Cry", // 😭 — something went wrong
} as const;
const REACT_EMOJIS = new Set(Object.values(REACT_EMOJI));

function extractSenderType(message: NormalizedMessage): string | undefined {
  const raw = message.raw as {
    sender?: { sender_type?: string };
    event?: { sender?: { sender_type?: string } };
  } | undefined;
  return raw?.sender?.sender_type ?? raw?.event?.sender?.sender_type;
}

function mimeForImage(name?: string): string {
  switch (extname(name ?? "").toLowerCase()) {
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    default: return "image/png";
  }
}

export class BridgeRuntime {
  private readonly conversations = new Map<string, Conversation>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly chatModes = new Map<string, "p2p" | "group" | "topic">();
  private pairingQueue = Promise.resolve();
  private channel?: LarkChannel;
  private config?: BridgeConfig;
  private state?: BridgeState;
  private stateWrite = Promise.resolve();
  private appSecret = "";
  private readonly onConnectionStatus?: (
    status: "connected" | "reconnecting",
  ) => void | Promise<void>;

  constructor(
    onConnectionStatus?: (status: "connected" | "reconnecting") => void | Promise<void>,
  ) {
    this.onConnectionStatus = onConnectionStatus;
  }

  async start(): Promise<void> {
    await ensureBridgeDirs();
    const app = readAppCredential();
    const config = await readBridgeConfig();
    const state = await readBridgeState();
    if (!app || !config || !state) throw new Error("Bridge 尚未 setup");
    if (app.appId !== config.appId || state.appId !== config.appId) {
      throw new Error("App ID 已改变，请重新执行 /lark setup");
    }
    this.config = config;
    state.allowedOpenIds ??= [];
    state.sessions ??= {};
    state.workspaces ??= {};
    state.botMessageIds ??= [];
    state.messageIds ??= [];
    this.state = state;
    this.appSecret = app.appSecret;
    process.env.PI_LARK_BRIDGE_CHILD_SESSION = "1";
    this.channel = createLarkChannel({
      appId: app.appId,
      appSecret: app.appSecret,
      transport: "websocket",
      domain: app.brand === "lark" ? Domain.Lark : Domain.Feishu,
      source: "pi-lark-bridge",
      handshakeTimeoutMs: 30_000,
      includeRawEvent: true,
      safety: {
        dedup: { ttl: 10 * 60_000, maxEntries: 2_000 },
        chatQueue: { enabled: true },
        staleMessageWindowMs: 5 * 60_000,
      },
      policy: {
        requireMention: false,
        respondToMentionAll: false,
        dmMode: "open",
      },
      outbound: {
        allowedFileDirs: [BRIDGE_TMP_DIR],
        ssrfGuard: true,
        streamThrottleMs: 120,
        streamThrottleChars: 30,
        streamMaxElementChars: 28_000,
        retry: { maxAttempts: 3, baseDelayMs: 300 },
      },
      loggerLevel: config.debug ? LoggerLevel.debug : LoggerLevel.warn,
    });
    this.channel.on("message", (message) => this.onMessage(message));
    this.channel.on("cardAction", (event) => this.onCardAction(event));
    this.channel.on("error", (error) => this.debug(`channel error: ${this.redact(safeError(error))}`));
    this.channel.on("reconnecting", () => {
      void this.onConnectionStatus?.("reconnecting");
      void this.debug("channel reconnecting");
    });
    this.channel.on("reconnected", () => {
      void this.onConnectionStatus?.("connected");
      void this.debug("channel reconnected");
    });
    await this.channel.connect();
  }

  async stop(): Promise<void> {
    for (const run of this.activeRuns.values()) await run.session.abort().catch(() => undefined);
    for (const conversation of this.conversations.values()) conversation.session.dispose();
    this.conversations.clear();
    await this.channel?.disconnect();
  }

  private async debug(message: string): Promise<void> {
    if (!this.config?.debug) return;
    await mkdir(resolve(BRIDGE_TMP_DIR, ".."), { recursive: true, mode: 0o700 });
    await capBridgeLog(BRIDGE_DEBUG_LOG_FILE);
    await writeFile(BRIDGE_DEBUG_LOG_FILE, `${new Date().toISOString()} ${message}\n`, {
      flag: "a",
      mode: 0o600,
    });
  }

  private redact(value: string): string {
    return this.appSecret ? value.replaceAll(this.appSecret, "[REDACTED]") : value;
  }

  private saveState(): Promise<void> {
    const state = this.state;
    if (!state) return Promise.resolve();
    this.stateWrite = this.stateWrite.then(() => writeBridgeState(state));
    return this.stateWrite;
  }

  private async onMessage(message: NormalizedMessage): Promise<void> {
    const config = this.config;
    const state = this.state;
    const channel = this.channel;
    if (!config || !state || !channel) return;
    if (config.ignoreBotMessages && extractSenderType(message) === "app") return;
    if (state.messageIds.includes(message.messageId)) return;
    state.messageIds.push(message.messageId);
    if (state.messageIds.length > 2_000) state.messageIds.splice(0, state.messageIds.length - 2_000);
    await this.saveState();

    const pairMatch = message.content.trim().match(/^\/pair\s+(\S+)$/i);
    if (pairMatch) {
      const pairing = this.pairingQueue.then(async () => {
        if (message.chatType !== "p2p") return;
        if (state.ownerOpenId) {
          await channel.send(message.chatId, { text: "此 Bridge 已完成 owner 配对。" });
          return;
        }
        if (!verifyPairing(state.pairing, pairMatch[1])) {
          await channel.send(message.chatId, { text: "配对码无效或已过期。" });
          return;
        }
        state.ownerOpenId = message.senderId;
        delete state.pairing;
        await this.saveState();
        await channel.send(message.chatId, { text: "配对成功。你现在是此 Pi Bridge 的 owner。" });
      });
      this.pairingQueue = pairing.catch(() => undefined);
      await pairing;
      return;
    }

    if (!isAuthorized(state, message.senderId)) return;
    const topicMode = message.chatType === "group" &&
      (this.chatModes.get(message.chatId) ??
        await channel.getChatMode(message.chatId).catch(() => "group")) === "topic";
    if (message.chatType === "group") {
      this.chatModes.set(message.chatId, topicMode ? "topic" : "group");
    }
    if (!shouldTriggerGroup(message, config, state.botMessageIds)) return;
    const key = conversationKey(message, topicMode);
    if (message.content.trim().startsWith("/")) {
      await this.handleCommand(message, key);
      return;
    }
    await this.runPrompt(message, key);
  }

  private async handleCommand(message: NormalizedMessage, key: string): Promise<void> {
    const channel = this.channel!;
    const state = this.state!;
    const [command, ...parts] = message.content.trim().split(/\s+/);
    const arg = parts.join(" ");
    if (command === "/commands") {
      await channel.send(message.chatId, {
        markdown: "/new · /resume [序号] · /model [provider/model] · /thinking [level] · /stop · /workspace [path] · /status · /commands · /config",
      });
      return;
    }
    if (command === "/stop") {
      const run = this.activeRuns.get(key);
      if (run) {
        run.stopped = true;
        await run.session.abort();
      }
      await channel.send(message.chatId, { text: run ? "已请求停止当前任务。" : "当前没有运行中的任务。" });
      return;
    }
    if (command === "/config") {
      if (message.chatType !== "p2p" || state.ownerOpenId !== message.senderId) return;
      await channel.send(message.chatId, {
        markdown: [
          `workspace: \`${state.workspaces[key] ?? this.config!.workspace}\``,
          `groupPolicy: \`${this.config!.groupPolicy}\``,
          `allowlist: ${state.allowedOpenIds.length}`,
        ].join("\n\n"),
      });
      return;
    }
    if (command === "/workspace") {
      if (!arg) {
        await channel.send(message.chatId, { text: state.workspaces[key] ?? this.config!.workspace });
        return;
      }
      const workspace = resolve(state.workspaces[key] ?? this.config!.workspace, arg);
      state.workspaces[key] = workspace;
      delete state.sessions[key];
      this.conversations.get(key)?.session.dispose();
      this.conversations.delete(key);
      await this.saveState();
      await channel.send(message.chatId, { text: `workspace 已切换为 ${workspace}；下一条消息将创建新 session。` });
      return;
    }
    if (command === "/new") {
      delete state.sessions[key];
      this.conversations.get(key)?.session.dispose();
      this.conversations.delete(key);
      await this.saveState();
      await channel.send(message.chatId, { text: "已为此会话创建新的 Pi session。" });
      return;
    }
    const conversation = await this.getConversation(key);
    if (command === "/status") {
      await channel.send(message.chatId, {
        markdown: [
          `session: \`${conversation.session.sessionId}\``,
          `model: \`${conversation.session.model ? `${conversation.session.model.provider}/${conversation.session.model.id}` : "未配置"}\``,
          `thinking: \`${conversation.session.thinkingLevel ?? "default"}\``,
          `workspace: \`${conversation.workspace}\``,
        ].join("\n\n"),
      });
      return;
    }
    if (command === "/thinking") {
      if (!arg) {
        await channel.send(message.chatId, {
          card: choiceCard(
            "选择 Thinking Level",
            `当前：\`${conversation.session.thinkingLevel ?? "default"}\``,
            ["off", "minimal", "low", "medium", "high", "xhigh"].map((level) =>
              choiceButton(level, { action: "thinking", key, level })
            ),
          ),
        });
        return;
      }
      if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(arg)) {
        await channel.send(message.chatId, { text: "可选：off, minimal, low, medium, high, xhigh" });
        return;
      }
      conversation.session.setThinkingLevel(arg as "off" | "minimal" | "low" | "medium" | "high" | "xhigh");
      await channel.send(message.chatId, { text: `thinking 已切换为 ${arg}` });
      return;
    }
    if (command === "/model") {
      if (!arg) {
        await channel.send(message.chatId, {
          card: choiceCard(
            "切换模型",
            `当前：\`${conversation.session.model
              ? `${conversation.session.model.provider}/${conversation.session.model.id}`
              : "未配置"}\``,
            [
              choiceButton("上一个", { action: "model", key, direction: "backward" }),
              choiceButton("下一个", { action: "model", key, direction: "forward" }),
            ],
          ),
        });
        return;
      }
      const direction = arg === "prev" || arg === "previous" ? "backward" : "forward";
      const changed = await conversation.session.cycleModel(direction);
      await channel.send(message.chatId, {
        text: changed
          ? `model 已切换为 ${changed.model.provider}/${changed.model.id}`
          : "当前没有其他可切换模型。",
      });
      return;
    }
    if (command === "/resume") {
      const sessions = await SessionManager.list(conversation.workspace);
      if (!arg) {
        const choices = sessions.slice(0, 5).map((session, index) =>
          choiceButton(
            `${index + 1}. ${(session.name || session.firstMessage || session.id).slice(0, 24)}`,
            { action: "resume", key, index },
          )
        );
        await channel.send(message.chatId, {
          card: choiceCard(
            "恢复 Pi Session",
            choices.length ? "选择最近的 session：" : "当前 workspace 没有可恢复的 session。",
            choices,
          ),
        });
        return;
      }
      const index = Math.max(0, Number.parseInt(arg || "1", 10) - 1);
      const selected = sessions[index];
      if (!selected?.path) {
        await channel.send(message.chatId, { text: "没有找到可恢复的 session；可使用 /resume 1。" });
        return;
      }
      conversation.session.dispose();
      const reopened = await this.createConversation(key, conversation.workspace, selected.path);
      this.conversations.set(key, reopened);
      state.sessions[key] = selected.path;
      await this.saveState();
      await channel.send(message.chatId, { text: `已恢复 session ${index + 1}。` });
      return;
    }
    await channel.send(message.chatId, { text: "未知命令。发送 /commands 查看可用命令。" });
  }

  private async getConversation(key: string): Promise<Conversation> {
    const existing = this.conversations.get(key);
    if (existing) return existing;
    const state = this.state!;
    const workspace = state.workspaces[key] ?? this.config!.workspace;
    const conversation = await this.createConversation(key, workspace, state.sessions[key]);
    this.conversations.set(key, conversation);
    if (conversation.session.sessionFile) {
      state.sessions[key] = conversation.session.sessionFile;
      await this.saveState();
    }
    return conversation;
  }

  private async createConversation(key: string, workspace: string, sessionFile?: string): Promise<Conversation> {
    const manager = sessionFile
      ? SessionManager.open(sessionFile, undefined, workspace)
      : SessionManager.create(workspace);
    const { session } = await createAgentSession({
      cwd: workspace,
      sessionManager: manager,
      sessionStartEvent: { type: "session_start", reason: sessionFile ? "resume" : "new" },
    });
    return { key, workspace, session };
  }

  private async messageInput(message: NormalizedMessage): Promise<{
    text: string;
    images: { type: "image"; data: string; mimeType: string }[];
  }> {
    const config = this.config!;
    const channel = this.channel!;
    const sections = [message.content.trim()];
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    for (const resource of message.resources) {
      if (resource.type === "image") {
        const data = await channel.downloadResource(resource.fileKey, "image");
        if (data.length <= config.maxAttachmentBytes) {
          images.push({ type: "image", data: data.toString("base64"), mimeType: mimeForImage(resource.fileName) });
        }
        continue;
      }
      if (resource.type === "file") {
        const extension = extname(resource.fileName ?? "").toLowerCase();
        if (!TEXT_EXTENSIONS.has(extension)) {
          sections.push(`[附件：${resource.fileName ?? resource.fileKey}，未自动解析]`);
          continue;
        }
        const data = await channel.downloadResource(resource.fileKey, "file");
        if (data.length > config.maxAttachmentBytes) {
          sections.push(`[附件：${resource.fileName ?? resource.fileKey}，超过大小限制]`);
          continue;
        }
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
          sections.push(`附件 ${resource.fileName ?? "file"}：\n\`\`\`\n${text}\n\`\`\``);
        } catch {
          sections.push(`[附件：${resource.fileName ?? resource.fileKey}，不是有效 UTF-8 文本]`);
        }
        continue;
      }
      sections.push(`[附件：${resource.fileName ?? resource.type}，类型 ${resource.type}，未自动处理]`);
    }
    if (config.includeQuotedMessage && message.replyToMessageId) {
      const quoted = await this.fetchQuotedMessage(message.replyToMessageId);
      if (quoted) sections.push(`引用消息：\n> ${quoted.slice(0, config.quotedMessageMaxChars).replace(/\n/g, "\n> ")}`);
    }
    return { text: sections.filter(Boolean).join("\n\n"), images };
  }

  private async fetchQuotedMessage(messageId: string): Promise<string | undefined> {
    try {
      const response = await (this.channel!.rawClient.im.v1.message.get as unknown as
        (params: { path: { message_id: string } }) => Promise<{
          data?: { items?: { body?: { content?: string } }[] };
        }>)({ path: { message_id: messageId } });
      const content = response.data?.items?.[0]?.body?.content;
      if (!content) return undefined;
      try {
        const parsed = JSON.parse(content) as { text?: string; content?: unknown };
        return parsed.text ?? JSON.stringify(parsed.content ?? parsed);
      } catch {
        return content;
      }
    } catch {
      return undefined;
    }
  }

  private async runPrompt(message: NormalizedMessage, key: string): Promise<void> {
    const channel = this.channel!;
    const conversation = await this.getConversation(key);
    const input = await this.messageInput(message);
    const runId = randomRunId();
    const active: ActiveRun = {
      runId,
      key,
      ownerOpenId: message.senderId,
      session: conversation.session,
      stopped: false,
    };
    this.activeRuns.set(key, active);
    let output = "";
    let unsubscribe: () => void = () => {};
    // Acknowledge the message instantly with a 🉐 reaction so the user sees
    // it was received, before the agent/card starts streaming.
    void this.setReaction(message.messageId, "received");
    let reactionStage: keyof typeof REACT_EMOJI | undefined = "received";
    let reactionFinal = false;
    try {
      // Auto-generate a concise title from the user's question via a lightweight
      // model call; shows an instant fallback (first line of the input) while the
      // model is thinking, then refreshes the card header when the title arrives.
      let title = fallbackTitle(input.text);
      let settled = false;
      const result = await channel.stream(message.chatId, {
        card: {
          initial: statusCard("running", "", key, runId, title),
          producer: async (controller) => {
            this.rememberBotMessage(controller.messageId);
            void this.generateTitle(input.text, conversation.session).then((generated) => {
              if (!generated || settled) return;
              title = generated;
              void controller.update(statusCard("running", output, key, runId, title))
                .catch((error) => this.debug(`card title update failed: ${this.redact(safeError(error))}`));
            });
            unsubscribe = conversation.session.subscribe((event: AgentSessionEvent) => {
              if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
                output += event.assistantMessageEvent.delta;
                void controller.update(statusCard("running", output, key, runId, title))
                  .catch((error) => this.debug(`card update failed: ${this.redact(safeError(error))}`));
              }
            });
            try {
              await conversation.session.prompt(input.text || "请处理这些附件。", {
                images: input.images,
                source: "extension",
              });
              settled = true;
              const stage = active.stopped ? "stopped" : "done";
              await controller.update(statusCard(stage, output, key, runId, title));
              if (reactionStage !== stage) {
                reactionStage = stage;
                if (!reactionFinal) { reactionFinal = true; void this.setReaction(message.messageId, stage); }
              }
            } catch (error) {
              settled = true;
              const stage = active.stopped ? "stopped" : "failed";
              const reason = this.redact(safeError(error));
              await controller.update(statusCard(
                stage,
                output || (active.stopped ? "任务已停止。" : `处理失败：${reason}`),
                key,
                runId,
                title,
              ));
              if (reactionStage !== stage) {
                reactionStage = stage;
                if (!reactionFinal) { reactionFinal = true; void this.setReaction(message.messageId, stage); }
              }
            }
          },
        },
      }, {
        replyTo: message.messageId,
        replyInThread: Boolean(message.threadId || message.rootId),
      });
      this.rememberBotMessage(result.messageId);
      for (const id of result.chunkIds ?? []) this.rememberBotMessage(id);
    } catch (error) {
      const reason = this.redact(safeError(error));
      const text = output
        ? `${output}\n\n---\n失败：${reason}`
        : `处理失败：${reason}`;
      await channel.send(message.chatId, { markdown: text }, { replyTo: message.messageId }).catch(() => undefined);
      if (!reactionFinal) { reactionFinal = true; void this.setReaction(message.messageId, "failed"); }
    } finally {
      unsubscribe();
      if (this.activeRuns.get(key)?.runId === runId) this.activeRuns.delete(key);
    }
  }

  /**
   * Generate a concise title for the card from the user's question via a
   * lightweight (no-tools, non-streaming) model call. Returns "" on failure
   * so callers can fall back to a static label.
   */
  private async generateTitle(input: string, session: AgentSession): Promise<string> {
    const model = session.model;
    if (!model) return "";
    const trimmed = input.trim().replace(/\s+/g, " ");
    if (!trimmed) return "";
    const context: Context = {
      systemPrompt:
        "你是标题生成器。根据用户的提问生成一个简洁的中文标题：不超过 16 个字，不加标点符号，不加引号，只输出标题本身。",
      messages: [{ role: "user", content: trimmed.slice(0, 800), timestamp: Date.now() }],
    };
    try {
      const res = await session.modelRuntime.completeSimple(model, context);
      let title = contentText(res.content).trim();
      title = title
        .replace(/^["'“”‘’（）()]+|["'“”‘’（）()]+$/g, "")
        .replace(/[。.！!？?…]+$/g, "")
        .trim();
      const firstLine = title.split(/\r?\n/)[0]?.trim() ?? "";
      if (!firstLine) return "";
      const final = firstLine.slice(0, 40);
      if (final) session.setSessionName(final);
      return final;
    } catch (error) {
      await this.debug(`generate title failed: ${this.redact(safeError(error))}`);
      return "";
    }
  }

  /**
   * Best-effort: swap the emoji reaction on a message from the "received"
   * emoji to the terminal-stage emoji. Never throws — reaction failures are
   * logged and swallowed so the main reply flow is unaffected.
   */
  private async setReaction(messageId: string, stage: keyof typeof REACT_EMOJI): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    const next = REACT_EMOJI[stage];
    const prev = stage === "received" ? undefined : REACT_EMOJI.received;
    try {
      if (prev && prev !== next) await channel.removeReactionByEmoji(messageId, prev);
    } catch (error) {
      await this.debug(`remove reaction ${prev} failed: ${this.redact(safeError(error))}`);
    }
    try {
      await channel.addReaction(messageId, next);
    } catch (error) {
      await this.debug(`add reaction ${next} failed: ${this.redact(safeError(error))}`);
    }
  }

  /** Clear any bot-added lifecycle reactions on a message. */
  private async clearReactions(messageId: string): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    for (const emoji of REACT_EMOJIS) {
      try { await channel.removeReactionByEmoji(messageId, emoji); } catch { /* ignore */ }
    }
  }

  private rememberBotMessage(messageId: string): void {
    const state = this.state!;
    state.botMessageIds.push(messageId);
    if (state.botMessageIds.length > 500) state.botMessageIds.splice(0, state.botMessageIds.length - 500);
    void this.saveState();
  }

  private async onCardAction(event: CardActionEvent): Promise<void> {
    const state = this.state;
    if (!state || !isAuthorized(state, event.operator.openId)) return;
    const value = event.action.value as { action?: string; key?: string; runId?: string } | undefined;
    if (!value?.action || !value.key) return;
    if (value.action === "thinking") {
      const level = (value as { level?: string }).level;
      if (!level || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) return;
      const conversation = await this.getConversation(value.key);
      conversation.session.setThinkingLevel(level as "off" | "minimal" | "low" | "medium" | "high" | "xhigh");
      await this.channel?.updateCard(event.messageId, choiceCard(
        "Thinking Level",
        `已切换为 \`${level}\``,
        [],
      ));
      return;
    }
    if (value.action === "model") {
      const direction = (value as { direction?: string }).direction === "backward" ? "backward" : "forward";
      const conversation = await this.getConversation(value.key);
      const changed = await conversation.session.cycleModel(direction);
      await this.channel?.updateCard(event.messageId, choiceCard(
        "切换模型",
        changed
          ? `已切换为 \`${changed.model.provider}/${changed.model.id}\``
          : "当前没有其他可切换模型。",
        [],
      ));
      return;
    }
    if (value.action === "resume") {
      const index = Number((value as { index?: number }).index);
      const current = await this.getConversation(value.key);
      const sessions = await SessionManager.list(current.workspace);
      const selected = sessions[index];
      if (!selected) return;
      current.session.dispose();
      const reopened = await this.createConversation(value.key, current.workspace, selected.path);
      this.conversations.set(value.key, reopened);
      this.state!.sessions[value.key] = selected.path;
      await this.saveState();
      await this.channel?.updateCard(event.messageId, choiceCard(
        "恢复 Pi Session",
        `已恢复：\`${selected.name || selected.id}\``,
        [],
      ));
      return;
    }
    if (value.action !== "stop" || !value.runId) return;
    const active = this.activeRuns.get(value.key);
    if (!active || active.runId !== value.runId || active.ownerOpenId !== event.operator.openId) return;
    active.stopped = true;
    await active.session.abort();
  }
}
