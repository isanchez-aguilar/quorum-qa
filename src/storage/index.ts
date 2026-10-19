import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { QuotaSnapshot } from '../catalog/groups.js';

export async function atomicWrite(file: string, text: string): Promise<void> {
  await assertRealParents(file);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function assertRealParents(file: string): Promise<void> {
  let current = path.dirname(path.resolve(file));
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Storage parent must not be a symlink or junction: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function appendLedger(entries: readonly unknown[], file: string): Promise<void> {
  if (!entries.length) return;
  await assertRealParents(file);
  await mkdir(path.dirname(file), { recursive: true });
  let lock;
  for (let attempt = 0; !lock; attempt++) {
    try { lock = await open(`${file}.lock`, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    let previous = '';
    try { previous = await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await atomicWrite(file, previous + entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  } finally { await lock.close(); await rm(`${file}.lock`, { force: true }); }
}

export async function readQuota(file: string): Promise<QuotaSnapshot> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, reading]) => reading && typeof reading === 'object'
      && (reading.remainingPercent === 'unknown' || typeof reading.remainingPercent === 'number')
      && typeof reading.timestamp === 'string'));
  } catch { return {}; }
}

export interface ReviewCache {
  read(key: string): Promise<string | undefined>;
  stage(key: string, rawOutput: string, model: string): void;
}

export function cacheKey(payload: string, prompt: string, ref: string): string {
  return createHash('sha256').update(JSON.stringify([payload, prompt, ref])).digest('hex');
}

export function diskCache(root: string, warn: (message: string) => void) {
  const pending = new Map<string, { rawOutput: string; model: string }>();
  const file = (key: string) => path.join(root, 'v1', key.slice(0, 2), `${key}.json`);
  return {
    async read(key: string): Promise<string | undefined> {
      try {
        const value = JSON.parse(await readFile(file(key), 'utf8')) as Record<string, unknown>;
        if (value.version === 1 && value.key === key && typeof value.rawOutput === 'string') return value.rawOutput;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`Cache read failed: ${String(error)}`); }
      return undefined;
    },
    stage(key: string, rawOutput: string, model: string) { pending.set(key, { rawOutput, model }); },
    async flush() {
      for (const [key, value] of pending) {
        try { await atomicWrite(file(key), JSON.stringify({ version: 1, key, createdAt: new Date().toISOString(), ...value })); }
        catch (error) { warn(`Cache write failed: ${String(error)}`); }
      }
    },
  };
}
