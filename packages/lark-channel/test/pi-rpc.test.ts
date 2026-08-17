import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiSession } from '../src/pi-rpc.ts';

/**
 * Drive a fake `pi` binary so we can test the session's protocol handling
 * without a real LLM. The fake reads JSONL on stdin and writes JSONL on stdout.
 */
/**
 * Write a fake `pi` as an executable shell wrapper that ignores its CLI args
 * (`--mode rpc ...`) and runs a node RPC script that talks JSONL on stdio.
 */
function fakePiBin(): string {
  const dir = tmpdir();
  const id = Math.random().toString(36).slice(2);
  const script = join(dir, `fake-pi-${id}.cjs`);
  const wrapper = join(dir, `fake-pi-${id}.sh`);
  writeFileSync(
    script,
    [
      "const rl = require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity });",
      'rl.on("line", (line) => {',
      '  const req = JSON.parse(line);',
      '  if (req.type === "prompt") {',
      '    process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: true }) + "\\n");',
      '    process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");',
      '    process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi " } }) + "\\n");',
      '    process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "there" } }) + "\\n");',
      '    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");',
      '  } else if (req.type === "new_session") {',
      '    process.stdout.write(JSON.stringify({ type: "response", command: "new_session", success: true, data: { cancelled: false } }) + "\\n");',
      '  }',
      '});',
      'process.stdin.on("end", () => process.exit(0));',
    ].join('\n'),
  );
  writeFileSync(wrapper, `#!/bin/sh\nexec node ${JSON.stringify(script)}\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

test('prompt streams text deltas and resolves on agent_settled', async () => {
  const session = new PiSession({ bin: fakePiBin() });

  const chunks: string[] = [];
  const text = await session.prompt('hello', (c) => {
    chunks.push(c);
  });
  assert.equal(chunks.join(''), 'hi there');
  assert.equal(text, 'hi there');
  await session.close();
});

test('new_session resolves via the response event', async () => {
  const session = new PiSession({ bin: fakePiBin() });

  // Prime the session with a prompt first.
  await session.prompt('hello');
  const result = await session.newSession();
  assert.equal(result, '');
  await session.close();
});

test('prompts are serialized (only one in flight at a time)', async () => {
  const session = new PiSession({ bin: fakePiBin() });

  const [a, b] = await Promise.all([session.prompt('a'), session.prompt('b')]);
  assert.equal(a, 'hi there');
  assert.equal(b, 'hi there');
  await session.close();
});
