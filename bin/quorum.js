#!/usr/bin/env node
import { existsSync } from 'node:fs';

const entry = new URL('../dist/cli/index.js', import.meta.url);

if (!existsSync(entry)) {
  process.stderr.write('quorum: dist/ not found. Run "pnpm build" first.\n');
  process.exit(2);
}

try {
  const { main } = await import(entry.href);
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Exit 1 means "BLOCKERs found", so a crash must never use it.
  process.stderr.write(`quorum: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
