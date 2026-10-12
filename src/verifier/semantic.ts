// Code tokens of a fragment, compared in order.
//
// A fuzzy match only LOCATES a candidate. It is trusted only when the quote and the code have the
// same sequence of tokens, so `if (user.token) return false;` can never verify against
// `if (!user.token) return false;`, and `if (b < a)` can never verify against `if (a < b)`,
// however close the characters are. Operators, keywords, numbers and strings must be identical.
// Identifiers must be identical too, except for a typo: see sameIdentifier. Punctuation that only
// groups or separates (parentheses, brackets, braces, commas, semicolons, dots) is not a token.
// The scan is a single linear pass: no backtracking, and no regular expression runs over the text
// from more than one starting point.

import { levenshtein } from './quote.js';

type TokenKind = 'ident' | 'word' | 'number' | 'operator' | 'string' | 'template';

interface CodeToken {
  kind: TokenKind;
  // For a string, its content without the delimiters. For a template, which part of it this is.
  text: string;
  // Only on a string: the delimiter that opened it. A backtick chunk belongs to a template.
  delim?: string;
}

// An identifier of fewer characters than this must match exactly (`a` is not `b`, `id` is not `ip`).
export const IDENTIFIER_MIN_LENGTH = 4;
// Two longer identifiers are the same name with a typo when their edit distance is at most
// (1 - IDENTIFIER_SIMILARITY) of the longer one. 0.8 would be the natural value, but TAX_RATE and
// TAX_RATIO (two edits in nine characters, 0.778) are the typo this check exists to tolerate, and
// they fall just under it. 0.77 still keeps a four-character name exact (one edit is 0.75).
export const IDENTIFIER_SIMILARITY = 0.77;

// The listed operators and negation of the contract, plus the assignment, compound assignment,
// increment and bitwise forms, so `+=` cannot pass for `-=` or `++` for `--`.
const OPERATOR = new RegExp(
  '>>>=|\\?\\?=|\\|\\|=|&&=|===|!==|>>>|<<=|>>=|\\*\\*=|=>|==|!=|<=|>=|&&|\\|\\||\\?\\?|\\+\\+|--|' +
    '\\+=|-=|\\*=|/=|%=|\\*\\*|<<|>>|[!<>=+\\-*/%&|^~]',
  'y',
);
const NUMBER =
  /0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/uy;

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

const BACKSLASH = 92;
const BACKTICK = 96;
const DOLLAR = 36;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const NEWLINE = 10;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function tokenize(text: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const length = text.length;
  // One entry per open `${` of a template: how many `{` opened inside it are still open.
  const expressions: number[] = [];
  let at = 0;

  // `at` is just after an opening backtick or after the `}` that ends a `${...}`.
  const readTemplateText = (): void => {
    const start = at;
    let end = at;
    let closed = false;
    let expression = false;
    while (end < length) {
      const code = text.charCodeAt(end);
      if (code === BACKSLASH) {
        end += 2;
      } else if (code === BACKTICK) {
        closed = true;
        break;
      } else if (code === DOLLAR && text.charCodeAt(end + 1) === OPEN_BRACE) {
        expression = true;
        break;
      } else {
        end += 1;
      }
    }
    end = Math.min(end, length);
    if (end > start) tokens.push({ kind: 'string', text: text.slice(start, end), delim: '`' });
    if (closed) {
      tokens.push({ kind: 'template', text: 'close' });
      at = end + 1;
    } else if (expression) {
      tokens.push({ kind: 'template', text: 'expression-open' });
      expressions.push(0);
      at = end + 2;
    } else {
      at = length;
    }
  };

  while (at < length) {
    const code = text.charCodeAt(at);
    if (code <= 32) {
      at += 1;
    } else if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
      // A string ends at its delimiter or at the end of the line; an unterminated one is closed there.
      let end = at + 1;
      while (end < length) {
        const next = text.charCodeAt(end);
        if (next === BACKSLASH) end += 2;
        else if (next === code || next === NEWLINE) break;
        else end += 1;
      }
      end = Math.min(end, length);
      tokens.push({ kind: 'string', text: text.slice(at + 1, end), delim: text[at] as string });
      at = end < length && text.charCodeAt(end) === code ? end + 1 : end;
    } else if (code === BACKTICK) {
      tokens.push({ kind: 'template', text: 'open' });
      at += 1;
      readTemplateText();
    } else if (code === CLOSE_BRACE && expressions.length > 0) {
      const top = expressions.length - 1;
      if (expressions[top] === 0) {
        expressions.pop();
        tokens.push({ kind: 'template', text: 'expression-close' });
        at += 1;
        readTemplateText();
      } else {
        expressions[top] = (expressions[top] as number) - 1;
        at += 1;
      }
    } else if (code === OPEN_BRACE && expressions.length > 0) {
      const top = expressions.length - 1;
      expressions[top] = (expressions[top] as number) + 1;
      at += 1;
    } else {
      let matched: string | undefined;
      if (isDigit(code) || (code === 46 && isDigit(text.charCodeAt(at + 1)))) {
        NUMBER.lastIndex = at;
        matched = NUMBER.exec(text)?.[0];
        if (matched !== undefined) {
          tokens.push({ kind: 'number', text: matched.replace(/_/g, '').toLowerCase() });
        }
      } else {
        IDENTIFIER.lastIndex = at;
        matched = IDENTIFIER.exec(text)?.[0];
        if (matched !== undefined) {
          const lower = matched.toLowerCase();
          if (WORDS.has(lower)) tokens.push({ kind: 'word', text: lower });
          else tokens.push({ kind: 'ident', text: matched });
        } else {
          OPERATOR.lastIndex = at;
          matched = OPERATOR.exec(text)?.[0];
          if (matched !== undefined) tokens.push({ kind: 'operator', text: matched });
        }
      }
      // Punctuation and anything else that is not a token is skipped one character at a time.
      at += matched === undefined || matched.length === 0 ? 1 : matched.length;
    }
  }
  return tokens;
}

