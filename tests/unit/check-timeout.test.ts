import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { defaultConfig, validateConfig } from '../../src/config/schema.js';
import { generateMarkdownReport, generateSarifReport, type ReviewResult } from '../../src/reporters/index.js';
import { runDeterministicChecks } from '../../src/checks/index.js';
import { main } from '../../src/cli/index.js';

it('defaults check timeouts to 120 seconds', () => {
  expect(defaultConfig().budget).toHaveProperty('checkTimeoutSeconds', 120);
  expect(validateConfig({ checks: [] }).budget).toHaveProperty('checkTimeoutSeconds', 120);
});

it.each([30, 600, 3600])('accepts a check timeout of %s seconds', checkTimeoutSeconds => {
  expect(validateConfig({ checks: [], budget: { checkTimeoutSeconds } }).budget)
    .toHaveProperty('checkTimeoutSeconds', checkTimeoutSeconds);
});

it.each([29, 3601, 30.5, '600', null, true, Infinity])('rejects invalid check timeout %s', checkTimeoutSeconds => {
  expect(() => validateConfig({ checks: [], budget: { checkTimeoutSeconds } })).toThrow('budget.checkTimeoutSeconds');
});

it('records the default limit for successful checks too', async () => {
  const checks = await runDeterministicChecks([[process.execPath]], process.cwd(), async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  expect(checks.results[0]).toHaveProperty('timeoutMs', 120_000);
});

const timeout = { argv: ['pnpm', 'test'], exitCode: 1, timedOut: true, timeoutMs: 600_000,
  durationMs: 600_130, stdoutTail: '', stderrTail: '' };
function report(results = [timeout]): ReviewResult {
  return { runId: 'synthetic', timestamp: '', mode: 'feature', range: 'base...HEAD', headSha: 'b', baseSha: 'a',
    checks: { passed: false, results }, criteria: [], inventory: [], families: [], exitCode: 2,
    findings: [], unconfirmed: [], related: [], warnings: [], errors: [], calls: [], ledgerDraft: [], cacheHits: 0, reviewedFamilies: [],
    coverage: { complete: false, reviewedFiles: [], skippedFiles: [], truncatedHunks: [], binaryFiles: [], lostFindings: [] } };
}

it('renders the applied timeout rather than elapsed time or a failed exit', () => {
  const markdown = generateMarkdownReport(report());
  expect(markdown).toContain('pnpm test: TIMED OUT after 600s');
  expect(markdown).toContain('0 failed deterministic checks · 1 check timed out');
  expect(markdown).toContain('exit 1');
  expect(markdown).not.toContain('600.13');
  expect(JSON.parse(JSON.stringify(report())).checks.results[0]).toMatchObject({ timedOut: true, timeoutMs: 600_000 });
});

it('counts real failures and multiple timeouts separately', () => {
  const markdown = generateMarkdownReport(report([timeout, timeout, { ...timeout, timedOut: false }]));
  expect(markdown).toContain('1 failed deterministic checks · 2 checks timed out');
  expect(markdown).toContain('FAILED (exit 1)');
});

it('exposes check timeout evidence in SARIF without claiming a defect', () => {
  const sarif = JSON.parse(generateSarifReport([], report()));
  expect(sarif.runs[0].properties.checks.results[0]).toMatchObject({ timedOut: true, timeoutMs: 600_000 });
  expect(sarif.runs[0].invocations[0].toolExecutionNotifications).toContainEqual(expect.objectContaining({
    level: 'warning', message: { text: 'pnpm test: TIMED OUT after 600s (exit 1)' },
  }));
  expect(sarif.runs[0].results).toEqual([]);
  expect(JSON.stringify(sarif)).toContain('exit 1');
});

it('sets the self-review timeout to ten minutes', async () => {
  const config = JSON.parse(await readFile(new URL('../../quorum.config.json', import.meta.url), 'utf8'));
  expect(config.budget).toEqual({ checkTimeoutSeconds: 600 });
});

it('documents the check limit in help and check documentation', async () => {
  let help = '';
  await main(['--help'], { out: text => { help += text; }, err: () => {} });
  expect(help).toContain('budget.checkTimeoutSeconds');
  expect(help).toContain('30–3600');
  for (const file of ['docs/REFERENCE.md', 'docs/IMPLEMENTATION.md', 'plugin/skills/quorum/SKILL.md']) {
    expect(await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')).toContain('budget.checkTimeoutSeconds');
  }
});

it('labels a check that the task runner replayed from its cache', () => {
  const cached = { ...timeout, argv: ['pnpm', 'run', 'typecheck'], exitCode: 0, timedOut: false, cached: '13 of 13 tasks replayed from the Turbo cache' };
  const fresh = { ...timeout, argv: ['pnpm', 'test:scripts'], exitCode: 0, timedOut: false };
  const failed = { ...timeout, argv: ['pnpm', 'run', 'lint'], timedOut: false, cached: 'ignored on failure' };
  const markdown = generateMarkdownReport(report([cached, fresh, failed]));
  expect(markdown).toContain('pnpm run typecheck: passed (exit 0; cached: 13 of 13 tasks replayed from the Turbo cache)');
  expect(markdown).toContain('pnpm test:scripts: passed (exit 0)');
  expect(markdown).toContain('pnpm run lint: FAILED (exit 1)');
});

it('detects the replay from the full output, not the kept tail', async () => {
  const stdout = ['Tasks:    13 successful, 13 total', 'Cached:    13 cached, 13 total', '  Time:    1s >>> FULL TURBO',
    ...Array.from({ length: 20 }, (_, i) => `later line ${i}`)].join('\n');
  const passed = await runDeterministicChecks([[process.execPath]], process.cwd(), async () => ({ exitCode: 0, stdout, stderr: '' }));
  expect(passed.results[0]?.stdoutTail).not.toContain('Cached:');
  expect(passed.results[0]?.cached).toBe('13 of 13 tasks replayed from the Turbo cache');
  const failed = await runDeterministicChecks([[process.execPath]], process.cwd(), async () => ({ exitCode: 1, stdout, stderr: '' }));
  expect(failed.results[0]?.cached).toBeUndefined();
});

it('reports the package version in SARIF', async () => {
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const sarif = JSON.parse(generateSarifReport([], report()));
  expect(sarif.runs[0].tool.driver).toMatchObject({ name: 'Quorum', version });
  let printed = '';
  await main(['--version'], { out: text => { printed += text; }, err: () => {} });
  expect(printed.trim()).toBe(version);
});
