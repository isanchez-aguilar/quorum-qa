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
  for (const file of ['README.md', 'docs/IMPLEMENTATION.md', 'plugin/skills/quorum/SKILL.md']) {
    expect(await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')).toContain('budget.checkTimeoutSeconds');
  }
});