function keyOf(token: CodeToken): string {
  if (token.kind !== 'string') return `${token.kind}:${token.text}`;
  const delim = token.delim as string;
  return delim === '`' ? `string:\`${token.text}` : `string:${delim}${token.text}${delim}`;
}

/** The tokens of a fragment, as comparable strings (a string keeps its delimiters). */
export function semanticTokens(text: string): string[] {
  return tokenize(text).map(keyOf);
}

function digitsOf(name: string): string {
  return name.replace(/\D/g, '');
}

// The edit distance, counting a swap of two neighbouring characters as one edit, bounded.
function editDistance(a: string, b: string, bound: number): number {
  if (a.length === b.length) {
    let first = 0;
    while (first < a.length && a[first] === b[first]) first += 1;
    let last = a.length - 1;
    while (last > first && a[last] === b[last]) last -= 1;
    if (last === first + 1 && a[first] === b[last] && a[last] === b[first]) return 1;
  }
  return levenshtein(a, b, bound);
}

/**
 * Whether two identifiers are the same name, allowing a typo. They must be identical, unless both
 * have at least IDENTIFIER_MIN_LENGTH characters and their edit distance is within the
 * IDENTIFIER_SIMILARITY bound (one swap of neighbouring characters counts as one edit). Two names
 * that differ only in their digits (`item1`, `item2`) or by a final `s` (`user`, `users`) are
 * different names, not typos: they are the usual pairs of variables of one scope.
 */
export function sameIdentifier(quoted: string, real: string): boolean {
  if (quoted === real) return true;
  if (quoted.length < IDENTIFIER_MIN_LENGTH || real.length < IDENTIFIER_MIN_LENGTH) return false;
  if (digitsOf(quoted) !== digitsOf(real)) return false;
  if (`${quoted}s` === real || `${real}s` === quoted) return false;
  const longest = Math.max(quoted.length, real.length);
  const bound = Math.floor(longest * (1 - IDENTIFIER_SIMILARITY) + 1e-9);
  if (Math.abs(quoted.length - real.length) > bound) return false;
  return editDistance(quoted, real, bound) <= bound;
}

function sameToken(quoted: CodeToken, real: CodeToken): boolean {
  if (quoted.kind !== real.kind) return false;
  if (quoted.kind === 'ident') return sameIdentifier(quoted.text, real.text);
  return quoted.text === real.text && quoted.delim === real.delim;
}

function describe(token: CodeToken): string {
  switch (token.kind) {
    case 'ident':
      return `the identifier "${token.text}"`;
    case 'string':
      return token.delim === '`'
        ? `the template text ${JSON.stringify(token.text)}`
        : `the string ${token.delim}${token.text}${token.delim}`;
    case 'template':
      if (token.text === 'open') return 'a template literal';
      if (token.text === 'close') return 'the end of a template literal';
      if (token.text === 'expression-open') return 'the "${" of a template expression';
      return 'the end of a template expression';
    default:
      return `"${token.text}"`;
  }
}

/**
 * Compares the token sequences of a quote and of the code it was matched to. Returns null when
 * they are the same, otherwise a sentence that names the first token that differs.
 */
export function semanticDifference(quote: string, code: string): string | null {
  const quoted = tokenize(quote);
  const real = tokenize(code);
  const shared = Math.min(quoted.length, real.length);
  let index = 0;
  while (index < shared && sameToken(quoted[index] as CodeToken, real[index] as CodeToken)) index += 1;
  if (index === quoted.length && index === real.length) return null;

  const quotedToken = quoted[index];
  const realToken = real[index];
  if (quotedToken === undefined && realToken !== undefined) {
    return `the code has ${describe(realToken)} that the quote does not`;
  }
  if (realToken === undefined && quotedToken !== undefined) {
    return `the quote has ${describe(quotedToken)} that the code does not`;
  }
  // Both exist and differ. A token inserted or dropped shifts the whole rest by one; two tokens
  // that merely swapped places (`f(a, b)` and `f(b, a)`) do not, and are reported as a substitution.
  const restEqual = (quotedFrom: number, realFrom: number): boolean => {
    if (quoted.length - quotedFrom !== real.length - realFrom) return false;
    for (let k = 0; quotedFrom + k < quoted.length; k += 1) {
      if (!sameToken(quoted[quotedFrom + k] as CodeToken, real[realFrom + k] as CodeToken)) return false;
    }
    return true;
  };
  if (quotedToken !== undefined && realToken !== undefined) {
    if (restEqual(index + 1, index)) {
      return `the quote has ${describe(quotedToken)} that the code does not`;
    }
    if (restEqual(index, index + 1)) {
      return `the code has ${describe(realToken)} that the quote does not`;
    }
  }
  return `the quote has ${describe(quotedToken as CodeToken)} where the code has ${describe(realToken as CodeToken)}`;
}
