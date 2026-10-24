import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Finding } from '../../src/types/index.js';
import { verifyFinding, MAX_FILE_BYTES } from '../../src/verifier/index.js';
import { fastest } from '../helpers/timing.js';
import { isCitableLine, localWindow, splitLines } from '../../src/verifier/lines.js';
import { normalizePath } from '../../src/verifier/path.js';
import {
  FUZZY,
  MAX_LINE,
  MAX_QUOTE_CHARS,
  MAX_QUOTE_LINES,
  MAX_RAW_QUOTE,
  MIN_ALNUM,
  WORK_BUDGET,
  WorkBudget,
  BudgetExceeded,
  calculateSimilarity,
  findQuote,
  levenshtein,
  normalizeQuote,
} from '../../src/verifier/quote.js';
import {
  sameIdentifier,
  semanticDifference,
  semanticTokens,
} from '../../src/verifier/semantic.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/sources', import.meta.url));
const QUOTE = 'if (!user.token) return false;';

let sandbox: string;
let root: string;

beforeEach(async () => {
  // The real path: normalizePath returns real paths, and a temp dir may be a short or aliased name.
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 'quorum-verifier-')));
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

describe('diff marker round 2', () => {
  it.each(['--count;', '-value;', '-1,', '- item', '-[a-z]'])('preserves real minus code %s', async code => {
    await put('src/auth.ts', code);
    const result = await verify({ line: 1, evidence_quote: code });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe(code);
  });

  it.each(['404: return notFound();', '12: true', '12 | value', 'src/auth.ts:12: true'])('preserves real numeric/pathed code %s', async code => {
    await put('src/auth.ts', code);
    const result = await verify({ line: 1, evidence_quote: code });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe(code);
    expect(result.correctedFinding?.verification_note).toBeUndefined();
  });

  it('strips plus-space and context markers without changing relative indentation', async () => {
    const code = 'const x = 1;\nif (x) return x;';
    await put('src/auth.ts', code);
    const result = await verify({ line: 1, evidence_quote: '+ const x = 1;\n if (x) return x;' });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe(code);
    expect(result.correctedFinding?.verification_note).not.toContain('fuzzy');
  });

  it.each(['+ ', '  '])('prefers real indentation over stripping another space: %j', async prefix => {
    const code = ' const x = 1;\nif (x) return x;';
    await put('src/auth.ts', code);
    const result = await verify({ line: 1, evidence_quote: `${prefix}const x = 1;\n+if (x) return x;` });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe(code);
  });

  it('preserves a real context line even when its unindented candidate exists', async () => {
    const code = ' const x = 1;\nif (x) return x;';
    await put('src/auth.ts', `${code}\nconst x = 1;`);
    const result = await verify({ line: 1, evidence_quote: ' const x = 1;\n+if (x) return x;' });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe(code);
  });

  it.each([
    ['src\\auth.ts', 'src/auth.ts:12: '],
    ['src/auth.ts', 'src\\auth.ts:12: '],
  ])('normalizes path separators for %s and %s', async (file, prefix) => {
    await put('src/auth.ts', QUOTE);
    const result = await verify({ file, line: 1, evidence_quote: prefix + QUOTE });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe(QUOTE);
  });

  it('excludes hunk metadata and numbered prefixes from the retained-code ratio', async () => {
    await put('src/auth.ts', 'return currentValue;');
    const result = await verify({ line: 1, evidence_quote: '@@ -123456,1 +123456,1 @@\n-src/auth.ts:12: old();\n+src/auth.ts:12: return currentValue;' });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe('return currentValue;');
  });

  it('stores the code at the match even when a comment elsewhere contains the raw quote', async () => {
    await put('src/auth.ts', `const value = 1;\n// +const value = 1;`);
    const result = await verify({ line: 1, evidence_quote: '+const value = 1;' });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(1);
    expect(result.correctedFinding?.evidence_quote).toBe('const value = 1;');
  });

  it('rejects fabricated added code', async () => {
    await put('src/auth.ts', 'return actualValue;');
    expect((await verify({ line: 1, evidence_quote: '+return fabricatedValue;' })).verified).toBe(false);
  });

  it('keeps real minus and plus lines together', async () => {
    const code = '-value;\n+value;';
    await put('src/auth.ts', code);
    const result = await verify({ line: 1, evidence_quote: code });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe(code);
  });

  it.each(['0005: ', 'src/auth.ts:12: '])('stores clean code from prompt prefix %s', async prefix => {
    await put('src/auth.ts', QUOTE);
    const result = await verify({ line: 1, evidence_quote: prefix + QUOTE });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe(QUOTE);
  });

  it('scales 50 findings from 0.5 MiB to 2 MiB below eightfold', async () => {
    const run = async () => {
      for (let i = 0; i < 50; i++) {
        const result = await verify({ line: 1, evidence_quote: '+const value = 1;' });
        expect(result.verified).toBe(true);
      }
    };
    const measure = async (bytes: number) => {
      const head = 'const value = 1;\n';
      const filler = '// padding for timing\n';
      await put('src/auth.ts', head + filler.repeat(Math.floor((bytes - head.length) / filler.length)));
      return fastest(run);
    };
    const smallMs = await measure(MAX_FILE_BYTES / 4);
    const largeMs = await measure(MAX_FILE_BYTES);
    expect(largeMs / Math.max(smallMs, 1)).toBeLessThan(8);
    expect(largeMs).toBeLessThan(10_000);
  });
});

