import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checksRunTests, hasTestScript } from '../../src/checks/test-coverage.js';
import { runDoctor } from '../../src/doctor/index.js';
import { validateConfig } from '../../src/config/schema.js';
import type { CommandRunner } from '../../src/types/index.js';

describe('checksRunTests', () => {
  it('sees a test script or runner in any check', () => {
    expect(checksRunTests([['pnpm', 'run', 'test']])).toBe(true);
    expect(checksRunTests([['pnpm', 'turbo', 'run', 'test', '--filter=...[origin/dev]']])).toBe(true);
    expect(checksRunTests([['npx', 'vitest', 'run']])).toBe(true);
    expect(checksRunTests([['node_modules/.bin/jest.cmd']])).toBe(true);
    expect(checksRunTests([['go', 'test', './...']])).toBe(true);
    expect(checksRunTests([['cargo', 'test']])).toBe(true);
  });

  it('does not count typecheck, lint or a narrower script suite as the tests', () => {
    // The Rachi config that let a red web suite through: no unit tests at all.
    expect(checksRunTests([['pnpm', 'run', 'typecheck'], ['pnpm', 'run', 'lint'], ['pnpm', 'test:scripts']])).toBe(false);
    expect(checksRunTests([['go', 'vet']])).toBe(false);
    expect(checksRunTests([])).toBe(false);
  });
});

describe('the untested-checks warning', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-checks-tests-')); });
  afterEach(async () => {
    if (!path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'quorum-checks-tests-'))) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const runner: CommandRunner = async () => ({ stdout: '', stderr: '', exitCode: 1 });
  const doctor = async (checks: string[][]) => (await runDoctor(validateConfig({ checks, setup: [['pnpm', 'install']] }), {
    repoRoot: root, homedir: root, env: { PATH: '' }, runner, fetch: async () => { throw new Error('Network forbidden'); },
  })).filter(check => check.id === 'checks.tests');

  it('reads a non-empty test script only', async () => {
    expect(await hasTestScript(root)).toBe(false);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: '  ' } }));
    expect(await hasTestScript(root)).toBe(false);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(await hasTestScript(root)).toBe(true);
  });

  it('doctor warns when the repo has tests and no check runs them', async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'turbo run test' } }));
    const [warning] = await doctor([['pnpm', 'run', 'typecheck'], ['pnpm', 'test:scripts']]);
    expect(warning).toMatchObject({ id: 'checks.tests', status: 'WARN' });
    expect(warning?.fix).toMatch(/affected packages/);
  });

  it('doctor stays quiet when a check runs the tests, or the repo has none', async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'turbo run test' } }));
    expect(await doctor([['pnpm', 'run', 'test']])).toEqual([]);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    expect(await doctor([['pnpm', 'run', 'lint']])).toEqual([]);
  });
});
