import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as host from '../../src/runtime/run.js';
import { validateConfig } from '../../src/config/schema.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const data = Buffer.from([255, 216, 255, 1]);
const config = validateConfig({ checks: [], runtime: { flows: [{ name: 'Home._ Page', steps: [{ goto: '/' }] }] } }).runtime!;
const shot = { flow: 'Home._ Page', step: 0, mime: 'image/jpeg' as const, bytes: 4, sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') };
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), 'quorum-shots-')); roots.push(value); return value; }
it('stores and retains exact bytes under the report run id, side and validated slug', async () => {
  const directory = await root(); const gitRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  const result = await host.storeRuntimeShots([shot], config, { root: directory, runId: 'qrm-test', side: 'base', gitRunner });
  expect(result.notes).toEqual([]);
  expect(result.shots).toEqual([{ flow: shot.flow, step: 0, mime: shot.mime, bytes: 4, sha256: shot.sha256, path: '.quorum/runtime-shots/qrm-test/base/01-home---page-0.jpg' }]);
  expect(await readFile(path.join(directory, result.shots[0]!.path))).toEqual(data);
  expect(gitRunner.mock.calls[0]).toEqual([expect.any(String), expect.arrayContaining(['check-ignore', '--quiet', '--', '.quorum/']), expect.objectContaining({ cwd: directory })]);
});
it('warns and skips non-ignored storage without creating files', async () => {
  const directory = await root(); const warn = vi.fn();
  const result = await host.storeRuntimeShots([shot], config, { root: directory, runId: 'qrm-test', side: 'head', warn,
    gitRunner: async () => ({ exitCode: 1, stdout: '', stderr: '' }) });
  expect(result).toEqual({ shots: [], notes: ['screenshots not stored: .quorum/ is not git-ignored'] });
  expect(warn).toHaveBeenCalledWith(result.notes[0]); expect(await readdir(directory)).toEqual([]);
});
it.each(['.quorum', '.quorum/runtime-shots', '.quorum/runtime-shots/qrm-test', '.quorum/runtime-shots/qrm-test/head'])('refuses symlinked parent %s', async parent => {
  const directory = await root(); const outside = await root(); const target = path.join(directory, parent);
  await mkdir(path.dirname(target), { recursive: true }); await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(host.storeRuntimeShots([shot], config, { root: directory, runId: 'qrm-test', side: 'head',
    gitRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) })).rejects.toThrow();
  expect(await readdir(outside)).toEqual([]);
});
it('refuses slug collisions and path traversal run ids before storage', async () => {
  const directory = await root(); const options = { root: directory, runId: '../escape', side: 'base' as const,
    gitRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) };
  await expect(host.storeRuntimeShots([shot], config, options)).rejects.toThrow();
  await expect(host.storeRuntimeShots([shot], { ...config, flows: [{ name: 'a.b', steps: [{ goto: '/' }] }, { name: 'a-b', steps: [{ goto: '/' }] }] }, { ...options, runId: 'qrm-test' })).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});
