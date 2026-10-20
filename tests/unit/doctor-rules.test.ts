import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runDoctor } from '../../src/doctor/index.js';
import type { CommandRunner } from '../../src/types/index.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-doctor-rules-')); });
afterEach(async () => {
  if (!path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'quorum-doctor-rules-'))) throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
});
const runner: CommandRunner = async () => ({ stdout: '', stderr: '', exitCode: 1 });
const checks = async () => (await runDoctor(undefined, { repoRoot: root, homedir: root, env: { PATH: '' }, runner,
  fetch: async () => { throw new Error('Network forbidden'); } })).filter(check => check.id === 'rules');

it('does not add a rules check when the optional rules file is missing', async () => {
  expect(await checks()).toEqual([]);
});

it('passes with the count for valid rules including an empty list', async () => {
  for (const rules of [[], [{ id: 'no-foo', pattern: 'foo', message: 'Avoid foo', severity: 'error' }]]) {
    await writeFile(path.join(root, 'quorum.rules.json'), JSON.stringify({ rules }));
    expect(await checks()).toEqual([{ id: 'rules', status: 'PASS', message: `quorum.rules.json is valid (${rules.length} rules).` }]);
  }
});

it('warns with the first validation problem and names unknown keys', async () => {
  await writeFile(path.join(root, 'quorum.rules.json'), JSON.stringify({ unknown: true, rules: null }));
  expect(await checks()).toEqual([{ id: 'rules', status: 'WARN', message: 'quorum.rules.json: unknown key "unknown" in rules file' }]);
});

it('warns for malformed JSON', async () => {
  await writeFile(path.join(root, 'quorum.rules.json'), '{');
  expect(await checks()).toEqual([{ id: 'rules', status: 'WARN', message: 'quorum.rules.json: invalid JSON' }]);
});
