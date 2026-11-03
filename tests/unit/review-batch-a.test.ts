import { realpath, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifyFinding } from '../../src/verifier/index.js';
import { dedupeFindings } from '../../src/dedupe/index.js';
import { tokenize as words } from '../../src/dedupe/similarity.js';
import { diskCache } from '../../src/storage/index.js';
import { runCascade } from '../../src/cascade/index.js';
import { validateConfig } from '../../src/config/index.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { evaluateReproduction, infrastructureReason, parseTestReport, passedAtBase } from '../../src/reproduce/evaluate.js';
import { generateMarkdownReport, type ReviewResult } from '../../src/reporters/index.js';
import { cell } from '../../src/reporters/refactor.js';
import { runtimeMarkdown } from '../../src/reporters/runtime.js';
import { combinedConfidence } from '../../src/dedupe/cluster.js';
import { parseAgyQuota } from '../../src/providers/agy.js';
import { catalog, context, finding, originRunner, source } from '../fixtures/cascade.js';
import { semanticDifference, tokenize, withoutComments } from '../../src/verifier/semantic.js';
import { fastest } from '../helpers/timing.js';

const denied = vi.hoisted(() => ({ file: '', code: 'EACCES', operation: 'open' }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: async (...args: Parameters<typeof original.open>) => {
    if (String(args[0]) === denied.file && denied.operation === 'open') throw Object.assign(new Error('synthetic read error'), { code: denied.code });
    const handle = await original.open(...args);
    if (String(args[0]) === denied.file) vi.spyOn(handle, 'read').mockRejectedValue(Object.assign(new Error('synthetic read error'), { code: denied.code }));
    return handle;
  } };
});
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'quorum-batch-a-'))); await writeFile(path.join(root, 'sample.ts'), source); });
afterEach(async () => { denied.file = ''; denied.operation = 'open'; await rm(root, { recursive: true, force: true }); });
const config = () => validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] }, escalate: { confirmImportant: false } });
async function cascade(cache?: NonNullable<Parameters<typeof runCascade>[3]>['cache']) {
  const provider = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([finding()])] });
  return runCascade(context(root), config(), new Map([['agy', provider]]), { catalog, gitRunner: originRunner(root), cache });
}
function report(): ReviewResult {
  return { mode: 'feature', runId: 'synthetic', timestamp: 'synthetic', range: 'base...head', headSha: 'b', baseSha: 'a', checks: null,
    criteria: [], inventory: [], families: [], reviewedFamilies: [], cacheHits: 0, findings: [], unconfirmed: [], related: [], warnings: [], errors: [],
    calls: [], ledgerDraft: [], exitCode: 0, coverage: { reviewedFiles: [], skippedFiles: [], truncatedHunks: [], binaryFiles: [], lostFindings: [], complete: true } };
}

it.each([
  ['parentheses', 'return remaining - (spent - refunded);', 'return remaining - spent - refunded;'],
  ['operator', 'return remaining - spent;', 'return remaining + spent;'],
  ['negation', 'return !enabled;', 'return enabled;'],
])('C1 rejects changed %s', async (_name, code, quote) => {
  await writeFile(path.join(root, 'sample.ts'), code);
  expect((await verifyFinding(root, finding({ evidence_quote: quote }))).verified).toBe(false);
});

it('C1 tolerates quote style and trailing separators without changing meaning', async () => {
  await writeFile(path.join(root, 'sample.ts'), 'return "enabled status";');
  expect((await verifyFinding(root, finding({ evidence_quote: "return 'enabled status'," }))).verified).toBe(true);
});

it('K2 unbounded confidence and quota arrays do not overflow the argument stack', () => {
  expect(combinedConfidence(Array(131072).fill(finding({ confidence: 0.8 })))).toBe(0.8);
  const raw = { status: 'SUCCESS', command: { data: { groups: [{ description: 'Gemini Flash', buckets: Array(131072).fill({ remaining_fraction: 0.5 }) }] } } };
  expect(parseAgyQuota(JSON.stringify(raw), 'gemini-3.8-flash-low')).toMatchObject({ remainingPercent: 50 });
});

it('C2 keeps opposite conditions separate and genuine duplicates merged', () => {
  const first = finding({ trigger: 'When cache is enabled', impact: 'Requests return stale responses' });
  const opposite = { ...first, line: 2, trigger: 'When cache is not enabled' };
  expect(dedupeFindings([first, opposite])).toHaveLength(2);
  expect(dedupeFindings([first, { ...first, line: 2 }])).toHaveLength(1);
  expect(dedupeFindings([opposite, { ...opposite, line: 3 }])).toHaveLength(1);
});