describe('quotes copied from diff and numbered prompts', () => {
  const samples = [
    "const isAdmin = user.role === 'admin';\nif (isAdmin) throw new Error('Forbidden');",
    'store.save(profile).catch(() => {});\nreturn { saved: true };',
    'return read(path.join(root, name));',
    'return /^([a-z]+)+(-[a-z]+)*$/.test(value);',
    "setInterval(() => progress('waiting'), 1000);",
  ];
  it.each(samples.flatMap(code => ['+', '+ '].map(prefix => ({ code, prefix }))))('verifies $prefix $code', async ({ code, prefix }) => {
    await put('src/auth.ts', code);
    const evidence_quote = code.split('\n').map(line => prefix + line).join('\n');
    const result = await verify({ line: 1, evidence_quote });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe(code);
    expect(result.correctedFinding?.verification_note).toContain('stripped diff markers from the quote');
  });
  it.each(['123: ', '0001: ', '123 | ', 'src/auth.ts:1: ', ' '])('accepts the prefix %j', async prefix => {
    await put('src/auth.ts', samples[0]!);
    const result = await verify({ line: 1, evidence_quote: '@@ -1,2 +1,2 @@\n' + samples[0]!.split('\n').map(line => prefix + line).join('\n') });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.verification_note).toContain('stripped diff markers from the quote');
  });
  it('rejects removed-only evidence even when HEAD contains the same code', async () => {
    await put('src/auth.ts', samples[0]!);
    const result = await verify({ line: 1, evidence_quote: samples[0]!.split('\n').map(line => '-' + line).join('\n') });
    expect(result).toMatchObject({ verified: false, reason: 'quote is removed code from the diff' });
  });
  it.each([true, false])('requires 60 percent retained evidence (enough: %s)', async enough => {
    const code = 'return read(path.join(root, name));';
    await put('src/auth.ts', code);
    const result = await verify({ line: 1, evidence_quote: `-${enough ? 'old();' : 'removedCallWithManyMoreCharactersThanTheRemainingEvidence();'}\n+${code}` });
    expect(result.verified).toBe(enough);
  });
  // Six kept code characters: 6 / (6 + 4) is 60%; diff markers are metadata.
  it.each([['abcd', true], ['abcde', false]] as const)('checks the inclusive 60 percent boundary: %s', async (removed, accepted) => {
    await put('src/auth.ts', 'abcdef');
    expect((await verify({ line: 1, evidence_quote: `-${removed}\n+abcdef` })).verified).toBe(accepted);
  });
  it.each([
    ['a + b', '+ a - b'],
    ['return (alpha + beta) * gamma;', '+return alpha + beta * gamma;'],
    ['return !value;', '+return value;'],
    ['return a + b;', 'return a - b;'],
  ])('keeps semantic differences significant: %s / %s', async (code, evidence_quote) => {
    await put('src/auth.ts', code);
    expect((await verify({ line: 1, evidence_quote })).verified).toBe(false);
  });
  it.each(['+value', '++value', '+ +value'])('preserves a leading unary plus: %s', async evidence_quote => {
    await put('src/auth.ts', '+value');
    expect((await verify({ line: 1, evidence_quote })).verified).toBe(true);
  });
  it('preserves plus operators inside code and handles markers per line', async () => {
    const code = '+value;\nx++;\nconst sign = "+";\nreturn a + b;';
    await put('src/auth.ts', code);
    expect((await verify({ line: 1, evidence_quote: '+value;\n+x++;\n const sign = "+";\n+ return a + b;' })).verified).toBe(true);
  });
});

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

  it('an unusable cited line never resolves a duplicate by distance or by line number', async () => {
    await put('src/dup.ts', sourceFile(60, { 12: 'return null;', 30: 'return null;' }));
    const result = await verify({ file: 'src/dup.ts', line: Number.NaN, evidence_quote: 'return null;' });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/ambiguous: matches 2 places/);
    expect(result.correctedFinding).toBeUndefined();
  });

  it('a directory is rejected', async () => {
    await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
    const result = await verify({ file: 'src/lib', line: 1 });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/directory/);
  });

  it('a file over the size limit is rejected without being read', async () => {
    await put('src/big.ts', 'a'.repeat(MAX_FILE_BYTES + 1));
    const result = await verify({ file: 'src/big.ts', line: 1, evidence_quote: QUOTE });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/too large/);
  });

  it('a file of exactly MAX_FILE_BYTES is searched, one byte more is rejected', async () => {
    // Short lines, so the size limit and not the line limit is what is being tested.
    const tail = `\n${QUOTE}\n`;
    const filler = 'x'.repeat(100) + '\n';
    const rows = Math.floor((MAX_FILE_BYTES - tail.length) / filler.length);
    const rest = MAX_FILE_BYTES - tail.length - rows * filler.length;
    const content = filler.repeat(rows) + 'y'.repeat(rest) + tail;
    expect(Buffer.byteLength(content)).toBe(MAX_FILE_BYTES);
    await put('src/limit.ts', content);
    const at = await verify({ file: 'src/limit.ts', line: splitLines(content).length });
    expect(at.verified).toBe(true);

    await put('src/over.ts', `${content}z`);
    expect(Buffer.byteLength(`${content}z`)).toBe(MAX_FILE_BYTES + 1);
    const over = await verify({ file: 'src/over.ts', line: 1 });
    expect(over.verified).toBe(false);
    expect(over.reason).toMatch(/too large/);
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

describe('M1 fix 1: a fuzzy match must not flip the meaning', () => {
  // The file holds `code`; the model quoted `quoted`. Both are close enough to be located.
  async function against(code: string, quoted: string, over: Partial<Finding> = {}) {
    await put('src/sem.ts', sourceFile(60, { 30: code }));
    expect(calculateSimilarity(quoted, code)).toBeGreaterThanOrEqual(FUZZY);
    return verify({ file: 'src/sem.ts', line: 30, evidence_quote: quoted, ...over });
  }

  it('negation removed (0.97 similar) is rejected and names the token', async () => {
    const result = await against('if (!user.token) return false;', 'if (user.token) return false;');
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/changes the meaning of the quote/);
    expect(result.reason).toContain('the code has "!" that the quote does not');
    expect(result.reason).toContain('found in code: "if (!user.token) return false;"');
    expect(result.correctedFinding).toBeUndefined();
  });

  it('negation added is rejected', async () => {
    const result = await against('if (user.token) return false;', 'if (!user.token) return false;');
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('the quote has "!" that the code does not');
  });

  it('true and false swapped (0.87 similar) is rejected', async () => {
    const result = await against('if (!user.token) return false;', 'if (!user.token) return true;');
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('the quote has "true" where the code has "false"');
  });

  it('=== against !== is rejected', async () => {
    const result = await against(
      'if (a.id === b.id) return found(a);',
      'if (a.id !== b.id) return found(a);',
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('the quote has "!==" where the code has "==="');
  });

  it('a changed number is rejected', async () => {
    const result = await against('const retries = 3;', 'const retries = 5;');
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('the quote has "5" where the code has "3"');
  });

  it('a changed string literal is rejected', async () => {
    const result = await against("const mode = 'strict';", "const mode = 'script';");
    expect(result.verified).toBe(false);
    expect(result.reason).toContain(
      "the quote has the string 'script' where the code has the string 'strict'",
    );
  });

  it('a changed comparison, arithmetic or logical operator is rejected', async () => {
    const pairs = [
      ['if (count < limit) retry(job);', 'if (count > limit) retry(job);'],
      ['total = price + fee + tax;', 'total = price - fee + tax;'],
      ['if (a && b) save(item);', 'if (a || b) save(item);'],
      ['count += 1;', 'count -= 1;'],
    ] as const;
    for (const [code, quoted] of pairs) {
      const result = await against(code, quoted);
      expect(result.verified, quoted).toBe(false);
      expect(result.reason, quoted).toMatch(/changes the meaning/);
    }
  });

  it('an identifier typo still verifies, and the note carries both texts', async () => {
    const code = 'total = price * (1 + TAX_RATIO)';
    const quoted = 'total = price * (1 + TAX_RATE)';
    await put('src/pay.ts', sourceFile(40, { 15: code }));
    const result = await verify({ file: 'src/pay.ts', line: 15, evidence_quote: quoted });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.evidence_quote).toBe(quoted);
    expect(result.correctedFinding?.verification_note).toContain(`found in code: "${code}"`);
  });

  it('a typo in a name next to a string and a number still verifies', async () => {
    const result = await against(
      "const limit = Math.min(requestCount, 100); // 'max'",
      "const limit = Math.min(requestCnt, 100); // 'max'",
    );
    expect(result.verified).toBe(true);
  });

  it('a local fuzzy match that changes the meaning is not replaced by an exact one far away', async () => {
    await put(
      'src/sem.ts',
      sourceFile(300, { 12: 'if (!user.token) return false;', 200: 'if (user.token) return false;' }),
    );
    const result = await verify({
      file: 'src/sem.ts',
      line: 10,
      evidence_quote: 'if (user.token) return false;',
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/changes the meaning/);
  });

  it('a global fuzzy match is held to the same rule', async () => {
    await put('src/sem.ts', sourceFile(300, { 200: 'if (!user.token) return false;' }));
    const result = await verify({
      file: 'src/sem.ts',
      line: 5000,
      evidence_quote: 'if (user.token) return false;',
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/changes the meaning/);
  });
});

describe('semantic tokens', () => {
  it('keeps identifiers, operators, grouping, negation, truth words, numbers and strings', () => {
    expect(semanticTokens('if (!user.token) return false;')).toEqual([
      'word:if',
      'punctuation:(',
      'operator:!',
      'ident:user',
      'ident:token',
      'punctuation:)',
      'word:return',
      'word:false',
    ]);
    expect(semanticTokens('a !== b ?? c => 0x1F + 1_000 - 2.5e3')).toEqual([
      'ident:a',
      'operator:!==',
      'ident:b',
      'operator:??',
      'ident:c',
      'operator:=>',
      'number:0x1f',
      'operator:+',
      'number:1000',
      'operator:-',
      'number:2.5e3',
    ]);
    // The delimiter of a string is part of the token.
    expect(semanticTokens('x = "a" + \'b\'')).toEqual([
      'ident:x',
      'operator:=',
      'string:"a"',
      'operator:+',
      "string:'b'",
    ]);
  });

  it('matches words whole and case-insensitively', () => {
    expect(semanticTokens('notify(nothing); isNull; returnValue')).toEqual([
      'ident:notify',
      'punctuation:(',
      'ident:nothing',
      'punctuation:)',
      'ident:isNull',
      'ident:returnValue',
    ]);
    expect(semanticTokens('if x is None: return True')).toEqual([
      'word:if',
      'ident:x',
      'ident:is',
      'word:none',
      'punctuation::',
      'word:return',
      'word:true',
    ]);
  });

  it('ignores a typo in an identifier, number separators and ordinary quote style', () => {
    expect(semanticDifference('a = fooBar + 1_000;', 'a = fooBaz + 1000;')).toBeNull();
    expect(semanticDifference("x = 'same'", 'x = "same"')).toBeNull();
  });

  it('names the first token that differs', () => {
    expect(semanticDifference('return a;', 'return !a;')).toBe('the code has "!" that the quote does not');
    expect(semanticDifference('return !a;', 'return a;')).toBe('the quote has "!" that the code does not');
    expect(semanticDifference('if (a) x', 'if (a) x; else y')).toBe(
      'the code has "else" that the quote does not',
    );
    expect(semanticDifference('a < b', 'a > b')).toBe('the quote has "<" where the code has ">"');
  });

  it('is linear on a long, hostile text', () => {
    const hostile = `${"'".repeat(1000)}${'"'.repeat(1000)}${'`'.repeat(1000)}${'1'.repeat(8000)}`;
    const started = performance.now();
    semanticTokens(hostile);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('M1 fix 2: trivial or out-of-context evidence', () => {
  it.each(['}', '});', ';', ')', '  {  ', 'abc', '=> {}'])(
    'rejects the trivial quote %j',
    async (quote) => {
      await put('src/auth.ts', sourceFile(100, { 42: '  }' }));
      const result = await verify({ line: 42, evidence_quote: quote });
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/too short/);
      expect(result.correctedFinding).toBeUndefined();
    },
  );

  it('accepts a quote of exactly MIN_ALNUM letters or digits', async () => {
    expect(MIN_ALNUM).toBe(4);
    await put('src/auth.ts', sourceFile(100, { 42: 'abcd();' }));
    const result = await verify({ line: 42, evidence_quote: 'abcd();' });
    expect(result.verified).toBe(true);
  });

  it('counts letters and digits of any script after normalization', async () => {
    await put('src/auth.ts', sourceFile(100, { 42: '// ключ' }));
    expect((await verify({ line: 42, evidence_quote: '//   ключ' })).verified).toBe(true);
  });

  describe('a match outside the window is corrected only when it is the only one', () => {
    const twoFunctions = sourceFile(300, {
      10: 'function a() {',
      11: '  return false;',
      30: 'function b() {',
      31: '  return false;',
    });

    it('rejects `return false;` cited at line 5000 when it appears in two functions', async () => {
      await put('src/two.ts', twoFunctions);
      const result = await verify({ file: 'src/two.ts', line: 5000, evidence_quote: 'return false;' });
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/^ambiguous: matches 2 places/);
      expect(result.correctedFinding).toBeUndefined();
    });

    it('rejects it when the cited line is inside the file but near neither copy', async () => {
      await put('src/two.ts', twoFunctions);
      const result = await verify({ file: 'src/two.ts', line: 200, evidence_quote: 'return false;' });
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/ambiguous: matches 2 places/);
    });

    it('still takes the nearest copy inside the window', async () => {
      await put('src/two.ts', twoFunctions);
      const near = await verify({ file: 'src/two.ts', line: 14, evidence_quote: 'return false;' });
      expect(near.correctedFinding?.line).toBe(11);
      const other = await verify({ file: 'src/two.ts', line: 28, evidence_quote: 'return false;' });
      expect(other.correctedFinding?.line).toBe(31);
    });

    it('still corrects a quote that appears once (row 6)', async () => {
      await put('src/one.ts', sourceFile(300, { 11: '  return false;' }));
      const result = await verify({ file: 'src/one.ts', line: 5000, evidence_quote: 'return false;' });
      expect(result.verified).toBe(true);
      expect(result.correctedFinding?.line).toBe(11);
    });

    it('counts two occurrences on one line as two places', async () => {
      await put('src/one.ts', sourceFile(300, { 11: 'return false; return false;' }));
      const result = await verify({ file: 'src/one.ts', line: 5000, evidence_quote: 'return false;' });
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/matches 2 places/);
    });

    it('treats two equally close fuzzy candidates as ambiguous, and a clear winner as unique', async () => {
      const quoted = 'compute(alpha, beta);';
      await put('src/fz.ts', sourceFile(300, { 20: 'compute(alpha, betaX);', 80: 'compute(alpha, betaY);' }));
      const tied = await verify({ file: 'src/fz.ts', line: 5000, evidence_quote: quoted });
      expect(tied.verified).toBe(false);
      expect(tied.reason).toMatch(/ambiguous: matches 2 places/);

      await put('src/fz.ts', sourceFile(300, { 20: 'compute(alpha, betaX);', 80: 'compute(alpha, betaXYZ);' }));
      expect(calculateSimilarity(quoted, 'compute(alpha, betaXYZ);')).toBeGreaterThanOrEqual(FUZZY);
      const clear = await verify({ file: 'src/fz.ts', line: 5000, evidence_quote: quoted });
      expect(clear.verified).toBe(true);
      expect(clear.correctedFinding?.line).toBe(20);
    });

    it('treats a multi-line quote that matches in shifted slices as one place', async () => {
      const lines = {
        50: 'const totla = price * qty;',
        51: 'const fee = rate * totla;',
        52: 'return totla + fee;',
      };
      await put('src/ml.ts', sourceFile(300, lines));
      const result = await verify({
        file: 'src/ml.ts',
        line: 5000,
        evidence_quote: 'const total = price * qty;\nconst fee = rate * total;\nreturn total + fee;',
      });
      expect(result.verified).toBe(true);
      expect(result.correctedFinding?.line).toBe(50);
    });
  });
});

describe('M1 fix 4: confinement holds for the read', () => {
  it('returns the real path of an existing target and the real parent plus the leaf of a missing one', async (ctx) => {
    await put('real/auth.ts', `${QUOTE}\n`);
    try {
      await symlink(
        path.join(root, 'real'),
        path.join(root, 'alias'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      ctx.skip(`this OS refused to create a directory link (${(error as Error).message})`);
      return;
    }
    expect(normalizePath(root, 'alias/auth.ts')).toBe(path.join(root, 'real', 'auth.ts'));
    expect(normalizePath(root, 'alias/new.ts')).toBe(path.join(root, 'real', 'new.ts'));
    const result = await verify({ file: 'alias/auth.ts', line: 1 });
    expect(result.verified).toBe(true);
  });

  it('rejects a missing file and a directory before reading anything', async () => {
    await mkdir(path.join(root, 'src', 'dir'), { recursive: true });
    expect((await verify({ file: 'src/dir', line: 1 })).reason).toMatch(/directory/);
    expect((await verify({ file: 'src/none.ts', line: 1 })).reason).toMatch(/file not found/);
  });
});

describe('M1 fix 5: linear normalization', () => {
  it('normalizes 40000 interior spaces in well under 100 ms', () => {
    const inputs = [
      `a${' '.repeat(40000)}b`,
      `abcd${' '.repeat(40000)}efgh`,
      `${' '.repeat(40000)}x`,
      `x${' '.repeat(40000)}`,
    ];
    for (const raw of inputs) {
      const started = performance.now();
      const normalized = normalizeQuote(raw);
      expect(performance.now() - started).toBeLessThan(100);
      expect(normalized.length).toBeLessThanOrEqual(9);
    }
    expect(normalizeQuote(`a${' '.repeat(40000)}b`)).toBe('a b');
  });

  it('normalizes a long run of tabs and mixed whitespace quickly', () => {
    const started = performance.now();
    normalizeQuote(`abcd${'\t '.repeat(20000)}efgh\n${' \t'.repeat(10000)}`);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('verifies a 40000-space quote without a stall', async () => {
    await put('src/auth.ts', sourceFile(300, { 42: 'abcd efgh' }));
    const started = performance.now();
    const result = await verify({ line: 42, evidence_quote: `abcd${' '.repeat(40000)}efgh` });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(42);
  });

  it('rejects a raw quote over 64 KiB before normalizing it', async () => {
    await put('src/auth.ts', sourceFile(100, {}));
    const huge = 'abcd'.repeat(MAX_RAW_QUOTE / 4 + 1);
    expect(huge.length).toBeGreaterThan(MAX_RAW_QUOTE);
    const result = await verify({ evidence_quote: huge });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/quote too large.*before normalization/);
    // Spaces that would normalize to something tiny are still refused: the raw size decides.
    const spaces = await verify({ evidence_quote: `abcd${' '.repeat(MAX_RAW_QUOTE)}efgh` });
    expect(spaces.verified).toBe(false);
    expect(spaces.reason).toMatch(/quote too large/);
  });

  it('skips a file line over 16 KiB instead of crashing, and still finds the quote elsewhere', async () => {
    const longLine = `${QUOTE} ${'x'.repeat(MAX_LINE)}`;
    expect(longLine.length).toBeGreaterThan(MAX_LINE);
    await put('src/long.ts', sourceFile(60, { 10: longLine }));
    const skipped = await verify({ file: 'src/long.ts', line: 10 });
    expect(skipped.verified).toBe(false);
    expect(skipped.reason).toMatch(/quote not found.*1 over-long lines were skipped/);

    await put('src/long.ts', sourceFile(60, { 10: longLine, 40: QUOTE }));
    const found = await verify({ file: 'src/long.ts', line: 10 });
    expect(found.verified).toBe(true);
    expect(found.correctedFinding?.line).toBe(40);
  });

  it('a multi-line quote never matches across an over-long line', async () => {
    const wide = `const b = ${'y'.repeat(MAX_LINE)};`;
    await put('src/long.ts', sourceFile(60, { 10: 'const a = 1;', 11: wide, 12: 'const c = 3;' }));
    const result = await verify({
      file: 'src/long.ts',
      line: 10,
      evidence_quote: `const a = 1;\n${wide}\nconst c = 3;`,
    });
    expect(result.verified).toBe(false);
  });
});

describe('M1 fix 6: bounded edit distance and a work budget', () => {
  // The plain dynamic program, as the reference.
  function reference(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= b.length; j += 1) {
        current[j] = Math.min(
          (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
          (previous[j] as number) + 1,
          (current[j - 1] as number) + 1,
        );
      }
      previous = current;
    }
    return previous[b.length] as number;
  }

  // A tiny deterministic generator, so a failure reproduces.
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  it('agrees with the plain algorithm: exact below the bound, above it otherwise', () => {
    const next = random(7);
    const word = (length: number) =>
      Array.from({ length }, () => 'abc'[Math.floor(next() * 3)]).join('');
    for (let round = 0; round < 400; round += 1) {
      const a = word(Math.floor(next() * 60));
      const b = word(Math.floor(next() * 60));
      const truth = reference(a, b);
      expect(levenshtein(a, b)).toBe(truth);
      for (const bound of [0, 1, 3, 8, 20, 100]) {
        const bounded = levenshtein(a, b, bound);
        if (truth <= bound) expect(bounded).toBe(truth);
        else expect(bounded).toBeGreaterThan(bound);
      }
    }
  });

  it('near-identical long strings cost O(length * distance), not O(length * bound)', () => {
    const a = 'a'.repeat(8192);
    const b = `${'a'.repeat(8191)}b`;
    const budget = new WorkBudget();
    expect(levenshtein(a, b, Math.floor(8192 * (1 - FUZZY)), budget)).toBe(1);
    expect(budget.used).toBeLessThan(500_000);
  });

  it('throws BudgetExceeded when the budget is spent', () => {
    const budget = new WorkBudget(1000);
    expect(() => levenshtein('a'.repeat(500), 'b'.repeat(500), 400, budget)).toThrow(BudgetExceeded);
  });

  it('findQuote reports a spent budget instead of searching on', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `const value${i} = compute(${i}, alpha, beta);`);
    const quote = 'const value5 = compute(5, alpha, gamma);';
    expect(findQuote(lines, quote, 5000, 100)).toEqual({ kind: 'budget' });
    expect(findQuote(lines, quote, 5000, WORK_BUDGET).kind).not.toBe('budget');
    // Exact scans are not charged: a verbatim quote is found even with an empty budget.
    const exact = findQuote(lines, 'const value5 = compute(5, alpha, beta);', 5000, 0);
    expect(exact.kind).toBe('match');
  });

  it('an 8192-character quote against 255 lines of 8191 "a" and a "b" finishes fast and deterministically', async () => {
    const quote = 'a'.repeat(8192);
    const line = `${'a'.repeat(8191)}b`;
    await put('src/adv.ts', `${Array.from({ length: 255 }, () => line).join('\n')}\n`);

    const started = performance.now();
    const first = await verify({ file: 'src/adv.ts', line: 5000, evidence_quote: quote });
    const elapsed = performance.now() - started;
    const second = await verify({ file: 'src/adv.ts', line: 5000, evidence_quote: quote });

    expect(elapsed).toBeLessThan(2000);
    expect(second).toEqual(first);
    expect(first.verified).toBe(false);
    expect(first.reason).toMatch(/search budget exceeded|ambiguous: matches \d+ places/);
  });

  it('the same file is resolved at once when the cited line is inside it', async () => {
    const line = `${'a'.repeat(8191)}b`;
    await put('src/adv.ts', `${Array.from({ length: 255 }, () => line).join('\n')}\n`);
    const started = performance.now();
    const result = await verify({ file: 'src/adv.ts', line: 100, evidence_quote: 'a'.repeat(8192) });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(100);
  });

  it('a large file with a long absent quote is a clean "not found", inside the budget', async () => {
    const lines = Array.from(
      { length: 20000 },
      (_, i) => `    const item${i} = items[${i}] ?? defaults.get('k${i}');`,
    );
    await put('src/big.ts', `${lines.join('\n')}\n`);
    const quote = Array.from({ length: 30 }, (_, i) => `  hallucinated(${i}, 'never in the file');`).join('\n');
    const started = performance.now();
    const result = await verify({ file: 'src/big.ts', line: 10, evidence_quote: quote });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/quote not found/);
  });
});

describe('M1 final round fix 1: the full token sequence is compared', () => {
  // The file holds `code`; the model quoted `quoted`. Both are close enough to be located.
  async function against(code: string, quoted: string) {
    await put('src/sem.ts', sourceFile(60, { 30: code }));
    expect(calculateSimilarity(quoted, code)).toBeGreaterThanOrEqual(FUZZY);
    return verify({ file: 'src/sem.ts', line: 30, evidence_quote: quoted });
  }

  it('swapped operands are rejected and the reason names the token', async () => {
    const result = await against('if (a < b) return false;', 'if (b < a) return false;');
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/changes the meaning of the quote/);
    expect(result.reason).toContain(
      'the quote has the identifier "b" where the code has the identifier "a"',
    );
    expect(result.reason).toContain('found in code: "if (a < b) return false;"');
    expect(result.correctedFinding).toBeUndefined();
  });

  it('the same comparison with the operands in place verifies', async () => {
    const result = await against('if (a < b) return false;', 'if (a < b) return false;');
    expect(result.verified).toBe(true);
  });

  it('swapped arguments of a longer call are rejected', async () => {
    const result = await against(
      'const moved = copyFile(src, dst, options.overwrite);',
      'const moved = copyFile(dst, src, options.overwrite);',
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain(
      'the quote has the identifier "dst" where the code has the identifier "src"',
    );
  });

  it('short identifiers must match exactly: id is not ip', async () => {
    const result = await against(
      'const owner = lookup(user.id, session);',
      'const owner = lookup(user.ip, session);',
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain(
      'the quote has the identifier "ip" where the code has the identifier "id"',
    );
  });

  it('user is not users, and item1 is not item2', async () => {
    const plural = await against(
      'if (users.length > limit) notify(owner);',
      'if (user.length > limit) notify(owner);',
    );
    expect(plural.verified).toBe(false);
    expect(plural.reason).toContain('"user" where the code has the identifier "users"');

    const numbered = await against(
      'const merged = join(item1, item2, separator);',
      'const merged = join(item1, item1, separator);',
    );
    expect(numbered.verified).toBe(false);
    expect(numbered.reason).toContain('"item1" where the code has the identifier "item2"');
  });

  it('a typo in a long identifier still verifies, also when it is two edits long', async () => {
    const result = await against('total = price * (1 + TAX_RATIO)', 'total = price * (1 + TAX_RATE)');
    expect(result.verified).toBe(true);
  });

  it('a different word in place of an identifier is rejected', async () => {
    const result = await against(
      'const label = format(order.customer, locale);',
      'const label = format(order.supplier, locale);',
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain(
      'the quote has the identifier "supplier" where the code has the identifier "customer"',
    );
  });

  it('an identifier typo next to a changed operator is still rejected for the operator', async () => {
    const result = await against(
      'if (retryCount < limit) retry(job);',
      'if (retryCnt > limit) retry(job);',
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('the quote has ">" where the code has "<"');
  });

  describe('sameIdentifier', () => {
    it.each([
      ['TAX_RATE', 'TAX_RATIO', true],
      ['requestCount', 'requestCnt', true],
      ['total', 'totla', true],
      ['token', 'token', true],
      ['token', 'taken', true],
      ['a', 'b', false],
      ['id', 'ip', false],
      ['abc', 'abd', false],
      ['data', 'date', false],
      ['user', 'users', false],
      ['item1', 'item2', false],
      ['userName', 'userMail', false],
      ['oldValue', 'newValue', false],
    ])('%s and %s: %s', (quoted, real, expected) => {
      expect(sameIdentifier(quoted, real)).toBe(expected);
      expect(sameIdentifier(real, quoted)).toBe(expected);
    });
  });
});

describe('M1 final round fix 2: strings keep their delimiter, templates are code', () => {
  const body = 'Hello ${user.name}, welcome back';
  const DELIMITERS = ['"', "'", '`'] as const;
  const swaps = DELIMITERS.flatMap((codeDelimiter) =>
    DELIMITERS.filter((quoteDelimiter) => quoteDelimiter !== codeDelimiter).map(
      (quoteDelimiter) => [codeDelimiter, quoteDelimiter] as const,
    ),
  );
  const describeString = (delimiter: string): string =>
    delimiter === '`' ? 'a template literal' : `the string ${delimiter}${body}${delimiter}`;

  async function against(code: string, quoted: string) {
    await put('src/tpl.ts', sourceFile(60, { 30: code }));
    expect(calculateSimilarity(quoted, code)).toBeGreaterThanOrEqual(FUZZY);
    return verify({ file: 'src/tpl.ts', line: 30, evidence_quote: quoted });
  }

  it('the reviewer case: a double-quoted string is not the template literal', async () => {
    const result = await against('`Hello ${user.name}`;', '"Hello ${user.name}";');
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/changes the meaning of the quote/);
    expect(result.reason).toContain(
      'the quote has the string "Hello ${user.name}" where the code has a template literal',
    );
    expect(result.correctedFinding).toBeUndefined();
  });

  it.each(swaps)(
    'code delimited by %s and a quote delimited by %s preserves string semantics',
    async (codeDelimiter, quoteDelimiter) => {
      const result = await against(
        `const greeting = ${codeDelimiter}${body}${codeDelimiter};`,
        `const greeting = ${quoteDelimiter}${body}${quoteDelimiter};`,
      );
      if (codeDelimiter !== '`' && quoteDelimiter !== '`') {
        expect(result.verified).toBe(true);
        return;
      }
      expect(result.verified).toBe(false);
      expect(result.reason).toContain(
        `the quote has ${describeString(quoteDelimiter)} where the code has ${describeString(codeDelimiter)}`,
      );
    },
  );

  it('the same delimiter verifies, and a typo in a name inside ${...} is tolerated', async () => {
    const result = await against(
      'const label = `Hello ${customer.name}, welcome`;',
      'const label = `Hello ${custmer.name}, welcome`;',
    );
    expect(result.verified).toBe(true);
  });

  it('an operator inside ${...} is compared as code', async () => {
    const result = await against(
      'const line = `Total: ${price + tax} EUR`;',
      'const line = `Total: ${price - tax} EUR`;',
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('the quote has "-" where the code has "+"');
  });

  it('a name inside ${...} is compared as code', async () => {
    const result = await against(
      'const label = `Hello ${user.email}, welcome back`;',
      'const label = `Hello ${user.name}, welcome back`;',
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain(
      'the quote has the identifier "name" where the code has the identifier "email"',
    );
  });

  it('the text of a template is compared as a string', async () => {
    const result = await against(
      'const label = `Hello ${user.name}, welcome back`;',
      'const label = `Hullo ${user.name}, welcome back`;',
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain(
      'the quote has the template text "Hullo " where the code has the template text "Hello "',
    );
  });

  it('tokenizes a template as code between its text', () => {
    expect(semanticTokens('`a${x}b`')).toEqual([
      'template:open',
      'string:`a',
      'template:expression-open',
      'ident:x',
      'template:expression-close',
      'string:`b',
      'template:close',
    ]);
    // Braces inside an expression do not end it, and a template can nest.
    expect(semanticTokens('`${fn({ a: 1 })} end`')).toEqual([
      'template:open',
      'template:expression-open',
      'ident:fn', 'punctuation:(', 'punctuation:{',
      'ident:a', 'punctuation::',
      'number:1', 'punctuation:}', 'punctuation:)',
      'template:expression-close',
      'string:` end',
      'template:close',
    ]);
    expect(semanticTokens('`<li>${items.map((i) => `<${i}>`)}</li>`')).toEqual([
      'template:open',
      'string:`<li>',
      'template:expression-open',
      'ident:items',
      'ident:map',
      'punctuation:(', 'punctuation:(', 'ident:i', 'punctuation:)',
      'operator:=>',
      'template:open',
      'string:`<',
      'template:expression-open',
      'ident:i',
      'template:expression-close',
      'string:`>',
      'template:close',
      'punctuation:)',
      'template:expression-close',
      'string:`</li>',
      'template:close',
    ]);
  });

  it('an unterminated string or template does not hang and keeps what it read', () => {
    expect(semanticTokens("name = 'unterminated")).toEqual([
      'ident:name',
      'operator:=',
      "string:'unterminated'",
    ]);
    expect(semanticTokens('x = `open ${a')).toEqual([
      'ident:x',
      'operator:=',
      'template:open',
      'string:`open ',
      'template:expression-open',
      'ident:a',
    ]);
  });

  it('is linear on deeply nested and unterminated templates', () => {
    const nested = `${'`${'.repeat(5000)}x${'}`'.repeat(5000)}`;
    const unterminated = `${"'\\".repeat(5000)}${'`\\${'.repeat(2000)}`;
    const started = performance.now();
    semanticTokens(nested);
    semanticTokens(unterminated);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('M1 final round fix 4: a short quote counts only on its cited line', () => {
  const place = async (code: string, line = 30) =>
    put('src/short.ts', sourceFile(60, { [line]: code }));

  it.each([
    ['x++;', '  x++;'],
    ['a=b;', '    a=b;'],
    ['foo();', 'foo();'],
    ['<div>', '  <div>'],
    ['i--', 'while (i--) {'],
  ])('%j verifies exactly on the cited line', async (quoted, code) => {
    await place(code);
    const result = await verify({ file: 'src/short.ts', line: 30, evidence_quote: quoted });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(30);
    expect(result.correctedFinding?.verified).toBe(true);
    expect(result.correctedFinding?.verification_note).toBeUndefined();
  });

  it('a fragment of the cited line verifies', async () => {
    await place('for (;;) { x++; }');
    const result = await verify({ file: 'src/short.ts', line: 30, evidence_quote: 'x++;' });
    expect(result.verified).toBe(true);
  });

  it.each([29, 31, 25, 40, 5000, 0, -1, Number.NaN, 30.5])(
    'the same x++; cited at line %s is rejected, not corrected',
    async (line) => {
      await place('  x++;');
      const result = await verify({ file: 'src/short.ts', line, evidence_quote: 'x++;' });
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/too short/);
      expect(result.reason).toMatch(/does not appear on line/);
      expect(result.correctedFinding).toBeUndefined();
    },
  );

  it('a closing brace is rejected even on its own line', async () => {
    await place('  }');
    for (const quoted of ['}', '  }  ', '});', '];', ')']) {
      const result = await verify({ file: 'src/short.ts', line: 30, evidence_quote: quoted });
      expect(result.verified, quoted).toBe(false);
      expect(result.reason, quoted).toMatch(/too short/);
    }
  });

  it('is never fuzzy: x++; is not x += 1;', async () => {
    await place('  x += 1;');
    const result = await verify({ file: 'src/short.ts', line: 30, evidence_quote: 'x++;' });
    expect(result.verified).toBe(false);
  });

  it('does not match inside an identifier: x++; is not max++;', async () => {
    await place('  max++;');
    const result = await verify({ file: 'src/short.ts', line: 30, evidence_quote: 'x++;' });
    expect(result.verified).toBe(false);
    await place('  obj.x++;');
    const member = await verify({ file: 'src/short.ts', line: 30, evidence_quote: 'x++;' });
    expect(member.verified).toBe(true);
  });

  it('is not searched globally: the file has the quote once, elsewhere', async () => {
    await place('  x++;', 55);
    const result = await verify({ file: 'src/short.ts', line: 10, evidence_quote: 'x++;' });
    expect(result.verified).toBe(false);
    expect(result.correctedFinding).toBeUndefined();
  });

  it('a short multi-line quote must start on the cited line', async () => {
    await put('src/short.ts', sourceFile(60, { 30: 'a++;', 31: 'b--;' }));
    const quoted = 'a++;\nb--;';
    const there = await verify({ file: 'src/short.ts', line: 30, evidence_quote: quoted });
    expect(there.verified).toBe(true);
    const next = await verify({ file: 'src/short.ts', line: 31, evidence_quote: quoted });
    expect(next.verified).toBe(false);
  });

  it('a long quote is still corrected, so the rule is only for short ones', async () => {
    await place('  total += price * quantity;');
    const result = await verify({
      file: 'src/short.ts',
      line: 35,
      evidence_quote: 'total += price * quantity;',
    });
    expect(result.verified).toBe(true);
    expect(result.correctedFinding?.line).toBe(30);
  });
});
