/**
 * Feishu/Lark channel for Pi, built on @larksuite/channel.
 *
 * - Receives messages via WebSocket (auto-reconnect, policy/safety included).
 * - Replies with a **schema-2.0 streaming markdown card** (typewriter effect).
 *   The SDK's markdown stream never emits the legacy `tag: action` element, so
 *   it does not hit `ErrCode 200861 / unsupported tag action`.
 * - A single long-lived `pi --mode rpc` session serves **all** messages by
 *   default (shared conversation). Sending `/new` starts a fresh session.
 *
 * Env vars:
 *   LARK_APP_ID / LARK_APP_SECRET   — Feishu app credentials (required)
 *   LARK_DOMAIN                     — optional (feishu.cn default)
 *   PI_BIN                          — pi binary (default `pi`)
 *   PI_PROVIDER / PI_MODEL          — optional provider/model for pi
 *   PI_CWD                          — working dir for the pi subprocess
 */

import { createLarkChannel, type LarkChannel } from '@larksuite/channel';
import { PiSession } from './pi-rpc.ts';
import { loggerFromEnv, type AnyLogger } from './log.ts';

export interface ChannelConfig {
  appId: string;
  appSecret: string;
  domain?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  /** Logger for channel/prompt/card events. */
  logger?: AnyLogger;
  /** Return false to ignore a message (e.g. require @-mention in groups). */
  shouldReply?: (msg: { chatType: string; mentionedBot: boolean; content: string }) => boolean;
}

/** Build the channel from environment variables. */
export function configFromEnv(): ChannelConfig {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('LARK_APP_ID and LARK_APP_SECRET are required');
  }
  return {
    appId,
    appSecret,
    domain: process.env.LARK_DOMAIN,
    provider: process.env.PI_PROVIDER,
    model: process.env.PI_MODEL,
    cwd: process.env.PI_CWD,
  };
}
/** Sent as a message to start a fresh Pi session. */
export const NEW_SESSION_COMMAND = '/new';

export interface ChannelHandle {
  channel: LarkChannel;
  session: PiSession;
  logger: AnyLogger;
  close(): Promise<void>;
}

export async function createChannel(cfg: ChannelConfig): Promise<ChannelHandle> {
  const logger = cfg.logger ?? loggerFromEnv();
  const channel = createLarkChannel({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain,
    logger,
  });

  // One persistent Pi session shared by every message.
  const session = new PiSession({
    bin: process.env.PI_BIN,
    provider: cfg.provider,
    model: cfg.model,
    cwd: cfg.cwd,
    logger,
  });

  channel.on('message', async (msg) => {
    // Ignore messages posted by bots to avoid echo loops.
    if (msg.senderIsBot) return;

    const shouldReply = cfg.shouldReply ?? defaultShouldReply;
    if (!shouldReply(msg)) return;

    const text = msg.content.trim();
    logger.info('[feishu] message', {
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderId: msg.senderId,
      text,
    });

    // `/new` resets the shared Pi session instead of prompting.
    if (text === NEW_SESSION_COMMAND) {
      try {
        await session.newSession();
        await channel.reply(msg, { markdown: '已开启新会话 ✨' });
        logger.info('[feishu] new session started');
      } catch (err) {
        logger.error('[feishu] newSession failed', err);
        await safeReply(channel, msg, '新会话开启失败');
      }
      return;
    }

    try {
      const result = await channel.stream(
        msg.chatId,
        {
          markdown: async (c) => {
            // Show a placeholder immediately, then stream pi's text deltas.
            await c.append('思考中…\n\n');
            await session.prompt(text, async (chunk) => {
              await c.append(chunk);
            });
          },
        },
        { replyTo: msg.messageId },
      );
      logger.info('[feishu] replied', { messageId: result.messageId });
    } catch (err) {
      logger.error('[feishu] reply failed', err);
      await safeReply(channel, msg, '回复失败，请稍后再试');
    }
  });

  return {
    channel,
    session,
    logger,
    close: async () => {
      await session.close();
      await channel.disconnect();
      if ('close' in logger && typeof (logger as { close: () => void }).close === 'function') {
        (logger as { close: () => void }).close();
      }
    },
  };
}

/** In groups only reply when the bot was @-mentioned; always reply in p2p. */
function defaultShouldReply(msg: { chatType: string; mentionedBot: boolean }): boolean {
  if (msg.chatType === 'p2p') return true;
  return msg.mentionedBot;
}

async function safeReply(
  channel: LarkChannel,
  msg: { chatId: string; messageId: string },
  markdown: string,
): Promise<void> {
  try {
    await channel.reply(msg, { markdown });
  } catch {
    /* ignore */
  }
}

export async function start(cfg?: ChannelConfig): Promise<ChannelHandle> {
  const handle = await createChannel(cfg ?? configFromEnv());
  await handle.channel.connect();
  handle.logger.info('[feishu] connected');
  return handle;
}