it.each(['not', 'no', 'never', 'without', 'disabled', 'cannot', "can't", "isn't", "doesn't", 'fails to', 'missing'])('C2 retains negation token %s and checks parity even at high similarity', negation => {
  expect(words(negation)).toEqual([negation]);
  const first = finding({ trigger: 'When the shared cache configuration enables stored application response values for repeated external requests' });
  expect(dedupeFindings([first, { ...first, line: 2, trigger: `${first.trigger} ${negation}` }])).toHaveLength(2);
  expect(dedupeFindings([first, { ...first, line: 2, trigger: `${first.trigger} ${negation} ${negation}` }])).toHaveLength(1);
});

it.each([undefined, '00'.repeat(32)])('C3 forged cache MAC %s is a miss and the chunk is reviewed', async mac => {
  const directory = path.join(root, 'cache');
  const cache = diskCache(directory, () => {}, root, path.join(root, 'home'));
  const result = await cascade({ stage() {}, async read(key) {
    const file = path.join(directory, 'v1', key.slice(0, 2), `${key}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, key, model: 'agy:flash', rawOutput: '[]', mac }));
    return cache.read(key);
  } });
  expect(result.cacheHits).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.findings).toHaveLength(1);
});

it('C3 authentic round trip creates and reuses a private user key', async () => {
  const home = path.join(root, 'home');
  const directory = path.join(root, 'cache');
  const key = 'ab'.repeat(32);
  const cache = diskCache(directory, () => {}, root, home);
  cache.stage(key, '[]', 'agy:flash'); await cache.flush();
  const keyFile = path.join(home, '.quorum', 'cache.key');
  const before = await readFile(keyFile);
  const metadata = await stat(keyFile);
  expect(before.length).toBe(32);
  if (process.platform !== 'win32') expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
  expect(await diskCache(directory, () => {}, root, home).read(key)).toBe('[]');
  expect(await readFile(keyFile)).toEqual(before);
  expect((await stat(keyFile)).mtimeMs).toBe(metadata.mtimeMs);
  const file = path.join(directory, 'v1', key.slice(0, 2), `${key}.json`);
  const entry = JSON.parse(await readFile(file, 'utf8'));
  for (const alteration of [{ model: 'other' }, { rawOutput: '[{}]' }, { version: 2 }, { key: 'other' }]) {
    await writeFile(file, JSON.stringify({ ...entry, ...alteration }));
    expect(await cache.read(key)).toBeUndefined();
  }
});

it('C3 unavailable user key disables cache with a warning', async () => {
  const home = path.join(root, 'not-a-directory'); await writeFile(home, 'synthetic');
  const warn = vi.fn(); const cache = diskCache(path.join(root, 'cache'), warn, root, home);
  cache.stage('ab'.repeat(32), '[]', 'agy:flash'); await cache.flush();
  expect(await cache.read('ab'.repeat(32))).toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Cache disabled'));
});

it.each(['EACCES', 'EISDIR', 'EBUSY'])('C4 preserves lost evidence after %s at file open', async code => {
  denied.file = path.join(root, 'sample.ts'); denied.code = code;
  const result = await cascade();
  expect(result.coverage.lostFindings).toEqual([{ file: 'sample.ts', reason: 'verifier read error', count: 1 }]);
  expect(result.coverage.complete).toBe(false);
  expect(result.warnings.join('\n')).toContain('sample.ts');
});

it('C4 preserves EACCES from the opened descriptor read', async () => {
  denied.file = path.join(root, 'sample.ts'); denied.code = 'EACCES'; denied.operation = 'read';
  const result = await cascade();
  expect(result.coverage.lostFindings).toEqual([{ file: 'sample.ts', reason: 'verifier read error', count: 1 }]);
  expect(result.coverage.complete).toBe(false);
});

const rawReport = (fields = {}, assertion = {}) => ({ ...fields, testResults: [{ name: '/work/test.test.ts', assertionResults: [
  { fullName: 'synthetic', status: 'passed', failureMessages: [], ...assertion },
] }] });
it.each([{ wasInterrupted: true, success: false }, { success: false }])('P1 rejects incomplete base report %j', fields => {
  expect(passedAtBase(parseTestReport(rawReport(fields))!, 'test.test.ts')).toBe(false);
});
it('P2 keeps mixed failure details attached to their own messages', () => {
  const parsed = parseTestReport(rawReport({}, { status: 'failed', failureMessages: ['Error: database unavailable', 'AssertionError: expected 1 to be 2'],
    failureDetails: [{}, { matcherResult: { pass: false } }] }))!;
  expect(parsed.tests[0]?.failures?.map(failure => failure.kind)).toEqual(['error', 'assertion']);
  expect(evaluateReproduction(parsed, 'test.test.ts', 'database unavailable')).toBe('non-assertion-failure');
});
it('P2 mismatched details never establish an assertion', () => {
  const parsed = parseTestReport(rawReport({}, { status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2'], failureDetails: [] }))!;
  expect(evaluateReproduction(parsed, 'test.test.ts', 'expected 1')).toBe('non-assertion-failure');
});

it('P3 probe handles a 64 KiB adversarial worker line within 100 ms', () => {
  const text = 'worker '.repeat(Math.ceil(65536 / 7));
  const start = performance.now(); expect(infrastructureReason(text)).toBeUndefined();
  expect(performance.now() - start).toBeLessThan(100);
});

it.each(['worker ', 'cache ', 'EACCES ', 'spawn '])('P3 scans adversarial %s lines in linear time', token => {
  const best = (size: number) => {
    const text = token.repeat(Math.ceil(size / token.length));
    let duration = Infinity;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      const reason = infrastructureReason(text);
      duration = Math.min(duration, performance.now() - start);
      expect(reason).toBeUndefined();
    }
    return duration;
  };
  best(65536); // Warm the engine before comparing sizes.
  const small = best(65536);
  const large = best(262144);
  expect(large).toBeLessThan(100);
  expect(best(1048576)).toBeLessThan(100);
  expect(large / small).toBeLessThan(8);
});

it.each(['`'.repeat(262144), '`x'.repeat(131072)])('K2 emits a safe fence for a large proposal %#', content => {
  const result = report(); result.findings = [finding({ severity: 'BLOCKER', reproduction: { path: 'test.test.ts', content, expect: 'synthetic' } })];
  const rendered = generateMarkdownReport(result);
  const fence = rendered.split('\n').find(line => /^`{3,}$/.test(line))!;
  expect(fence.length).toBeGreaterThan(content.startsWith('`x') ? 1 : content.length);
  expect(rendered).toContain(content);
});

it.each(['![remote](https://example.invalid/pixel)', '[link](https://example.invalid)', '[x][y]', '<https://example.invalid>'])('K3 makes Markdown constructs inert: %s', text => {
  const result = report(); result.criteria = [text]; result.warnings = [text, `Independence ${text}`];
  result.findings = [finding({ trigger: text, impact: text, fix: text, evidence_quote: text, clauseNote: text })];
  expect(generateMarkdownReport(result)).not.toContain(text);
  expect(cell(text)).not.toContain(text);
  expect(runtimeMarkdown({ verdict: 'UNKNOWN', exitCode: 2, reasons: [text], notes: [text], shots: [], available: false, strictFlows: false, summary: '' }).join('\n')).not.toContain(text);
  for (const mode of ['feature', 'redesign', 'contract', 'bughunt', 'refactor', 'runtime'] as const) {
    result.mode = mode; result.inventory = [text]; result.clauses = [text];
    expect(generateMarkdownReport(result)).not.toContain(text);
  }
});

it('K3 prose brackets remain readable and cannot be reactivated with backslashes', () => {
  expect(cell('value [optional]')).toBe('value \\[optional\\]');
  expect(cell('\\[link](https://example.invalid)')).toBe('\\\\\\[link\\](https://example.invalid)');
});

it.each([
  ["  const label = 'sum'; // keep the label short", 'const label = "sum";'],
  ["/* block comment */ const mode = 'fast';", 'const mode = "fast";'],
  ['const url = "http://example.test/a"; // docs', "const url = 'http://example.test/a';"],
  ["const label = 'sum'; // keep the label short", "const label = 'sum';"],
  ["const label = 'sum'; // keep the label short", 'const label = "sum"; // keep the label short'],
  ['const ratio = a / b / c; // division', 'const ratio = a / b / c; /* quoted comment */'],
])('F1 verifies commented code %#', async (code, quote) => {
  await writeFile(path.join(root, 'sample.ts'), code);
  expect((await verifyFinding(root, finding({ evidence_quote: quote }))).verified).toBe(true);
});

it('F1 skips comments on both sides while preserving literals and division', () => {
  expect(semanticDifference('/* quote */ a / b / c // tail', 'a / b / c /* code */')).toBeNull();
  expect(semanticDifference('a / b / c', 'a / b * c')).not.toBeNull();
  expect(semanticDifference('value /* unfinished', 'value')).toBeNull();
  for (const literal of ['`http://host/*path*/`', String.raw`"escaped\"//text"`, String.raw`'escaped\'/*text*/'`, '`escaped\\`//text`']) {
    expect(semanticDifference(`const value = ${literal}; // comment`, `const value = ${literal};`)).toBeNull();
    expect(withoutComments(literal)).toBe(literal);
  }
  expect(semanticDifference('`// first`', '`// second`')).not.toBeNull();
  expect(semanticDifference('a // comment\nb', 'a\nb')).toBeNull();
  expect(semanticDifference('a /* multi\nline */ / b', 'a / b')).toBeNull();
});

it.each([
  ['return a - b; // arithmetic', 'return a + b;'],
  ['return a - (b - c); // grouping', 'return a - b - c;'],
])('F1 comment fallback still rejects semantic changes %#', async (code, quote) => {
  await writeFile(path.join(root, 'sample.ts'), code);
  expect((await verifyFinding(root, finding({ evidence_quote: quote }))).verified).toBe(false);
});

it('F1 tokenizes 256 KiB comments within 50 ms', () => {
  for (const text of ['//' + 'x'.repeat(262142), '/*' + 'x'.repeat(262142), '/* x */ '.repeat(32768)]) {
    expect(tokenize(text)).toHaveLength(0);
    expect(fastest(() => { tokenize(text); })).toBeLessThan(50);
    expect(fastest(() => { withoutComments(text); })).toBeLessThan(50);
  }
});

it.each(['unless', 'except', 'instead', 'otherwise'])('F2 retains %s and separates opposite conditions', word => {
  expect(words(word)).toEqual([word]);
  const first = finding({ trigger: 'When the shared cache configuration enables stored application response values for repeated external requests' });
  const opposite = { ...first, trigger: first.trigger.replace('When', word) };
  expect(dedupeFindings([first, opposite])).toHaveLength(2);
  expect(dedupeFindings([opposite, { ...opposite, line: 2 }])).toHaveLength(1);
  expect(dedupeFindings([first, { ...first, line: 2 }])).toHaveLength(1);
});
it('F2 separates update instead of delete from update and delete', () => {
  expect(dedupeFindings([finding({ trigger: 'runs update instead of delete' }), finding({ trigger: 'runs update and delete' })])).toHaveLength(2);
});

it.each([0, 10, 32])('F3 recovers a %i-byte key or preserves a valid key', async size => {
  const home = path.join(root, 'home');
  const keyFile = path.join(home, '.quorum', 'cache.key');
  await mkdir(path.dirname(keyFile), { recursive: true });
  const before = Buffer.alloc(size, 7);
  await writeFile(keyFile, before);
  const warn = vi.fn();
  const cache = diskCache(path.join(root, 'cache'), warn, root, home);
  cache.stage('ab', 'synthetic', 'fake'); await cache.flush();
  expect(await cache.read('ab')).toBe('synthetic');
  expect((await readFile(keyFile)).length).toBe(32);
  if (size === 32) expect(await readFile(keyFile)).toEqual(before);
  expect(warn).not.toHaveBeenCalled();
});

it('F3 eight concurrent repairs all authenticate with the key on disk', async () => {
  const home = path.join(root, 'home');
  await mkdir(path.join(home, '.quorum'), { recursive: true });
  await writeFile(path.join(home, '.quorum', 'cache.key'), '');
  const warn = vi.fn();
  const caches = Array.from({ length: 8 }, () => diskCache(path.join(root, 'cache'), warn, root, home));
  await Promise.all(caches.map((cache, index) => { cache.stage(`ab${index}`, 'synthetic', 'fake'); return cache.flush(); }));
  const fresh = diskCache(path.join(root, 'cache'), warn, root, home);
  for (const cache of [...caches, fresh]) {
    for (let index = 0; index < 8; index++) expect(await cache.read(`ab${index}`)).toBe('synthetic');
  }
  expect(warn).not.toHaveBeenCalled();
});

it('F4 counts one original finding across two unreadable confirmations', async () => {
  const yes = JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote });
  const agy = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([finding({ confidence: 0.5 })])], opus: [yes] });
  const codex = new FakeProvider('codex', 'openai', originRunner(root), { codex: [yes] });
  const execute = codex.executeReview.bind(codex);
  vi.spyOn(codex, 'executeReview').mockImplementation(async (...args) => {
    denied.file = path.join(root, 'sample.ts'); denied.code = 'EACCES';
    return execute(...args);
  });
  const cfg = validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex', 'agy:opus'], visual: [] } });
  const result = await runCascade(context(root), cfg, new Map([['agy', agy], ['codex', codex]]), { catalog, gitRunner: originRunner(root) });
  expect(result.calls.filter(call => call.purpose === 'confirm')).toHaveLength(2);
  expect(result.coverage.lostFindings).toEqual([{ file: 'sample.ts', reason: 'verifier read error', count: 1 }]);
  expect(result.warnings.filter(warning => warning.includes('verifier read error;'))).toHaveLength(1);
});
