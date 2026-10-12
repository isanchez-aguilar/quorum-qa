import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Finding } from '../../src/types/index.js';
import { verifyFinding, MAX_FILE_BYTES } from '../../src/verifier/index.js';
import { isCitableLine, localWindow, splitLines } from '../../src/verifier/lines.js';
import { normalizePath } from '../../src/verifier/path.js';
import {
  FUZZY,
  MAX_QUOTE_CHARS,
  MAX_QUOTE_LINES,
  calculateSimilarity,
  levenshtein,
  normalizeQuote,
} from '../../src/verifier/quote.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/sources', import.meta.url));
const QUOTE = 'if (!user.token) return false;';

let sandbox: string;
let root: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'quorum-verifier-'));
  root = path.join(sandbox, 'worktree');
  await mkdir(root);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function finding(over: Partial<Finding> = {}): Finding {
  return {
    severity: 'IMPORTANT',
    origin: 'introduced',
    file: 'src/auth.ts',
    line: 42,
    trigger: 'trigger',
    impact: 'impact',
    evidence_quote: QUOTE,
    fix: 'fix',
    provider: 'fake',
    model: 'fake-1',
    family: 'google',
    confidence: 0.8,
    ...over,
  };
}

// A file of `total` filler lines with `placed` lines (1-indexed) put in.
function sourceFile(total: number, placed: Record<number, string>, eol = '\n'): string {
  const lines: string[] = [];
  for (let n = 1; n <= total; n += 1) lines.push(placed[n] ?? `// padding ${n}`);
  return lines.join(eol) + eol;
}

