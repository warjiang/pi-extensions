/**
 * Small logger for the Feishu channel.
 *
 * Controls:
 *   LARK_CHANNEL_LOG          log level: trace | debug | info | warn | error (default `info`)
 *   LARK_CHANNEL_LOG_FILE     optional file path to append logs to
 *
 * Implements the `Logger` shape expected by @larksuiteoapi/node-sdk, so the
 * same instance can be handed to the channel SDK to get its internal logs too.
 */

import { createWriteStream, type WriteStream } from 'node:fs';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { trace: 5, debug: 4, info: 3, warn: 2, error: 1 };

function format(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export class ChannelLogger {
  private readonly threshold: number;
  private file: WriteStream | null = null;

  constructor(opts: { level?: LogLevel; file?: string } = {}) {
    this.threshold = LEVEL_RANK[opts.level ?? 'info'] ?? LEVEL_RANK.info;
    if (opts.file) {
      this.file = createWriteStream(opts.file, { flags: 'a' });
    }
  }

  private emit(level: LogLevel, args: unknown[]): void {
    if (LEVEL_RANK[level] > this.threshold) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${args.map(format).join(' ')}`;
    if (this.file) {
      this.file.write(line + '\n');
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  error(...msg: unknown[]): void | Promise<void> {
    this.emit('error', msg);
  }
  warn(...msg: unknown[]): void | Promise<void> {
    this.emit('warn', msg);
  }
  info(...msg: unknown[]): void | Promise<void> {
    this.emit('info', msg);
  }
  debug(...msg: unknown[]): void | Promise<void> {
    this.emit('debug', msg);
  }
  trace(...msg: unknown[]): void | Promise<void> {
    this.emit('trace', msg);
  }

  close(): void {
    this.file?.end();
    this.file = null;
  }
}

export type AnyLogger = Pick<ChannelLogger, 'error' | 'warn' | 'info' | 'debug' | 'trace'>;

/** Build a logger from environment variables. */
export function loggerFromEnv(): ChannelLogger {
  const raw = (process.env.LARK_CHANNEL_LOG ?? 'info').toLowerCase() as LogLevel;
  const level: LogLevel = LEVEL_RANK[raw] !== undefined ? raw : 'info';
  return new ChannelLogger({
    level,
    file: process.env.LARK_CHANNEL_LOG_FILE || undefined,
  });
}
