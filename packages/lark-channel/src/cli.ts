#!/usr/bin/env node
/** CLI entry: start the Feishu/Lark channel for Pi. */

import { start } from './index.ts';

async function main() {
  const handle = await start();
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[lark-channel] fatal:', err);
  process.exit(1);
});
