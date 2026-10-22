import { fastest } from '../helpers/timing.js';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { contractClauses } from '../../src/modes/index.js';
import { assertNoLinks, buildContractContext, loadCopy } from '../../src/context/contract.js';
import { reviewChunks } from '../../src/cascade/prompts.js';
import { parseArgs } from '../../src/cli/args.js';
import { context } from '../fixtures/cascade.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-contract-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function put(file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
it.each([
  "import x from './a'", 'import {a, b} from "./a"', "import * as x from './a'",
  "import './a'", "import('./a')", "require('./a')", "export * from './a'",
  "export {x} from './a'", "import {\n a,\n b\n} from './a'",
])('finds supported dependency syntax: %s', async source => {
  await put('sample.ts', source); await put('a.ts', 'export const a = 1;');
  expect((await buildContractContext(context(root), root)).groups[0]?.imports.map(f => f.file)).toEqual(['a.ts']);
});
it.each([['sample.ts', './'], ['nested/sample.ts', '../'], ['sample.ts', './.']])('resolves root index from %s via %s', async (file, spec) => {
  await put(file!, `import '${spec}';`); await put('index.ts', 'export const a = 1;');
  const c = { ...context(root), touchedFiles: [file!] };
  expect((await buildContractContext(c, root)).groups[0]?.imports.map(f => f.file)).toEqual(['index.ts']);
});
it.each([
  ['import spaces', 'import ', ' '], ['import words', 'import ', 'a '],
  ['import commas', 'import {', ','], ['long line', '', 'a'],
  ['require spaces', 'require(', ' '], ['export spaces', 'export ', ' '],
])('scans 64 KiB %s in under 200 ms', async (_name, prefix, fill) => {
  const source = (prefix + fill.repeat(65536)).slice(0, 65536);
  await put('sample.ts', source);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(async ({ buildContractContext }) => {
      const fastest = ${fastest.toString()};
      parentPort.postMessage(await fastest(() => buildContractContext(workerData.context, workerData.root)));
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { module: new URL('../../dist/context/contract.js', import.meta.url).href, context: context(root), root } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const elapsed = await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => resolve(Infinity), 2000);
      worker.once('message', resolve); worker.once('error', reject);
    });
    expect(elapsed).toBeLessThan(200);
  } finally { clearTimeout(timer); await worker.terminate(); }
});
it('keeps clause extraction linear on adversarial lines', () => {
  for (const text of [' '.repeat(65536), '- ' + ' '.repeat(65534), '1'.repeat(65536), '['.repeat(65536)]) {
    expect(fastest(() => { contractClauses(text); })).toBeLessThan(200);
  }
});
it('bounds look-ahead and does not search other statements or ordinary lines', async () => {
  await put('a.ts', 'export const a = 1;');
  for (const source of ["import\n'./a'", "export *\nfrom './a'", "import ; './a'",
    "import " + ' '.repeat(4096) + "'./a'", "// import './a'", `const s = "import './a'";`]) {
    await put('sample.ts', source);
    expect((await buildContractContext(context(root), root)).groups[0]?.imports).toEqual([]);
  }
});
it('rejects outside imports even when the target exists', async () => {
  await put('outside.ts', 'export const outside = 1;');
  await put('repo/sample.ts', "import '../outside'; import '/index';");
  const repo = path.join(root, 'repo');
  expect((await buildContractContext(context(repo), repo)).groups[0]?.imports).toEqual([]);
});
it('accepts linked ancestors for worktrees and explicit inputs', async t => {
  await put('real/repo/sample.ts', "import './a';"); await put('real/repo/a.ts', 'export const a = 1;');
  await put('real/rules.md', '- A rule'); await put('real/copy/a.txt', 'Copy');
  try { await symlink(path.join(root, 'real'), path.join(root, 'alias'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip(`OS refused junction: ${(error as Error).message}`); return; } throw error; }
  const repo = path.join(root, 'alias/repo');
  expect((await buildContractContext(context(repo), repo)).groups[0]?.imports.map(f => f.file)).toEqual(['a.ts']);
  await expect(assertNoLinks(path.join(root, 'alias/rules.md'))).resolves.toBeUndefined();
  expect((await loadCopy(path.join(root, 'alias/copy'), repo)).files).toHaveLength(1);
  expect((await loadCopy(path.join(root, 'alias/copy/a.txt'), repo)).files).toHaveLength(1);
});
it('rejects linked copy entries and worktree components below the root', async () => {
  await put('real/a.ts', 'export const a = 1;'); await put('sample.ts', "import './linked/a';");
  await mkdir(path.join(root, 'copy'));
  await symlink(path.join(root, 'real'), path.join(root, 'linked'), 'junction');
  await symlink(path.join(root, 'real'), path.join(root, 'copy/entry'), 'junction');
  expect((await buildContractContext(context(root), root)).groups[0]?.imports).toEqual([]);
  await expect(loadCopy(path.join(root, 'copy'), root)).rejects.toThrow('symlink');
});
it('rejects a symlink file itself', async t => {
  await put('real.txt', 'Copy');
  try { await symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip(`OS refused file symlink: ${(error as Error).message}`); return; } throw error; }
  await expect(assertNoLinks(path.join(root, 'link.txt'))).rejects.toThrow('symlink');
  await expect(loadCopy(path.join(root, 'link.txt'), root)).rejects.toThrow('symlink');
});
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

it('stops at a boundary written with a different drive-letter case instead of walking to the disk root', async t => {
  // Found by Gemini's re-review and reproduced: with c: against C:, the strict comparison never matched.
  if (process.platform !== 'win32') { t.skip('Drive-letter case only differs on Windows'); return; }
  await put('repo/sub/a.ts', 'x');
  const file = path.join(root, 'repo/sub/a.ts');
  const flip = (value: string) => (value[0] === value[0]!.toUpperCase() ? value[0]!.toLowerCase() : value[0]!.toUpperCase()) + value.slice(1);
  const settled = await Promise.race([
    assertNoLinks(file, flip(path.join(root, 'repo'))).then(() => 'returned'),
    new Promise<string>(resolve => setTimeout(() => resolve('hang'), 2000)),
  ]);
  expect(settled).toBe('returned');
});
it('throws instead of looping when the file is not below the boundary', async () => {
  await put('repo/a.ts', 'x'); await put('other/b.ts', 'x');
  await expect(assertNoLinks(path.join(root, 'other/b.ts'), path.join(root, 'repo'))).rejects.toThrow('outside its boundary');
});
it('finds dynamic imports and requires written as template literals without substitutions', async () => {
  await put('a.ts', 'export const a = 1;');
  await put('sample.ts', 'const m = await import(`./a`);');
  expect((await buildContractContext(context(root), root)).groups[0]?.imports.map(f => f.file)).toEqual(['a.ts']);
  await put('sample.ts', 'const m = require(`./a`);');
  expect((await buildContractContext(context(root), root)).groups[0]?.imports.map(f => f.file)).toEqual(['a.ts']);
  await put('sample.ts', 'const name = "a"; const m = await import(`./${name}`);');
  expect((await buildContractContext(context(root), root)).groups[0]?.imports).toEqual([]);
});