async function put(relative: string, content: string): Promise<void> {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function verify(over: Partial<Finding> = {}) {
  return verifyFinding(root, finding(over));
}

describe('verifyFinding: table 4.4', () => {
  it('row 1: exact line and quote', async () => {
    await put('src/auth.ts', sourceFile(300, { 42: QUOTE }));
    const result = await verify();
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(42);
    expect(result.correctedFinding?.verified).toBe(true);
    expect(result.correctedFinding?.verification_note).toBeUndefined();
  });

  it('row 2: CRLF in the quote is normalized', async () => {
    await put('src/auth.ts', sourceFile(300, { 42: QUOTE }));
    const result = await verify({ evidence_quote: `${QUOTE}\r\n` });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(42);
  });

  it('row 3: indentation and interior whitespace are collapsed', async () => {
    await put('src/auth.ts', sourceFile(300, { 42: QUOTE }));
    const result = await verify({ evidence_quote: '  if (!user.token)   return false;' });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(42);
    expect(result.correctedFinding?.verification_note).toBeUndefined();
  });

  it('row 4: off by one is corrected inside the radius', async () => {
    await put('src/auth.ts', sourceFile(300, { 41: QUOTE }));
    const result = await verify({ line: 40 });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(41);
    expect(result.correctedFinding?.verification_note).toMatch(/corrected from line 40 to line 41/);
  });

  it('row 5: drift of 7 lines is corrected inside the radius', async () => {
    await put('src/auth.ts', sourceFile(300, { 42: QUOTE }));
    const result = await verify({ line: 35 });
    expect(result.correctedFinding?.line).toBe(42);
    expect(result.correctedFinding?.verification_note).toMatch(/within 10 lines/);
  });

  it('row 6: line 5200 in a 300-line file is corrected by the global scan', async () => {
    await put('src/auth.ts', sourceFile(300, { 42: QUOTE }));
    const result = await verify({ line: 5200 });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(42);
    expect(result.correctedFinding?.verification_note).toMatch(/elsewhere in the file/);
  });

  it('row 7: a missing file is rejected', async () => {
    const result = await verify({ file: 'src/missing.ts', line: 10, evidence_quote: 'const x = 1;' });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/file not found/);
    expect(result.correctedFinding).toBeUndefined();
  });

  it('row 8: a path that escapes the root is rejected even if the file exists', async () => {
    await writeFile(path.join(sandbox, 'secret.env'), 'DB_PASS=secret\n', 'utf8');
    const result = await verify({ file: '../secret.env', line: 1, evidence_quote: 'DB_PASS=secret' });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/invalid path/);
  });

  it('row 9: %2e%2e is a literal directory name, never decoded', async () => {
    // If it were decoded, src/../etc/passwd would resolve to this file and verify.
    await put('etc/passwd', 'root:x:0:0\n');
    const result = await verify({
      file: 'src/%2e%2e/etc/passwd',
      line: 1,
      evidence_quote: 'root:x:0:0',
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/file not found/);
  });

  it('row 10: an absolute Windows path is rejected', async () => {
    const result = await verify({
      file: 'C:\\Windows\\System32\\cmd.exe',
      line: 1,
      evidence_quote: 'binary',
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/invalid path/);
  });

  it('row 11: a typo in the quote still verifies (sim about 0.94)', async () => {
    const actual = 'total = price * (1 + TAX_RATIO)';
    const quoted = 'total = price * (1 + TAX_RATE)';
    expect(calculateSimilarity(quoted, actual)).toBeGreaterThan(0.93);
    await put('src/pay.ts', sourceFile(40, { 15: actual }));
    const result = await verify({ file: 'src/pay.ts', line: 15, evidence_quote: quoted });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(15);
    expect(result.correctedFinding?.verification_note).toMatch(/fuzzy quote match, similarity 0\.9/);
  });

  it('row 12: hallucinated code is rejected (sim below 0.30)', async () => {
    const actual = 'let total = price * quantity;';
    const quoted = 'chargeCreditCard(customer, amount)';
    expect(calculateSimilarity(quoted, actual)).toBeLessThan(0.3);
    await put('src/pay.ts', sourceFile(40, { 15: actual }));
    const result = await verify({ file: 'src/pay.ts', line: 15, evidence_quote: quoted });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/quote not found/);
  });

  it('row 13: a whitespace-only quote is rejected', async () => {
    await put('src/pay.ts', sourceFile(40, { 15: 'let total = 0;' }));
    const result = await verify({ file: 'src/pay.ts', line: 15, evidence_quote: '   ' });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/empty evidence quote/);
  });

  it('row 14: a multi-line block with indentation drift verifies', async () => {
    await put(
      'src/ui.tsx',
      sourceFile(40, { 20: '<div>', 21: '    <span>Hello</span>', 22: '  </div>' }),
    );
    const result = await verify({
      file: 'src/ui.tsx',
      line: 20,
      evidence_quote: '<div>\n  <span>Hello</span>\n</div>',
    });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(20);
  });

  it('row 15: an ambiguous quote picks the closest line inside the radius', async () => {
    await put('src/dup.ts', sourceFile(90, { 5: 'return null;', 12: 'return null;', 85: 'return null;' }));
    const result = await verify({ file: 'src/dup.ts', line: 10, evidence_quote: 'return null;' });
    expect(result.correctedFinding?.line).toBe(12);
  });

  it('row 16: an empty file is rejected', async () => {
    await put('src/empty.ts', '');
    const result = await verify({ file: 'src/empty.ts', line: 1, evidence_quote: 'const x = 1;' });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  it('row 17: a Windows backslash path is converted', async () => {
    await put('src/win/path.ts', sourceFile(10, { 5: 'export const WIN = true;' }));
    const result = await verify({
      file: 'src\\win\\path.ts',
      line: 5,
      evidence_quote: 'export const WIN = true;',
    });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(5);
  });

  describe('thresholds (rows 18 and 19)', () => {
    const base = 'ab'.repeat(500); // 1000 characters
    const withSubstitutions = (count: number) => 'x'.repeat(count) + base.slice(count);

    it('row 18: similarity 0.849 is rejected', async () => {
      const actual = withSubstitutions(151);
      expect(calculateSimilarity(base, actual)).toBeCloseTo(0.849, 6);
      await put('src/t.ts', sourceFile(30, { 10: actual }));
      const result = await verify({ file: 'src/t.ts', line: 10, evidence_quote: base });
      expect(result.verified).toBe(false);
    });

    it('row 19: similarity exactly 0.85 is accepted (inclusive)', async () => {
      const actual = withSubstitutions(150);
      expect(calculateSimilarity(base, actual)).toBeCloseTo(FUZZY, 12);
      await put('src/t.ts', sourceFile(30, { 10: actual }));
      const result = await verify({ file: 'src/t.ts', line: 10, evidence_quote: base });
      expect(result.verified).toBe(true);
      expect(result.correctedFinding?.line).toBe(10);
      expect(result.correctedFinding?.verification_note).toMatch(/similarity 0\.85/);
    });
  });

  it('row 20: equal distance, the lower line number wins', async () => {
    await put('src/dup.ts', sourceFile(40, { 8: 'return null;', 12: 'return null;' }));
    const result = await verify({ file: 'src/dup.ts', line: 10, evidence_quote: 'return null;' });
    expect(result.correctedFinding?.line).toBe(8);
  });

  it('row 21: a local fuzzy match beats a global exact match', async () => {
    // Line 30 is exact but outside the window; line 12 is fuzzy (about 0.91) and inside it.
    const quoted = 'compute();';
    await put('src/t.ts', sourceFile(40, { 12: 'computeX();', 30: quoted }));
    expect(calculateSimilarity(quoted, 'computeX();')).toBeGreaterThanOrEqual(FUZZY);
    const result = await verify({ file: 'src/t.ts', line: 10, evidence_quote: quoted });
    expect(result.correctedFinding?.line).toBe(12);
  });
});

describe('verifyFinding: more cases', () => {
  it('verifies against the static fixtures', async () => {
    const auth = await verifyFinding(FIXTURES, finding({ file: 'auth.ts', line: 40 }));
    expect(auth.verified).toBe(true);
    expect(auth.correctedFinding?.line).toBe(29);
    const pay = await verifyFinding(
      FIXTURES,
      finding({ file: 'pay.ts', line: 18, evidence_quote: 'let total = price * (1 + TAX_RATIO);' }),
    );
    expect(pay.correctedFinding?.line).toBe(18);
  });

  it('an exact match inside the window wins over a closer fuzzy one', async () => {
    await put('src/t.ts', sourceFile(40, { 10: 'computeX();', 14: 'compute();' }));
    const result = await verify({ file: 'src/t.ts', line: 10, evidence_quote: 'compute();' });
    expect(result.correctedFinding?.line).toBe(14);
  });

  it('a higher similarity wins over a closer line inside the same scope', async () => {
    const quoted = 'compute(alpha, beta);';
    const near = 'compute(alpha, betaXX);'; // distance 2, similarity about 0.91
    const far = 'compute(alpha, betaX);'; // distance 1, similarity about 0.95
    await put('src/t.ts', sourceFile(40, { 10: near, 14: far }));
    expect(calculateSimilarity(quoted, far)).toBeGreaterThan(calculateSimilarity(quoted, near));
    const result = await verify({ file: 'src/t.ts', line: 10, evidence_quote: quoted });
    expect(result.correctedFinding?.line).toBe(14);
  });

  it('a quote that is a fragment of a line verifies', async () => {
    await put('src/auth.ts', sourceFile(60, { 42: `  ${QUOTE}` }));
    const result = await verify({ evidence_quote: '!user.token' });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(42);
  });

  it('quotes with tabs match space-indented code', async () => {
    await put('src/auth.ts', sourceFile(60, { 42: '    if (!user.token) {', 43: '      return false;', 44: '    }' }));
    const result = await verify({
      evidence_quote: '\tif (!user.token) {\n\t\treturn false;\n\t}',
      line: 42,
    });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(42);
    expect(result.correctedFinding?.verification_note).toBeUndefined();
  });

  it('multi-line quotes with a different base indentation match exactly', async () => {
    await put(
      'src/auth.ts',
      sourceFile(60, { 20: '      if (a) {', 21: '        run();', 22: '      }' }),
    );
    const result = await verify({ line: 20, evidence_quote: 'if (a) {\n  run();\n}' });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(20);
    expect(result.correctedFinding?.verification_note).toBeUndefined();
  });

  it('CRLF files are read line by line', async () => {
    const content = sourceFile(60, { 20: 'const a = 1;', 21: 'const b = 2;' }, '\r\n');
    await put('src/auth.ts', content);
    const result = await verify({ line: 20, evidence_quote: 'const a = 1;\nconst b = 2;' });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(20);
  });

  it('a BOM does not break a quote on the first line', async () => {
    await put('src/auth.ts', `\uFEFFconst first = 1;\nconst second = 2;\n`);
    const result = await verify({ line: 1, evidence_quote: 'const first = 1;' });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(1);
  });

  it.each([
    ['0', 0],
    ['a negative line', -7],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a fraction', 41.5],
    ['5200 in a 300-line file', 5200],
  ])('an unusable cited line (%s) falls back to the whole file', async (_name, line) => {
    await put('src/auth.ts', sourceFile(300, { 42: QUOTE }));
    const result = await verify({ line });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(42);
    expect(result.correctedFinding?.verification_note).toMatch(/corrected from/);
  });

  it('an unusable cited line still resolves ties to the lowest line', async () => {
    await put('src/dup.ts', sourceFile(60, { 12: 'return null;', 30: 'return null;' }));
    const result = await verify({ file: 'src/dup.ts', line: Number.NaN, evidence_quote: 'return null;' });
    expect(result.correctedFinding?.line).toBe(12);
  });

  it('a directory is rejected', async () => {
    await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
    const result = await verify({ file: 'src/lib', line: 1 });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/directory/);
  });

  it('a file over the size limit is rejected without being read', async () => {
    await put('src/big.ts', 'a'.repeat(MAX_FILE_BYTES + 1));
    const result = await verify({ file: 'src/big.ts', line: 1, evidence_quote: 'aaa' });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/too large/);
  });

  it('a file exactly at the size limit is still searched', async () => {
    const content = 'x'.repeat(MAX_FILE_BYTES - 40) + `\n${QUOTE}\n`;
    await put('src/big.ts', content.slice(0, MAX_FILE_BYTES));
    const result = await verify({ file: 'src/big.ts', line: 2 });
    expect(result.verified).toBe(true);
  });

  it('a quote with too many lines is rejected', async () => {
    await put('src/auth.ts', sourceFile(100, {}));
    const quote = Array.from({ length: MAX_QUOTE_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
    const result = await verify({ evidence_quote: quote });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/quote too large/);
  });

  it('a quote with too many characters is rejected', async () => {
    await put('src/auth.ts', sourceFile(100, {}));
    const result = await verify({ evidence_quote: 'q'.repeat(MAX_QUOTE_CHARS + 1) });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/quote too large/);
  });

  it('a non-string quote is rejected instead of throwing', async () => {
    await put('src/auth.ts', sourceFile(100, {}));
    const result = await verify({ evidence_quote: undefined as unknown as string });
    expect(result.verified).toBe(false);
  });

  it('does not modify the finding it receives', async () => {
    await put('src/auth.ts', sourceFile(300, { 42: QUOTE }));
    const input = Object.freeze(finding({ line: 40 }));
    const before = { ...input };
    const result = await verifyFinding(root, input);
    expect(result.correctedFinding).not.toBe(input);
    expect(input).toEqual(before);
    expect(result.correctedFinding?.line).toBe(42);
  });

  it('rejects a path that reaches outside the root through a symlinked directory', async (ctx) => {
    const outside = path.join(sandbox, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.ts'), `${QUOTE}\n`, 'utf8');
    try {
      // A junction works without privileges on Windows; elsewhere it is an ordinary directory link.
      await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      ctx.skip(`this OS refused to create a directory link (${(error as Error).message})`);
      return;
    }
    const result = await verify({ file: 'linked/secret.ts', line: 1 });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/invalid path/);
    expect(normalizePath(root, 'linked/secret.ts')).toBeNull();
    // A file that does not exist yet under the linked directory is also refused.
    expect(normalizePath(root, 'linked/new.ts')).toBeNull();
  });

  it('rejects a symlinked file that points outside the root', async (ctx) => {
    const outside = path.join(sandbox, 'outside-file.ts');
    await writeFile(outside, `${QUOTE}\n`, 'utf8');
    try {
      await symlink(outside, path.join(root, 'link.ts'), 'file');
    } catch (error) {
      // On Windows a file symlink needs Developer Mode or elevation, so this commonly cannot run.
      ctx.skip(`this OS refused to create a file symlink (${(error as Error).message})`);
      return;
    }
    const result = await verify({ file: 'link.ts', line: 1 });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/invalid path/);
  });

  it('accepts a symlink that stays inside the root', async (ctx) => {
    await put('real/auth.ts', sourceFile(60, { 42: QUOTE }));
    try {
      await symlink(path.join(root, 'real'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      ctx.skip(`this OS refused to create a directory link (${(error as Error).message})`);
      return;
    }
    const result = await verify({ file: 'alias/auth.ts', line: 42 });
    expect(result.verified).toBe(true);
  });
});

