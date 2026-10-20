import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { runCommand } from '../../src/process/runner.js';
import { FakeProvider } from '../../src/providers/fake.js';
import type { CommandRunner } from '../../src/types/index.js';
import type { ReviewResult } from '../../src/reporters/index.js';
import { catalog, finding } from '../fixtures/cascade.js';
let root: string;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
const runner: CommandRunner = (command, args, options) => { if (!/^git(?:\.exe)?$/i.test(path.basename(command))) throw new Error('Only git is allowed'); return runCommand(command, args, { ...options, env }); };
async function git(...args: string[]) { const r = await runner('git', args, { cwd: root, timeoutMs: 10000 }); if (r.exitCode) throw new Error(r.stderr); }
const quote = 'export function book() { return "A deposit of 30% was charged at booking"; }';
const bug = (trigger = 'R2: a deposit of 30% is charged at booking') => finding({ severity: 'BLOCKER', trigger, evidence_quote: quote, impact: 'The confirmation claims a charge but book never charges money', fix: 'Charge before confirming' });
beforeEach(async () => {
 root = await mkdtemp(path.join(tmpdir(), 'quorum-contract-cli-'));
 await git('init'); await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.autocrlf', 'false');
 await writeFile(path.join(root, '.gitignore'), '.quorum/\n');
 await writeFile(path.join(root, 'sample.ts'), 'export function book() { return "Booked"; }\n');
 await writeFile(path.join(root, 'rules.md'), '# Rules\n- Booking is available.\n- A deposit of 30% is charged at booking.\n');
 await writeFile(path.join(root, 'copy.json'), '{"message":"A deposit of 30% was charged at booking"}\n');
 await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify({ base: 'base', checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] }, escalate: { focus: [], belowConfidence: 0.6, confirmImportant: false } }));
 await git('add', '.'); await git('commit', '-m', 'base'); await git('branch', 'base');
 await writeFile(path.join(root, 'sample.ts'), quote + '\n'); await git('add', '.'); await git('commit', '-m', 'head');
}, 20000);
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function review(items = [bug()], args: string[] = [], responses?: string[]) {
 const agy = new FakeProvider('agy', 'google', runner, { flash: responses ?? [JSON.stringify(items), '[]', '[]'] });
 const codex = new FakeProvider('codex', 'openai', runner, { codex: [JSON.stringify({ decision: 'confirm', evidence_quote: items[0]?.evidence_quote ?? quote })] });
 let out = ''; let err = '';
 const code = await main(['review', '--mode', 'contract', '--rules', 'rules.md', '--diff', 'base...HEAD', '--no-checks', '--no-cache', '--out', '.quorum/report.md', '--json', ...args], { out: t => { out += t; }, err: t => { err += t; } }, { repoRoot: root, gitRunner: runner, catalog, providers: new Map([['agy', agy], ['codex', codex]]), appendLedger: async () => {} });
 return { code, out, err, agy, result: out.startsWith('{') ? JSON.parse(out) as ReviewResult : undefined };
}
it('reports the deposit contradiction, Rules table, SARIF and confirmed exit 1', async () => {
 const r = await review(undefined, ['--copy', 'copy.json', '--sarif', '.quorum/result.sarif']);
 expect(r.code, r.err).toBe(1); expect(r.result?.findings[0]).toMatchObject({ clause: 'R2', confirmationFamilies: ['google', 'openai'] });
 const md = await readFile(path.join(root, '.quorum/report.md'), 'utf8');
 expect(md).toContain('## Rules'); expect(md).toMatch(/R2.*contradicted.*1/); expect(md).toMatch(/R1.*no finding.*0/); expect(md).toContain(quote); expect(md).not.toContain('## Pre-existing bugs');
 const sarif = JSON.parse(await readFile(path.join(root, '.quorum/result.sarif'), 'utf8'));
 expect(sarif.runs[0].results[0].properties).toMatchObject({ mode: 'contract', clause: 'R2' });
 expect(r.agy.calls[1]?.prompt).toContain('copy.json:1:');
});
it.each(['No clause given', 'R999: unknown clause'])('keeps and tags %s', async trigger => {
 const r = await review([bug(trigger)]); expect(r.result?.findings).toHaveLength(1);
 expect(await readFile(path.join(root, '.quorum/report.md'), 'utf8')).toContain('no clause cited');
});
it('drops a rules document quote and an absence without code evidence', async () => {
 const r = await review([bug(), { ...bug(), file: 'rules.md', line: 3, evidence_quote: 'A deposit of 30% is charged at booking.' }, { ...bug(), evidence_quote: '', impact: 'Absent feature' }]);
 expect(r.result?.findings).toHaveLength(1);
 const reasons = JSON.stringify(r.result?.ledgerDraft); expect(reasons).toContain('rules document'); expect(reasons).toContain('evidence_quote must be a non-empty string');
});
it('dry-run lists clauses, code, copy and chunks without providers', async () => {
 const r = await review([], ['--dry-run', '--copy', 'copy.json']); expect(r.code, r.err).toBe(0);
 expect(r.out).toContain('Clauses: 2'); expect(r.out).toContain('sample.ts'); expect(r.out).toContain('copy.json'); expect(r.out).toContain('Review chunks: 2'); expect(r.agy.calls).toHaveLength(0);
});
it('rejects empty clauses with accepted formats', async () => {
 await writeFile(path.join(root, 'rules.md'), '# Empty\n'); const r = await review([]);
 expect(r.code).toBe(2); expect(r.err).toMatch(/list items.*paragraphs under.*heading/i); expect(r.agy.calls).toHaveLength(0);
});
it('incomplete coverage without blockers exits 2', async () => {
 const r = await review([], [], []); expect(r.code).toBe(2); expect(r.result?.coverage.complete).toBe(false);
});
it('requires rules before git or providers', async () => {
 let err = ''; expect(await main(['review', '--mode', 'contract'], { out: () => {}, err: t => { err += t; } })).toBe(2); expect(err).toContain('--rules is required');
});

