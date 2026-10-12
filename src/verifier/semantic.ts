// Semantic tokens of a code fragment: the few things that flip what a line of code means.
//
// A fuzzy match only LOCATES a candidate. It is trusted only when the quote and the code have the
// same sequence of semantic tokens, so `if (user.token) return false;` can never verify against
// `if (!user.token) return false;` however close the characters are. Identifier spelling is not
// semantic: a typo in a name still verifies. The scan is a single linear pass.

interface SemanticToken {
  kind: 'operator' | 'word' | 'number' | 'string';
  // For a string, its content without the delimiters.
  text: string;
}

// The listed operators and negation of the contract, plus the assignment, compound assignment,
// increment and bitwise forms, so `+=` cannot pass for `-=` or `++` for `--`.
const OPERATOR =
  '>>>=|\\?\\?=|\\|\\|=|&&=|===|!==|>>>|<<=|>>=|\\*\\*=|=>|==|!=|<=|>=|&&|\\|\\||\\?\\?|\\+\\+|--|' +
  '\\+=|-=|\\*=|/=|%=|\\*\\*|<<|>>|[!<>=+\\-*/%&|^~]';

// Words that decide control flow or truth. Compared case-insensitively (True, NULL).
const WORDS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'nil',
  'none',
  'not',
  'and',
  'or',
  'return',
  'throw',
  'raise',
  'if',
  'else',
  'break',
  'continue',
  'await',
]);

const TOKEN = new RegExp(
  [
    '(?<dq>"(?:[^"\\\\\\n]|\\\\.)*")',
    "(?<sq>'(?:[^'\\\\\\n]|\\\\.)*')",
    '(?<bq>`(?:[^`\\\\]|\\\\[\\s\\S])*`)',
    '(?<num>0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\\d[\\d_]*\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)',
    '(?<word>[A-Za-z_$][A-Za-z0-9_$]*)',
    `(?<op>${OPERATOR})`,
  ].join('|'),
  'g',
);

function tokenize(text: string): SemanticToken[] {
  const tokens: SemanticToken[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const groups = match.groups as Record<string, string | undefined>;
    const literal = groups.dq ?? groups.sq ?? groups.bq;
    if (literal !== undefined) {
      tokens.push({ kind: 'string', text: literal.slice(1, -1) });
    } else if (groups.num !== undefined) {
      tokens.push({ kind: 'number', text: groups.num.replace(/_/g, '').toLowerCase() });
    } else if (groups.word !== undefined) {
      const word = groups.word.toLowerCase();
      if (WORDS.has(word)) tokens.push({ kind: 'word', text: word });
    } else if (groups.op !== undefined) {
      tokens.push({ kind: 'operator', text: groups.op });
    }
  }
  return tokens;
}

/** The semantic tokens of a fragment, as comparable strings. */
export function semanticTokens(text: string): string[] {
  return tokenize(text).map((token) => `${token.kind}:${token.text}`);
}

function describe(token: string): string {
  const separator = token.indexOf(':');
  const kind = token.slice(0, separator);
  const text = token.slice(separator + 1);
  return kind === 'string' ? `the string ${JSON.stringify(text)}` : `"${text}"`;
}

/**
 * Compares the semantic token sequences of a quote and of the code it was matched to. Returns
 * null when they are equal, otherwise a sentence that names the first token that differs.
 */
export function semanticDifference(quote: string, code: string): string | null {
  const quoted = semanticTokens(quote);
  const real = semanticTokens(code);
  const shared = Math.min(quoted.length, real.length);
  let index = 0;
  while (index < shared && quoted[index] === real[index]) index += 1;
  if (index === quoted.length && index === real.length) return null;

  const quotedToken = quoted[index];
  const realToken = real[index];
  if (quotedToken === undefined && realToken !== undefined) {
    return `the code has ${describe(realToken)} that the quote does not`;
  }
  if (realToken === undefined && quotedToken !== undefined) {
    return `the quote has ${describe(quotedToken)} that the code does not`;
  }
  // Both exist and differ. An inserted or dropped token shifts the rest by one.
  if (realToken !== undefined && quoted[index + 1] === realToken && quotedToken !== undefined) {
    return `the quote has ${describe(quotedToken)} that the code does not`;
  }
  if (quotedToken !== undefined && real[index + 1] === quotedToken && realToken !== undefined) {
    return `the code has ${describe(realToken)} that the quote does not`;
  }
  return `the quote has ${describe(quotedToken as string)} where the code has ${describe(realToken as string)}`;
}
