import { expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { hasConfiguredTestCommand, validateConfig } from '../../src/config/schema.js';

it('accepts refactor flags and validates its optional command and bounded timeout', () => {
  expect(parseArgs(['review', '--mode', 'refactor', '--deterministic-only', '--allow-api-change']).flags)
    .toMatchObject({ mode: 'refactor', deterministicOnly: true, allowApiChange: true });
  expect(validateConfig({ checks: [], refactor: {} }).refactor).toEqual({ timeoutSeconds: 600 });
  expect(validateConfig({ checks: [], refactor: { testCommand: ['node', 'run.cjs'], timeoutSeconds: 30 } }).refactor)
    .toEqual({ testCommand: ['node', 'run.cjs'], timeoutSeconds: 30 });
  for (const timeoutSeconds of [29, 3601, '600']) {
    expect(() => validateConfig({ checks: [], refactor: { timeoutSeconds } })).toThrow('refactor.timeoutSeconds');
  }
  for (const testCommand of [[], 'npm test', [4]]) {
    expect(() => validateConfig({ checks: [], refactor: { testCommand } })).toThrow('refactor.testCommand');
  }
});
it('tracks explicit test commands separately from reproduction defaults for doctor', () => {
  expect(hasConfiguredTestCommand(validateConfig({ checks: [] }))).toBe(false);
  expect(hasConfiguredTestCommand(validateConfig({ checks: [], refactor: {} }))).toBe(false);
  expect(hasConfiguredTestCommand(validateConfig({ checks: [], reproduce: { testCommand: ['node', 'runner.cjs'] } }))).toBe(true);
  expect(hasConfiguredTestCommand(validateConfig({ checks: [], refactor: { testCommand: ['node', 'runner.cjs'] } }))).toBe(true);
});

it.each([
  { maxMutants: 0 }, { maxMutants: 26 }, { maxMutants: 1.5 }, { maxMutants: '8' },
  { budgetSeconds: 29 }, { budgetSeconds: 3601 }, { unexpected: true },
])('rejects invalid mutation configuration %j', mutation => {
  expect(() => validateConfig({ checks: [], refactor: { mutation } })).toThrow();
});
it('defaults and validates mutation limits without enabling sampling', () => {
  expect(validateConfig({ checks: [], refactor: { mutation: {} } }).refactor?.mutation).toEqual({ maxMutants: 8, budgetSeconds: 300 });
  expect(validateConfig({ checks: [], refactor: { mutation: { maxMutants: 25, budgetSeconds: 3600 } } }).refactor?.mutation)
    .toEqual({ maxMutants: 25, budgetSeconds: 3600 });
});

it('parses mutation as a boolean flag and rejects it for other commands', async () => {
  const { main } = await import('../../src/cli/index.js');
  expect(parseArgs(['review', '--mode', 'refactor', '--mutation']).flags.mutation).toBe(true);
  expect(() => parseArgs(['review', '--mutation=true'])).toThrow();
  let err = '';
  expect(await main(['doctor', '--mutation'], { out: () => {}, err: text => { err += text; } })).toBe(2);
  expect(err).toContain('--mutation requires refactor mode');
});