it('verifies supplied copy evidence and uses committed origin when available', async () => {
 const evidence = '{"message":"A deposit of 30% was charged at booking"}';
 const r = await review([{ ...bug(), file: 'copy.json', evidence_quote: evidence }], ['--copy', 'copy.json']);
 expect(r.code, r.err).toBe(1); expect(r.result?.findings[0]).toMatchObject({ file: 'copy.json', clause: 'R2', origin: 'pre-existing' });
});
it('accepts untracked copy as introduced input and cleans its snapshot', async () => {
 await writeFile(path.join(root, 'fresh.txt'), 'Your deposit has been charged.');
 const r = await review([{ ...bug(), file: 'fresh.txt', evidence_quote: 'Your deposit has been charged.' }], ['--copy', 'fresh.txt']);
 expect(r.code, r.err).toBe(1); expect(r.result?.findings[0]).toMatchObject({ origin: 'introduced', clause: 'R2' });
 expect(r.result?.findings[0]?.verification_note).toContain('not tracked at HEAD');
});
it('keeps clean runs at exit zero and reports no finding rather than satisfaction', async () => {
 const r = await review([]); expect(r.code, r.err).toBe(0); expect(r.result?.coverage.complete).toBe(true);
 const md = await readFile(path.join(root, '.quorum/report.md'), 'utf8'); expect(md).toMatch(/R2.*no finding.*0/); expect(md).not.toContain('satisfied');
});
it('never accepts the rules file as --copy', async () => {
 const r = await review([], ['--copy', 'rules.md']); expect(r.code).toBe(2); expect(r.err).toContain('rules document'); expect(r.agy.calls).toHaveLength(0);
});
it('copy snapshots do not shadow committed code when the same touched file has dirty copy', async () => {
 await writeFile(path.join(root, 'sample.ts'), 'export function book() { return "Local copy changed"; }\n');
 const r = await review([bug()], ['--copy', 'sample.ts']);
 expect(r.code, r.err).toBe(1); expect(r.result?.findings[0]?.evidence_quote).toBe(quote);
});
