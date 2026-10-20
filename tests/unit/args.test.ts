import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../../src/cli/args.js';

describe('parseArgs', () => {
  it('parses M5 report, cache, checks and trust flags', () => {
    expect(parseArgs(['review', '--out', 'report.md', '--sarif=result.sarif', '--no-cache', '--no-checks', '--trust-head-config']).flags)
      .toEqual({ out: 'report.md', sarif: 'result.sarif', noCache: true, noChecks: true, trustHeadConfig: true });
  });
  it.each(['--no-cache=true', '--no-checks=false', '--trust-head-config=yes', '--out', '--sarif='])('rejects malformed M5 option %s', flag => {
    expect(() => parseArgs(['review', flag])).toThrow(UsageError);
  });
  it('parses doctor probe and JSON switches without enabling them by default', () => {
    expect(parseArgs(['doctor']).flags).toEqual({});
    expect(parseArgs(['doctor', '--probe', '--json']).flags).toEqual({ probe: true, json: true });
  });

  it.each(['--probe=true', '--json=false'])('rejects values on %s', (flag) => {
    expect(() => parseArgs(['doctor', flag])).toThrow(/does not take a value/);
  });

  it('testArgs_HelpFlag', () => {
    expect(parseArgs(['--help'])).toEqual({
      command: 'help',
      flags: { help: true },
      positionals: [],
    });
  });

  it('treats --version alone as the version command', () => {
    expect(parseArgs(['--version'])).toEqual({
      command: 'version',
      flags: { version: true },
      positionals: [],
    });
  });

  it('returns an empty command when there is nothing to run', () => {
    expect(parseArgs([])).toEqual({ command: '', flags: {}, positionals: [] });
  });

  it('testArgs_ReviewFlags', () => {
    expect(parseArgs(['review', '--mode', 'feature', '--diff', 'origin/main...HEAD'])).toEqual({
      command: 'review',
      flags: { mode: 'feature', diff: 'origin/main...HEAD' },
      positionals: [],
    });
  });

  it('testArgs_AuthorAndRules', () => {
    const parsed = parseArgs([
      'review',
      '--mode',
      'redesign',
      '--rules',
      'r.md',
      '--author',
      'claude',
    ]);
    expect(parsed.command).toBe('review');
    expect(parsed.flags).toEqual({ mode: 'redesign', rules: 'r.md', author: 'claude' });
  });

  it('parses every flag, including the boolean ones', () => {
    const parsed = parseArgs([
      'review',
      '--mode',
      'redesign',
      '--diff',
      'main...HEAD',
      '--spec',
      'spec.md',
      '--inventory',
      'old.md',
      '--images',
      'shots',
      '--rules',
      'rules.md',
      '--author',
      'gemini',
      '--since',
      'abc1234',
      '--dry-run',
      '--reproduce',
      '--allow-unproven',
      '--no-host-prompt',
    ]);
    expect(parsed.flags).toEqual({
      mode: 'redesign',
      diff: 'main...HEAD',
      spec: 'spec.md',
      inventory: 'old.md',
      images: 'shots',
      rules: 'rules.md',
      author: 'gemini',
      since: 'abc1234',
      dryRun: true,
      reproduce: true,
      allowUnproven: true,
      noHostPrompt: true,
    });
  });

  it('accepts --flag=value and flags before the command', () => {
    const parsed = parseArgs(['--dry-run', 'review', '--diff=a...b']);
    expect(parsed).toEqual({
      command: 'review',
      flags: { dryRun: true, diff: 'a...b' },
      positionals: [],
    });
  });

  it('keeps extra positionals for the command to judge', () => {
    expect(parseArgs(['review', 'extra']).positionals).toEqual(['extra']);
  });

  it('passes an unknown command through for the router to reject', () => {
    expect(parseArgs(['bogus']).command).toBe('bogus');
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['review', '--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['review', '--nope'])).toThrow(/Unknown option: --nope/);
  });

  it('does not let a value flag swallow another flag', () => {
    expect(() => parseArgs(['review', '--diff', '-h'])).toThrow(/needs a value/);
    expect(() => parseArgs(['review', '--author', '--rules', 'r.md'])).toThrow(/needs a value/);
  });

  it('rejects short options and a bare double dash', () => {
    expect(() => parseArgs(['-h'])).toThrow(/Unknown option: -h/);
    expect(() => parseArgs(['--'])).toThrow(/Unknown option: --/);
  });

  it('rejects a value flag with no value', () => {
    expect(() => parseArgs(['review', '--diff'])).toThrow(/--diff needs a value/);
    expect(() => parseArgs(['review', '--diff', '--dry-run'])).toThrow(/--diff needs a value/);
    expect(() => parseArgs(['review', '--diff='])).toThrow(/non-empty value/);
  });

  it('rejects a value on a boolean flag', () => {
    expect(() => parseArgs(['review', '--dry-run=yes'])).toThrow(/does not take a value/);
  });

  it('rejects a repeated value flag', () => {
    expect(() => parseArgs(['review', '--diff', 'a', '--diff', 'b'])).toThrow(/more than once/);
  });

  it('rejects an unknown mode and names the allowed ones', () => {
    expect(() => parseArgs(['review', '--mode', 'runtime'])).toThrow(/feature, redesign/);
  });

  it('does not treat inherited object keys as flags', () => {
    expect(() => parseArgs(['--toString'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--__proto__', 'x'])).toThrow(/Unknown option/);
  });
});
