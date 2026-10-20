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