describe('normalizePath', () => {
  it('returns the absolute path for a plain relative path', () => {
    expect(normalizePath(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(normalizePath(root, 'src\\a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(normalizePath(root, '  src/a.ts \t')).toBe(path.join(root, 'src', 'a.ts'));
    expect(normalizePath(root, 'src/dir with spaces/a.ts')).toBe(
      path.join(root, 'src', 'dir with spaces', 'a.ts'),
    );
  });

  it('allows a .. that stays inside the root', () => {
    expect(normalizePath(root, 'src/../lib/a.ts')).toBe(path.join(root, 'lib', 'a.ts'));
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '  \t '],
    ['the root itself', '.'],
    ['POSIX absolute', '/etc/passwd'],
    ['Windows drive', 'C:\\Windows\\win.ini'],
    ['Windows drive, forward slashes', 'C:/Windows/win.ini'],
    ['UNC', '\\\\host\\share\\x.ts'],
    ['UNC with forward slashes', '//host/share/x.ts'],
    ['device namespace', '\\\\?\\C:\\x.ts'],
    ['NUL byte', 'src/a.ts\0.png'],
    ['parent escape', '../x.ts'],
    ['nested parent escape', 'src/../../x.ts'],
    ['parent escape with backslashes', '..\\..\\x.ts'],
    ['URL scheme', 'file:///etc/passwd'],
    ['http URL', 'http://example.com/a.ts'],
    ['alternate data stream', 'src/a.ts:hidden'],
    ['dots and spaces segment', 'src/.. /x.ts'],
    ['three dots segment', 'src/.../x.ts'],
  ])('rejects %s', (_name, input) => {
    expect(normalizePath(root, input)).toBeNull();
  });

  it('strips control characters instead of letting them hide a segment', () => {
    expect(normalizePath(root, 'src/\u0007a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(normalizePath(root, '.\u0001./x.ts')).toBeNull();
  });

  it('never URL-decodes', () => {
    expect(normalizePath(root, 'src/%2e%2e/a.ts')).toBe(path.join(root, 'src', '%2e%2e', 'a.ts'));
    expect(normalizePath(root, '%2e%2e/a.ts')).toBe(path.join(root, '%2e%2e', 'a.ts'));
  });

  it('returns null when the root does not exist', () => {
    expect(normalizePath(path.join(sandbox, 'nope'), 'a.ts')).toBeNull();
  });

  it('compares case-insensitively only on Windows', async () => {
    await mkdir(path.join(root, 'Src'));
    const spelled = root.slice(0, -1) + root.slice(-1).toUpperCase();
    // A differently-cased spelling of the same root must still count as inside it.
    if (process.platform === 'win32') {
      expect(normalizePath(spelled, 'Src/a.ts')).not.toBeNull();
    } else {
      expect(normalizePath(root, 'Src/a.ts')).toBe(path.join(root, 'Src', 'a.ts'));
    }
  });
});

describe('normalizeQuote', () => {
  it('converts CRLF and CR to LF and drops edge blank lines', () => {
    expect(normalizeQuote('a\r\nb\rc\r\n')).toBe('a\nb\nc');
    expect(normalizeQuote('\n\n  a\n\n')).toBe('a');
  });

  it('trims trailing whitespace, turns tabs into two spaces, collapses interior runs', () => {
    expect(normalizeQuote('a   b \t ')).toBe('a b');
    expect(normalizeQuote('\tx')).toBe('x');
    expect(normalizeQuote('a\t\tb')).toBe('a b');
  });

  it('strips only the indentation common to all non-empty lines', () => {
    expect(normalizeQuote('    if (a) {\n      b();\n    }')).toBe('if (a) {\n  b();\n}');
    expect(normalizeQuote('  a\n\n    b')).toBe('a\n\n  b');
  });

  it('keeps empty input empty', () => {
    expect(normalizeQuote('')).toBe('');
    expect(normalizeQuote(' \t\r\n ')).toBe('');
  });
});

describe('levenshtein and calculateSimilarity', () => {
  it('computes the edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('flaw', 'lawn')).toBe(2);
  });

  it('gives up early above the bound', () => {
    expect(levenshtein('aaaaaaaaaa', 'bbbbbbbbbb', 3)).toBeGreaterThan(3);
    expect(levenshtein('abc', 'abd', 3)).toBe(1);
    expect(levenshtein('a', 'aaaaaaaa', 2)).toBeGreaterThan(2);
  });

  it('is 1 - distance / longest length', () => {
    expect(calculateSimilarity('abcd', 'abxd')).toBeCloseTo(0.75, 12);
    expect(calculateSimilarity('', '')).toBe(1);
    expect(calculateSimilarity('abc', '')).toBe(0);
  });
});

describe('lines helpers', () => {
  it('splits CRLF, CR and LF and ignores one final terminator', () => {
    expect(splitLines('a\r\nb\rc\nd\n')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('computes the window', () => {
    expect(localWindow(42, 300)).toEqual({ first: 32, last: 52 });
    expect(localWindow(3, 300)).toEqual({ first: 1, last: 13 });
    expect(localWindow(298, 300)).toEqual({ first: 288, last: 300 });
    expect(localWindow(5200, 300)).toBeNull();
    expect(localWindow(0, 300)).toBeNull();
    expect(localWindow(Number.NaN, 300)).toBeNull();
    expect(isCitableLine(1)).toBe(true);
    expect(isCitableLine(1.5)).toBe(false);
  });
});
