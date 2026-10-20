import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { contractClauses } from '../../src/modes/index.js';
import { buildContractContext, loadCopy } from '../../src/context/contract.js';
import { reviewChunks } from '../../src/cascade/prompts.js';
import { parseArgs } from '../../src/cli/args.js';
import { context } from '../fixtures/cascade.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-contract-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function put(file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
it('extracts list items, nested items and heading paragraphs, caps clauses', () => {
  expect(contractClauses('intro\n# Rules\nA paragraph\ncontinued.\n\n- One\n  - Nested\n1. Two\n\n' + 'x'.repeat(700))).toEqual(['A paragraph continued.', 'One', 'Nested', 'Two', 'x'.repeat(600)]);
  expect(contractClauses('# Empty\n')).toEqual([]);
});
it('parses contract and copy', () => { expect(parseArgs(['review', '--mode', 'contract', '--rules', 'r.md', '--copy', 'ui']).flags).toMatchObject({ mode: 'contract', copy: 'ui' }); });
it('resolves direct imports, extensions, indexes, cycles and ignores missing/outside', async () => {
  await put('sample.ts', `import './a';\nconst b = require('./folder');\nimport './explicit.js';\nimport './missing';\nimport '../outside';`);
  await put('a.ts', `import './sample'; import './transitive';`); await put('folder/index.tsx', 'export const b = 1;'); await put('explicit.js', 'export const c = 2;'); await put('transitive.ts', 'secret transitive');
  const result = await buildContractContext(context(root), root);
  expect(result.groups[0]?.imports.map(f => f.file)).toEqual(['a.ts', 'folder/index.tsx', 'explicit.js']);
});
it('caps direct imports per touched file and per run with notes', async () => {
  const c = context(root); c.touchedFiles = ['one.ts', 'two.ts', 'three.ts', 'four.ts'];
  for (const [n, file] of c.touchedFiles.entries()) {
    const names = Array.from({ length: 21 }, (_, i) => `dep${n * 21 + i}`);
    await put(file, names.map(name => `import './${name}';`).join('\n'));
    for (const name of names) await put(`${name}.ts`, 'export const value = 1;');
  }
  const result = await buildContractContext(c, root);
  expect(new Set(result.groups.flatMap(g => g.imports.map(f => f.file))).size).toBe(60);
  expect(result.groups.every(g => g.imports.length <= 20)).toBe(true);
  expect(result.notes.join(' ')).toMatch(/20.*cap/); expect(result.notes.join(' ')).toMatch(/60.*cap/);
});
it('loads supported copy recursively and skips binaries with a note', async () => {
  await put('ui/en.json', '{"message":"Deposit charged"}'); await put('ui/nested/view.tsx', '<p>Deposit charged</p>'); await put('ui/a.png', 'ignore'); await put('ui/b.txt', 'binary\0data');
  const copy = await loadCopy(path.join(root, 'ui'), root);
  expect(copy.files.map(f => f.file)).toEqual(['ui/en.json', 'ui/nested/view.tsx']); expect(copy.notes.join(' ')).toContain('binary');
});
it('rejects copy over size and count limits', async () => {
  await put('big.txt', 'a'.repeat(65537)); await expect(loadCopy(path.join(root, 'big.txt'), root)).rejects.toThrow('64 KiB');
  for (let i = 0; i < 51; i++) await put(`ui/${i}.txt`, 'text');
  await expect(loadCopy(path.join(root, 'ui'), root)).rejects.toThrow('50');
});
it('rejects copy directory junctions', async () => {
  await put('real/a.txt', 'text'); await symlink(path.join(root, 'real'), path.join(root, 'link'), 'junction');
  await expect(loadCopy(path.join(root, 'link'), root)).rejects.toThrow('symlink');
});
it('uses stable untrusted clauses prefix, bounded chunks and full-input cache identity', async () => {
  await put('sample.ts', 'export const message = "Deposit charged";\n'.repeat(1100));
  const c = { ...context(root), mode: 'contract' as const, rulesContent: '# Rules\n- Charge 30% deposit' };
  c.contract = await buildContractContext(c, root);
  const first = reviewChunks(c);
  expect(first.chunks.length).toBeGreaterThan(1);
  const prefixes = first.chunks.map(chunk => chunk.prompt.split('UNTRUSTED CODE AND COPY')[0]);
  expect(new Set(prefixes).size).toBe(1); expect(prefixes[0]).toContain('R1'); expect(prefixes[0]).toContain('untrusted');
  expect(prefixes[0]).toContain('Absence alone is not a contradiction');
  expect(first.chunks.every(chunk => chunk.prompt.length <= 24000)).toBe(true);
  c.rulesContent += '\n'; expect(reviewChunks(c).chunks[0]?.prompt).not.toBe(first.chunks[0]?.prompt);
});
it('resolves emitted .js specifiers to TypeScript sources and skips oversized/node_modules imports', async () => {
  await put('sample.ts', `import './typed.js'; import './huge'; import './node_modules/pkg'; import './entry.mjs'; const c = require('./other.cjs');`);
  await put('typed.ts', 'export const typed = true;'); await put('huge.ts', 'x'.repeat(65537)); await put('node_modules/pkg.ts', 'export const dependency = true;'); await put('entry.mjs', 'export const module = true;'); await put('other.cjs', 'module.exports = true;');
  const result = await buildContractContext(context(root), root);
  expect(result.groups[0]?.imports.map(f => f.file)).toEqual(['typed.ts', 'entry.mjs', 'other.cjs']);
  expect(result.notes.join(' ')).toContain('huge');
});
it('copy changes isolate every chunk cache key', async () => {
  await put('sample.ts', 'export const message = "Charged";');
  const c = { ...context(root), mode: 'contract' as const, rulesContent: '- Charge 30%' };
  const selection = await buildContractContext(c, root);
  selection.copy = [{ file: 'copy.json', content: '"Charged"' }];
  const first = reviewChunks({ ...c, contract: selection }).chunks[0]!.prompt;
  selection.copy[0]!.content = '"Not charged"';
  expect(reviewChunks({ ...c, contract: selection }).chunks[0]!.prompt).not.toBe(first);
});

it('rejects absent code evidence in the shared verifier', async () => {
  const { verifyFinding } = await import('../../src/verifier/index.js');
  const { finding } = await import('../fixtures/cascade.js');
  await put('sample.ts', 'export const message = "Booked";');
  expect(await verifyFinding(root, finding({ evidence_quote: '' }))).toMatchObject({ verified: false, reason: 'empty evidence quote' });
});
it('rejects an external rules document selected as copy', async () => {
  await put('rules.md', '- Charge a deposit');
  await expect(loadCopy(path.join(root, 'rules.md'), path.join(root, 'repo'), path.join(root, 'rules.md'))).rejects.toThrow('rules document');
});
