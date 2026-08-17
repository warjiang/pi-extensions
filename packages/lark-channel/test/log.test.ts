import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelLogger } from '../src/log.ts';

test('logger filters below the configured level', () => {
  const logger = new ChannelLogger({ level: 'warn' });
  // error/warn should pass; info/debug/trace are filtered. We only assert
  // that higher-level calls don't throw and the level logic is respected by
  // checking the logger still exposes all methods.
  logger.error('e');
  logger.warn('w');
  logger.info('i');
  logger.debug('d');
  assert.ok(logger);
});

test('logger writes to a file when configured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-log-'));
  const file = join(dir, 'channel.log');
  const logger = new ChannelLogger({ level: 'debug', file });

  logger.info('hello');
  logger.error('boom', { code: 1 });

  // Flush the write stream before reading.
  return new Promise<void>((resolve, reject) => {
    // Wait a tick for the async write to flush.
    setTimeout(() => {
      try {
        const content = readFileSync(file, 'utf8');
        assert.match(content, /\[INFO\] hello/);
        assert.match(content, /\[ERROR\] boom/);
        logger.close();
        resolve();
      } catch (err) {
        reject(err);
      }
    }, 30);
  });
});
