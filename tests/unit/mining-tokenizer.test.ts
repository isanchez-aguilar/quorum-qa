import { expect, it } from 'vitest';
import { tokenize, semanticTokens } from '../../src/verifier/semantic.js';

it('preserves punctuation and language keywords for mining without changing verification tokens', () => {
  expect(tokenize('const foo = bar(12, "x");', true).map(t => [t.kind, t.text])).toEqual([
    ['word', 'const'], ['ident', 'foo'], ['operator', '='], ['ident', 'bar'],
    ['punctuation', '('], ['number', '12'], ['punctuation', ','],
    ['string', 'x'], ['punctuation', ')'], ['punctuation', ';'],
  ]);
  expect(semanticTokens('const foo = bar(12, "x");')).toEqual([
    'ident:const', 'ident:foo', 'operator:=', 'ident:bar', 'punctuation:(', 'number:12', 'string:"x"', 'punctuation:)',
  ]);
});
