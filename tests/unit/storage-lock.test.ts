import { lstat, mkdtemp, open, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendLedger, atomicWrite } from '../../src/storage/index.js';

vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, open: vi.fn(real.open), lstat: vi.fn(real.lstat),
    rename: vi.fn(real.rename), rm: vi.fn(real.rm), readFile: vi.fn(real.readFile) };
});
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const failure = (code: string) => Object.assign(new Error(`Synthetic ${code}`), { code });
let root: string;
let file: string;
let lock: string;
beforeEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(real.open);
  vi.mocked(lstat).mockReset().mockImplementation(real.lstat);
  vi.mocked(rename).mockReset().mockImplementation(real.rename);
  vi.mocked(rm).mockReset().mockImplementation(real.rm);
  vi.mocked(readFile).mockReset().mockImplementation(real.readFile);
  root = await mkdtemp(path.join(tmpdir(), 'quorum-storage-lock-'));
  file = path.join(root, 'ledger.jsonl');
  lock = `${file}.lock`;
});
afterEach(async () => {
  expect(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'quorum-storage-lock-'))).toBe(true);
  await real.rm(root, { recursive: true, force: true });
});
async function staleLock() {
  await writeFile(lock, 'expired-owner');
  await utimes(lock, new Date(0), new Date(0));
}

it('two writers observing the same stale lock retire it once without losing either line', async () => {
  await staleLock();
  let observed = 0;
  let release!: () => void;
  const bothObserved = new Promise<void>(resolve => { release = resolve; });
  let acquired!: () => void;
  const firstAcquired = new Promise<void>(resolve => { acquired = resolve; });
  let inspected!: () => void;
  const secondInspected = new Promise<void>(resolve => { inspected = resolve; });
  let writing = false;
  let removedWhileWriting = false;
  vi.mocked(lstat).mockImplementation(async (...args) => {
    const stat = await real.lstat(...args);
    if (args[0] === lock && observed < 2) {
      const ordinal = ++observed;
      if (observed === 2) release();
      await bothObserved;
      // Delay the second stale observation until the first writer owns a fresh lock.
      if (ordinal === 2) await firstAcquired;
    } else if (args[0] === lock && writing) {
      inspected();
    }
    return stat;
  });
  vi.mocked(readFile).mockImplementation(async (...args) => {
    if (args[0] === file && !writing) {
      writing = true;
      acquired();
      await secondInspected;
    }
    return real.readFile(...args);
  });
  vi.mocked(rm).mockImplementation(async (...args) => {
    if (args[0] === lock && writing && !vi.mocked(rename).mock.calls.some(([, to]) => to === file)) {
      removedWhileWriting = true;
      inspected();
    }
    return real.rm(...args);
  });
  await Promise.all([appendLedger([{ id: 1 }], file, root), appendLedger([{ id: 2 }], file, root)]);
  expect(observed).toBe(2);
  expect(removedWhileWriting).toBe(false);
  expect((await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line).id).sort()).toEqual([1, 2]);
  expect(vi.mocked(rename).mock.calls.filter(([from]) => from === lock)).toHaveLength(1);
  expect(await readdir(root)).toEqual(['ledger.jsonl']);
});

it('recovers EPERM on the first two opens and the first stale rename, then writes atomically', async () => {
  await staleLock();
  vi.mocked(open).mockRejectedValueOnce(failure('EPERM')).mockRejectedValueOnce(failure('EPERM'));
  vi.mocked(rename).mockRejectedValueOnce(failure('EPERM'));
  await appendLedger([{ id: 1 }], file, root);
  expect(await readFile(file, 'utf8')).toBe('{"id":1}\n');
  expect(vi.mocked(rename).mock.calls.some(([from]) => from === lock)).toBe(true);
  vi.mocked(rename).mockRejectedValueOnce(failure('EPERM'));
  await atomicWrite(file, 'replacement', root);
  expect(await readFile(file, 'utf8')).toBe('replacement');
  expect(await readdir(root)).toEqual(['ledger.jsonl']);
});

it.each(['EPERM', 'EACCES', 'EBUSY'])('retries %s while inspecting a stale lock', async code => {
  await staleLock();
  let injected = false;
  vi.mocked(lstat).mockImplementation(async (...args) => {
    if (args[0] === lock && !injected) { injected = true; throw failure(code); }
    return real.lstat(...args);
  });
  await appendLedger([{ id: 1 }], file, root);
  expect(injected).toBe(true);
  expect(await readdir(root)).toEqual(['ledger.jsonl']);
});

it('retries EBUSY removing the owned lock on release', async () => {
  let injected = false;
  vi.mocked(rm).mockImplementation(async (...args) => {
    if (args[0] === lock && !injected) { injected = true; throw failure('EBUSY'); }
    return real.rm(...args);
  });
  await appendLedger([{ id: 1 }], file, root);
  expect(injected).toBe(true);
  expect(await readdir(root)).toEqual(['ledger.jsonl']);
});

it.each(['EPERM', 'EACCES', 'EBUSY'])('retries %s removing the retired stale lock', async code => {
  await staleLock();
  let injected = false;
  vi.mocked(rm).mockImplementation(async (...args) => {
    // On old code the shared lock is deleted directly; inject there as well.
    if ((args[0] === lock || String(args[0]).includes('.stale-')) && !injected) {
      injected = true;
      throw failure(code);
    }
    return real.rm(...args);
  });
  await appendLedger([{ id: 1 }], file, root);
  expect(injected).toBe(true);
  expect(await readdir(root)).toEqual(['ledger.jsonl']);
});

it('attempts release even when close fails', async () => {
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await real.open(...args);
    if (args[0] === lock) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw failure('EIO'); };
    }
    return handle;
  });
  await expect(appendLedger([{ id: 1 }], file, root)).rejects.toThrow('Synthetic EIO');
  expect(await readdir(root)).toEqual(['ledger.jsonl']);
});

it('writes a unique owner token and never releases a different owner', async () => {
  const tokens: string[] = [];
  vi.mocked(readFile).mockImplementation(async (...args) => {
    if (args[0] === file) {
      tokens.push(await real.readFile(lock, 'utf8'));
      await real.writeFile(lock, 'replacement-owner');
    }
    return real.readFile(...args);
  });
  await appendLedger([{ id: 1 }], file, root);
  expect(await real.readFile(lock, 'utf8')).toBe('replacement-owner');
  expect(tokens[0]).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  expect(vi.mocked(rm).mock.calls.some(([target]) => target === lock)).toBe(false);
});

it('a reclaim guard left by a crash does not block the ledger forever', async () => {
  await staleLock();
  const guard = `${lock}.reclaim`;
  await real.mkdir(guard);
  await utimes(guard, new Date(0), new Date(0));
  await appendLedger([{ id: 'after-crash' }], file, root);
  expect((await readFile(file, 'utf8')).trim()).toBe('{"id":"after-crash"}');
  await expect(real.lstat(guard)).rejects.toThrow();
});

it('a fresh reclaim guard is left alone (another writer is reclaiming right now)', async () => {
  await staleLock();
  const guard = `${lock}.reclaim`;
  await real.mkdir(guard);
  setTimeout(() => { void real.rm(guard, { recursive: true, force: true }); }, 200);
  await appendLedger([{ id: 'waited' }], file, root);
  expect((await readFile(file, 'utf8')).trim()).toBe('{"id":"waited"}');
});
