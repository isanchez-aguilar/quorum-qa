import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, REVIEW_MODES } from '../../src/cli/args.js';
import { main } from '../../src/cli/index.js';
import type { CommandRunner } from '../../src/types/index.js';
import { DEFAULT_RUNTIME_IMAGE } from '../../src/runtime/image.js';
import { runtimeReview } from '../../src/cli/runtime.js';
import { validateConfig } from '../../src/config/schema.js';

async function run(flags: string[] = [], runtime: unknown = { start: ['node', 'server.cjs'], readyUrl: 'http://localhost:4173/',
  flows: [{ name: 'login', steps: [{ goto: '/' }, { fill: 'input', value: 'PRIVATE_TEST_VALUE' }] }] }) {
  let out = ''; let err = '';
  const root = await mkdtemp(path.join(os.tmpdir(), 'quorum-runtime-cli-'));
  const commands: string[][] = [];
  const gitRunner: CommandRunner = async (command, args) => {
    expect(command).toMatch(/(?:^|[\\/])git(?:\.exe)?$/i); commands.push(args);
    let stdout = '';
    if (args.includes('rev-parse') || args.includes('merge-base')) stdout = args.includes('--show-toplevel') ? root : 'a'.repeat(40);
    if (args.includes('show') && args.some(arg => arg.endsWith(':quorum.config.json'))) stdout = JSON.stringify({ checks: [['must-not-run']], runtime });
    return { stdout, stderr: '', exitCode: 0 };
  };
  const forbidden = vi.fn(async () => { throw new Error('must not run'); });
  let code: number;
  try { code = await main(['review', '--mode', 'runtime', '--diff', 'main...HEAD', ...flags], {
    out: text => { out += text; }, err: text => { err += text; },
  }, { repoRoot: root, gitRunner, checkRunner: forbidden, containerRunner: async () => ({ stdout: '', stderr: '', exitCode: 1 }), contextRunner: forbidden, fetch: forbidden,
    appendLedger: forbidden, appendFindings: forbidden, providers: new Map() });
  } finally { await rm(root, { recursive: true, force: true }); }
  expect(forbidden).not.toHaveBeenCalled();
  expect(commands.flat().join(' ')).not.toMatch(/quorum\.rules|worktree add/);
  return { code, out, err };
}
it('accepts runtime and all earlier modes and rejects an unknown mode', () => {
  expect(REVIEW_MODES).toContain('runtime');
  for (const mode of REVIEW_MODES) expect(parseArgs(['review', '--mode', mode]).flags.mode).toBe(mode);
  expect(() => parseArgs(['review', '--mode', 'not-a-mode'])).toThrow('Unknown mode');
});
it.each(['--spec=x', '--inventory=x', '--images=x', '--rules=x', '--deterministic-only', '--allow-api-change', '--mutation'])('rejects runtime flag %s', async flag => {
  const result = await run([flag]); expect(result.code).toBe(2); expect(result.err).toContain(flag.split('=')[0]);
});
it('refuses no-checks even for dry-run', async () => {
  const result = await run(['--no-checks', '--dry-run']); expect(result.code).toBe(2); expect(result.err).toContain('runtime mode must run the app');
});
it('reports unavailable evidence as UNKNOWN with no provider calls', async () => {
  const result = await run(); expect(result.code).toBe(2);
  expect(result.out).toContain('UNKNOWN'); expect(result.out).toContain('no container runtime');
});
it('prints only the runtime plan without field values, even for an empty diff', async () => {
  const result = await run(['--dry-run']); expect(result.code).toBe(0);
  expect(result.out).toBe('Runtime plan (no commands run):\n  Start: node server.cjs\n  Ready URL: http://localhost:4173/\n'
    + '  Flows: 1; steps: 2\n  Timeouts: ready 60s; flow 60s; step 10s\n'
    + `  Image: ${DEFAULT_RUNTIME_IMAGE}\n  Limits: 2048 MiB; 512 pids\n  Screenshots: off\n`);
  expect(result.out + result.err).not.toContain('PRIVATE_TEST_VALUE');
});
it.each(['start', 'readyUrl', 'flows'])('requires runtime.%s only on runtime execution', async missing => {
  const runtime: Record<string, unknown> = { start: ['node'], readyUrl: 'http://localhost/', flows: [{ name: 'home', steps: [{ goto: '/' }] }] };
  delete runtime[missing];
  const result = await run(['--dry-run'], runtime); expect(result.code).toBe(2); expect(result.err).toContain(`runtime.${missing}`);
});
it('requires a runtime block and prints configured limits without serializing flows', async () => {
  expect(await run(['--dry-run'], {})).toMatchObject({ code: 2, err: expect.stringContaining('runtime.start') });
  const config = validateConfig({ checks: [], runtime: { start: ['node', 'server.cjs'], readyUrl: 'http://[::1]/',
    readyTimeoutSeconds: 5, flowTimeoutSeconds: 10, stepTimeoutSeconds: 1, memoryMiB: 8192, pids: 2048,
    image: 'image@sha256:' + 'A'.repeat(64), screenshots: false,
    flows: [{ name: 'private-flow-name', steps: [{ fill: 'input', value: 'PRIVATE_TEST_VALUE' }] }] } });
  let out = '';
  expect(runtimeReview(config.runtime, true, { out: text => { out += text; }, err: () => {} })).toBe(0);
  expect(out).toContain('Timeouts: ready 5s; flow 10s; step 1s');
  expect(out).toContain('Image: image@sha256:' + 'A'.repeat(64));
  expect(out).toContain('Limits: 8192 MiB; 2048 pids\n  Screenshots: off');
  expect(out).not.toMatch(/PRIVATE_TEST_VALUE|private-flow-name/);
});

it('prints UNKNOWN JSON with --format json when evidence is unavailable', async () => {
  const result = await run(['--format', 'json']);
  expect(result.code).toBe(2); expect(JSON.parse(result.out)).toMatchObject({ runtime: { available: false, verdict: 'UNKNOWN', reasons: expect.arrayContaining(['no container runtime']) }, exitCode: 2 });
});
it('rejects unsupported format values', () => { expect(() => parseArgs(['review', '--format', 'xml'])).toThrow('--format must be json'); });
it.each(['--reproduce', '--allow-unproven', '--no-host-prompt', '--author=claude', '--no-cache', '--probe'])('refuses ignored runtime option %s before execution', async flag => {
  const result = await run([flag, '--dry-run']);
  expect(result.code).toBe(2); expect(result.err).toContain(flag.split('=')[0]);
  expect(result.err).toContain('runtime is deterministic and makes no provider calls');
});
it('scrubs the readiness URL in dry-run', async () => {
  const result = await run(['--dry-run'], { start: ['node'], readyUrl: 'http://localhost/?token=SYNTHETIC_SECRET#fragment',
    flows: [{ name: 'home', steps: [{ goto: '/' }] }] });
  expect(result.code).toBe(0); expect(result.out).toContain('Ready URL: http://localhost/\n');
  expect(result.out).not.toMatch(/SYNTHETIC_SECRET|fragment/);
});
it.each([['--json'], ['--format', 'json'], ['--strict-flows'], ['--trust-head-config'], ['--out', 'runtime.md'], ['--sarif', 'runtime.sarif']])('keeps supported runtime flags working: %j', async (...flags) => {
  expect((await run(['--dry-run', ...flags])).code).toBe(0);
});
