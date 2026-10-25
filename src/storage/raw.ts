import path from 'node:path';
import { atomicWrite } from './index.js';

/** One writer per run, independent of the review cache. */
export function rawOutputWriter(root: string, runId: string): (raw: string) => Promise<string | undefined> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(runId)) throw new Error('Invalid raw output run ID');
  let count = 0;
  return async raw => {
    if (count >= 20) return undefined;
    const relative = `.quorum/raw/${runId}/${++count}.txt`;
    // Trim at a UTF-8 boundary so decoding cannot expand a partial character.
    const bytes = Buffer.from(raw.slice(0, 256 * 1024));
    let end = Math.min(bytes.length, 256 * 1024);
    if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    await atomicWrite(path.resolve(root, relative), bytes.subarray(0, end).toString('utf8'), root);
    return relative;
  };
}
