import { describe, expect, it } from 'vitest';
import { machineTestCommand } from '../../src/reproduce/command.js';
import { parseTestReport } from '../../src/reproduce/evaluate.js';

describe('machine-readable test command', () => {
  it('adds a Vitest JSON report and an optional target without mutating configuration', () => {
    const command = ['pnpm', 'vitest', 'run'];
    expect(machineTestCommand(command, '/tmp/result.json', 'src/a.test.ts')).toEqual([
      ...command, '--reporter=json', '--outputFile=/tmp/result.json', './src/a.test.ts',
    ]);
    expect(command).toEqual(['pnpm', 'vitest', 'run']);
  });
  it.each(['jest', 'node_modules/jest/bin/jest.js', 'C:\\tools\\jest.cjs'])('recognizes %s', runner => {
    expect(machineTestCommand(['node', runner], '/tmp/report.json')).toEqual([
      'node', runner, '--json', '--outputFile=/tmp/report.json',
    ]);
  });
  it('replaces stale report destinations and preserves other options', () => {
    expect(machineTestCommand(['vitest', '--reporter=json', '--outputFile', 'old.json', '--bail=1'], 'new.json'))
      .toEqual(['vitest', '--reporter=json', '--bail=1', '--outputFile=new.json']);
  });
  it('does not duplicate the JSON switch', () => {
    expect(machineTestCommand(['jest', '--json', '--outputFile=old.json'], 'new.json'))
      .toEqual(['jest', '--json', '--outputFile=new.json']);
  });
});

it('preserves describe segments and title even when a full name is supplied', () => {
  const report = parseTestReport({ testResults: [{
    name: 'C:\\tree\\test.spec.ts', assertionResults: [{
      fullName: 'suite nested works', ancestorTitles: ['suite', 'nested'], title: 'works',
      status: 'passed', failureMessages: [],
    }],
  }] }, 'C:\\tree');
  expect(report?.tests[0]).toMatchObject({ file: 'test.spec.ts', ancestorTitles: ['suite', 'nested'], title: 'works' });
});
