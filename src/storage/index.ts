import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { QuotaSnapshot } from '../catalog/groups.js';

// Windows reports a file that is being deleted, or held open by another process (an antivirus, the
// indexer), as EPERM, EACCES or EBUSY for a short while; those are retried instead of losing the write.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function removeWithRetry(file: string, deadline: number): Promise<void> {
  for (;;) {
    try { await rm(file, { force: true }); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return;
      if (!TRANSIENT.has(code) || Date.now() >= deadline) throw error;
      await sleep(10);
    }
  }
}

async function retireStaleLock(file: string, deadline: number): Promise<void> {
  if (Date.now() - (await lstat(file)).mtimeMs <= 10 * 60 * 1000) return;
  // Serialize reclaimers, then inspect again: a delayed rename must not move a
  // fresh owner's lock after another reclaimer has already retired the old one.
  const guard = `${file}.reclaim`;
  try { await mkdir(guard); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A reclaim takes milliseconds; a guard older than a minute was left by a crash. Retire it by
    // renaming it to a unique name (only one process can win that rename), so the stale lock can
    // still be broken instead of blocking the ledger forever.
    const age = await lstat(guard).then(stat => Date.now() - stat.mtimeMs, () => 0);
    if (age <= 60 * 1000) return;
    const orphan = `${guard}.orphan-${randomUUID()}`;
    try { await rename(guard, orphan); } catch { return; }
    await rm(orphan, { recursive: true, force: true }).catch(() => undefined);
    return retireStaleLock(file, deadline);
  }
  try {
    if (Date.now() - (await lstat(file)).mtimeMs <= 10 * 60 * 1000) return;
    const stale = `${file}.stale-${randomUUID()}`;
    await rename(file, stale);
    await removeWithRetry(stale, deadline);
  } finally {
    // The guard is an empty directory; rm needs recursive for directories.
    for (;;) {
      try { await rm(guard, { recursive: true, force: true }); break; }
      catch (error) {
        if (!TRANSIENT.has((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw error;
        await sleep(10);
      }
    }
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (!TRANSIENT.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= 20) throw error;
      await sleep(Math.min(200, 10 * 2 ** attempt));
    }
  }
}

export async function atomicWrite(file: string, text: string, repoRoot = process.cwd()): Promise<void> {
  await assertRealParents(file, repoRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { flag: 'wx' }); await renameWithRetry(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function assertRealParents(file: string, repoRoot: string): Promise<void> {
  const root = path.resolve(repoRoot);
  let current = path.dirname(path.resolve(file));
  while (current !== root) {
    const relative = path.relative(root, current);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Storage parent must not be a symlink or junction: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

// Exported so tests can shorten the waits and drive the clock.
export const LEDGER_LOCK = { idleMs: 10_000, maxMs: 120_000, now: () => Date.now() };

export async function appendLedger(entries: readonly unknown[], file: string, repoRoot = process.cwd(), maxBytes?: number): Promise<void> {
  if (!entries.length) return;
  await assertRealParents(file, repoRoot);
  await mkdir(path.dirname(file), { recursive: true });
  let lock;
  const lockPath = `${file}.lock`;
  const owner = randomUUID();
  // A busy queue is not a stuck lock: wait while the holder keeps changing, and give up only
  // after the same holder has kept it for idleMs (or after maxMs in all). Stale locks are reclaimed.
  const { now } = LEDGER_LOCK;
  const start = now();
  let holder: string | undefined; let since = start;
  const gaveUp = (cause: unknown) => Object.assign(new Error(
    `Ledger lock ${lockPath} is still held after ${Math.round((now() - start) / 1000)} s; nothing was written.`), { code: 'ELEDGERLOCK', cause });
  for (let attempt = 0; !lock; attempt++) {
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code !== 'EEXIST' && !TRANSIENT.has(code)) throw error;
      const current = await readFile(lockPath, 'utf8').catch(() => undefined);
      // An unreadable lock (being deleted on Windows) tells nothing about progress.
      if (current !== undefined && current !== holder) { holder = current; since = now(); }
      if (now() - since > LEDGER_LOCK.idleMs || now() - start > LEDGER_LOCK.maxMs) throw gaveUp(error);
      // Reclaiming a stale lock gets the idle allowance, not the whole absolute budget.
      const reclaimDeadline = Date.now() + LEDGER_LOCK.idleMs;
      try {
        await retireStaleLock(lockPath, reclaimDeadline);
      } catch (statError) {
        const statCode = (statError as NodeJS.ErrnoException).code ?? '';
        if (statCode !== 'ENOENT' && !TRANSIENT.has(statCode)) throw statError;
        if (Date.now() >= reclaimDeadline) throw gaveUp(statError);
      }
      await sleep(Math.min(100, 5 * 2 ** Math.min(attempt, 5)) + Math.random() * 10);
    }
  }
  try {
    await lock.writeFile(owner, 'utf8');
    let previous = '';
    try { previous = await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let text = previous + entries.map(entry => JSON.stringify(entry) + '\n').join('');
    if (maxBytes !== undefined && Buffer.byteLength(text) > maxBytes) {
      // Retain whole newest records, bounded by half the cap in UTF-8 bytes.
      const bytes = Buffer.from(text);
      const boundary = bytes.indexOf(10, bytes.length - Math.floor(maxBytes / 2) - 1);
      text = boundary < 0 ? '' : bytes.subarray(boundary + 1).toString('utf8');
    }
    await atomicWrite(file, text, repoRoot);
  } finally {
    let cleanupError: unknown;
    try { await lock.close(); } catch (error) { cleanupError = error; }
    try {
      const releaseDeadline = Date.now() + 10_000;
      for (;;) {
        try {
          // Recheck ownership on every retry, including after a transient rm.
          if (await readFile(lockPath, 'utf8') === owner) await rm(lockPath, { force: true });
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? '';
          if (code === 'ENOENT') break;
          if (!TRANSIENT.has(code) || Date.now() >= releaseDeadline) throw error;
          await sleep(10);
        }
      }
    } catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
  }
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

export function diskCache(root: string, warn: (message: string) => void, repoRoot = process.cwd(), home = homedir()) {
  const pending = new Map<string, { rawOutput: string; model: string }>();
  const file = (key: string) => path.join(root, 'v1', key.slice(0, 2), `${key}.json`);
  let userKey: Promise<Buffer | undefined> | undefined;
  const secret = () => userKey ??= (async () => {
    const keyFile = path.join(home, '.quorum', 'cache.key');
    try {
      await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      const readKey = () => readFile(keyFile).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return Buffer.alloc(0);
      });
      let key = await readKey();
      if (key.length === 32) return key;
      // Recheck under a cross-process lock: a late repair must never replace a valid key
      // already returned to another caller. Atomic rename also avoids partial creation.
      const lockPath = `${keyFile}.lock`;
      const deadline = Date.now() + 10_000;
      let lock;
      while (!lock) {
        try { lock = await open(lockPath, 'wx', 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
          try { await retireStaleLock(lockPath, deadline); }
          catch (staleError) { if ((staleError as NodeJS.ErrnoException).code !== 'ENOENT') throw staleError; }
          await sleep(10);
        }
      }
      try {
        key = await readKey();
        if (key.length !== 32) {
          const temporary = `${keyFile}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, randomBytes(32), { mode: 0o600, flag: 'wx' });
            await renameWithRetry(temporary, keyFile);
          } finally { await rm(temporary, { force: true }); }
        }
        key = await readFile(keyFile);
      } finally {
        try { await lock.close(); } finally { await removeWithRetry(lockPath, Date.now() + 10_000); }
      }
      if (key.length !== 32) throw new Error('invalid cache key');
      return key;
    } catch {
      // Never expose the secret or filesystem error details.
      warn('Cache disabled: user authentication key could not be created or read.');
      return undefined;
    }
  })();
  const mac = (secret: Buffer, key: string, model: string, rawOutput: string) =>
    createHmac('sha256', secret).update(JSON.stringify([1, key, model, rawOutput])).digest();
  return {
    async read(key: string): Promise<string | undefined> {
      const authentication = await secret();
      if (!authentication) return undefined;
      try {
        const value = JSON.parse(await readFile(file(key), 'utf8')) as Record<string, unknown>;
        if (value.version === 1 && value.key === key && typeof value.model === 'string' && typeof value.rawOutput === 'string'
          && typeof value.mac === 'string' && /^[a-f0-9]{64}$/.test(value.mac)
          && timingSafeEqual(Buffer.from(value.mac, 'hex'), mac(authentication, key, value.model, value.rawOutput))) return value.rawOutput;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`Cache read failed: ${String(error)}`); }
      return undefined;
    },
    stage(key: string, rawOutput: string, model: string) { pending.set(key, { rawOutput, model }); },
    async flush() {
      const authentication = await secret();
      if (!authentication) { pending.clear(); return; }
      for (const [key, value] of pending) {
        try { await atomicWrite(file(key), JSON.stringify({ version: 1, key, createdAt: new Date().toISOString(), ...value,
          mac: mac(authentication, key, value.model, value.rawOutput).toString('hex') }), repoRoot); }
        catch (error) { warn(`Cache write failed: ${String(error)}`); }
      }
    },
  };
}
