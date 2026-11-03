import { readFile, access } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { generateMarkdownReport, type ReviewResult } from '../../src/reporters/index.js';

const root = new URL('../../', import.meta.url);

it('keeps README links usable on npm and points repository links at existing files', async () => {
  const readme = (await readFile(new URL('README.md', root), 'utf8')).replace(/\r\n/g, '\n');
  const targets = [...readme.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]!);
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    expect(target).toMatch(/^https:\/\//);
    const prefix = 'https://github.com/isanchez-aguilar/quorum-qa/blob/main/';
    if (target.startsWith(prefix)) await access(new URL(target.slice(prefix.length).split('#')[0]!, root));
  }
});

it('shows a synthetic excerpt matching the actual Markdown report', async () => {
  const readme = (await readFile(new URL('README.md', root), 'utf8')).replace(/\r\n/g, '\n');
  const excerpt = /```markdown\n([\s\S]*?)\n```/.exec(readme)?.[1];
  expect(excerpt).toBeDefined();
  const result: ReviewResult = {
    runId: 'synthetic', timestamp: '', mode: 'general', range: 'base...HEAD', headSha: 'b', baseSha: 'a',
    checks: null, criteria: [], inventory: [], families: ['openai'], exitCode: 0,
    findings: [{ file: 'src/billing.ts', line: 42, severity: 'IMPORTANT', confidence: 0.9,
      provider: 'codex', model: 'default', family: 'openai', origin: 'introduced',
      trigger: 'A zero balance skips invoice settlement',
      impact: 'Fully paid invoices remain open when the remaining balance is zero.',
      evidence_quote: 'if (remainingBalance) settleInvoice();',
      fix: 'Settle the invoice when remainingBalance === 0.' }],
    unconfirmed: [], related: [], warnings: [], errors: [], calls: [], ledgerDraft: [], cacheHits: 0,
    reviewedFamilies: ['openai'],
    coverage: { complete: true, reviewedFiles: ['src/billing.ts'], skippedFiles: [],
      truncatedHunks: [], binaryFiles: [], lostFindings: [] },
  };
  expect(generateMarkdownReport(result)).toContain(excerpt);
});
