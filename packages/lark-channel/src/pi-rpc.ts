/**
 * Persistent Pi RPC session.
 *
 * One long-lived `pi --mode rpc` subprocess is kept for the whole channel, so
 * every Feishu message flows into the **same** session by default. Sending
 * `/new` calls `newSession()` to start a fresh one.
 *
 * Pi RPC processes one turn at a time, so operations (prompt / new_session)
 * are serialized through an internal queue. A turn is considered finished when
 * the `agent_settled` event arrives (the full session-level run settled —
 * including tool calls, retries, and queued continuations).
 *
 * Note: we split the JSONL stream on `\n` only, not `readline`, which is not
 * protocol-compliant for RPC mode (it also splits on U+2028/U+2029).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { AnyLogger } from './log.ts';

export interface PiSessionOptions {
  /** Pi binary. Defaults to `PI_BIN` env or `pi`. */
  bin?: string;
  /** LLM provider to pass via `--provider`. */
  provider?: string;
  /** Model pattern to pass via `--model`. */
  model?: string;
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Extra CLI args appended after the model options. */
  extraArgs?: string[];
  /** Logger for RPC lifecycle events. */
  logger?: AnyLogger;
}

interface RpcEvent {
  type?: string;
  command?: string;
  success?: boolean;
  message?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
}

type TurnResolver = {
  op: 'prompt' | 'new_session';
  onChunk?: (chunk: string) => void | Promise<void>;
  acc: string[];
  resolve: (value: string) => void;
  reject: (err: Error) => void;
};

export class PiSession {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private buffer = '';
  private current: TurnResolver | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private exitReason: Error | null = null;
  private readonly logger: AnyLogger;

  constructor(opts: PiSessionOptions = {}) {
    this.logger = opts.logger ?? (console as unknown as AnyLogger);
    const bin = opts.bin ?? process.env.PI_BIN ?? 'pi';
    const args = ['--mode', 'rpc'];
    if (opts.provider) args.push('--provider', opts.provider);
    if (opts.model) args.push('--model', opts.model);
    args.push(...(opts.extraArgs ?? []));

    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: opts.cwd,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.on('error', (err) => {
      this.logger.error('[pi] spawn error', err);
      this.failAll(err);
    });
    child.on('exit', (code, signal) => {
      this.logger.warn('[pi] exited', { code, signal });
      this.failAll(
        new Error(
          `pi exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}). Is \`pi\` installed on PATH?`,
        ),
      );
    });
  }

  /**
   * Run a prompt in the current (shared) session, streaming text deltas via
   * `onChunk`. Resolves with the full assistant text when the turn settles.
   */
  prompt(message: string, onChunk?: (chunk: string) => void | Promise<void>): Promise<string> {
    this.logger.info('[pi] prompt', { chars: message.length });
    return this.enqueue('prompt', onChunk, () => {
      this.send({ type: 'prompt', message });
    });
  }

  /** Start a fresh session. Resolves when the switch completes. */
  newSession(): Promise<string> {
    this.logger.info('[pi] new_session');
    return this.enqueue('new_session', undefined, () => {
      this.send({ type: 'new_session' });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.child.killed) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      this.child.kill('SIGTERM');
    }
  }

  // ─── internals ─────────────────────────────────────────

  private send(payload: object): void {
    if (this.closed || this.child.stdin.destroyed) {
      this.failAll(new Error('pi session is closed'));
      return;
    }
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  /** Serialize operations so only one turn is ever in flight. */
  private enqueue(
    op: TurnResolver['op'],
    onChunk: TurnResolver['onChunk'],
    run: () => void,
  ): Promise<string> {
    const task = this.queue.then(
      () =>
        new Promise<string>((resolve, reject) => {
          if (this.exitReason) return reject(this.exitReason);
          this.current = { op, onChunk, acc: [], resolve, reject };
          run();
        }),
    );
    // Keep the queue alive even if this task fails.
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private onData(raw: string): void {
    this.buffer += raw;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;

      let evt: RpcEvent;
      try {
        evt = JSON.parse(line) as RpcEvent;
      } catch {
        continue; // non-JSON diagnostic line — ignore
      }
      this.handleEvent(evt);
    }
  }

  private handleEvent(evt: RpcEvent): void {
    const cur = this.current;
    if (!cur) return;

    switch (evt.type) {
      case 'message_update': {
        const d = evt.assistantMessageEvent;
        if (cur.op === 'prompt' && d?.type === 'text_delta' && d.delta) {
          cur.acc.push(d.delta);
          void cur.onChunk?.(d.delta);
        }
        break;
      }
      // Full turn done (tool calls, retries, queued continuations all settled).
      case 'agent_settled': {
        this.finish(cur, '');
        break;
      }
      case 'response': {
        if (evt.success === false) {
          this.fail(cur, new Error(`pi rejected ${evt.command ?? 'command'}: ${evt.message ?? ''}`));
        } else if (cur.op === 'new_session' && evt.command === 'new_session') {
          // Acknowledged. Nothing else to await for a session switch.
          this.finish(cur, '');
        }
        break;
      }
      default:
        break;
    }
  }

  private finish(cur: TurnResolver, value: string): void {
    if (this.current !== cur) return;
    this.current = null;
    cur.resolve(value || cur.acc.join(''));
    this.logger.debug('[pi] turn settled', { chars: (value || cur.acc.join('')).length });
  }

  private fail(cur: TurnResolver, err: Error): void {
    if (this.current !== cur) return;
    this.current = null;
    cur.reject(err);
  }

  private failAll(err: Error): void {
    this.exitReason ??= err;
    const cur = this.current;
    this.current = null;
    if (cur) cur.reject(err);
  }
}

/** Convenience factory. */
export function createPiSession(opts?: PiSessionOptions): PiSession {
  return new PiSession(opts);
}
