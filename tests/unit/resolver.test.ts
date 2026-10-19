import { describe, expect, it } from 'vitest';
import { resolveCommand } from '../../src/checks/resolver.js';

const windows = {
  platform: 'win32' as const, cwd: 'C:\\repo',
  env: { Path: 'C:\\Program Files\\nodejs', PATHEXT: '.EXE;.CMD;.BAT' },
  exists: (file: string) => file.toLowerCase() === 'c:\\program files\\nodejs\\pnpm.cmd',
};

describe('resolveCommand', () => {
  it.each(['cmd.exe', '.\\cmd.exe', 'C:\\missing\\cmd.exe', ''])('ignores invalid ComSpec %j', COMSPEC => {
    expect(resolveCommand('pnpm', [], { ...windows, env: { ...windows.env, COMSPEC } }).file)
      .toBe('C:\\Windows\\System32\\cmd.exe');
  });
  it.each(['D:\\Windows', 'relative'])('uses only an absolute SystemRoot: %s', SystemRoot => {
    expect(resolveCommand('pnpm', [], { ...windows, env: { ...windows.env, SystemRoot } }).file)
      .toBe(SystemRoot === 'relative' ? 'C:\\Windows\\System32\\cmd.exe' : 'D:\\Windows\\System32\\cmd.exe');
  });
  it('testResolver_PosixDirect', () => {
    expect(resolveCommand('git', ['status'], { platform: 'linux', cwd: '/repo',
      env: { PATH: '/usr/bin' }, exists: file => file === '/usr/bin/git' }))
      .toEqual({ file: '/usr/bin/git', args: ['status'] });
  });
  it('testResolver_WindowsCmdShim', () => {
    expect(resolveCommand('pnpm', ['lint'], windows)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe', windowsVerbatimArguments: true,
      args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\pnpm.CMD" "lint""'],
    });
  });
  it('testResolver_ShimInCwdIgnored', () => {
    const visited: string[] = [];
    const result = resolveCommand('pnpm', [], { ...windows,
      env: { PATH: ';.;C:\\repo;relative;C:\\safe', PATHEXT: '.CMD' },
      exists: file => { visited.push(file); return true; },
    });
    expect(visited).toEqual(['C:\\safe\\pnpm.CMD']);
    expect(result.args[3]).toBe('""C:\\safe\\pnpm.CMD""');
  });
  it('testResolver_PathWithSpaces', () => {
    expect(resolveCommand('tool', ['two words', ''], { platform: 'linux', cwd: '/repo',
      env: { PATH: '/some tools' }, exists: () => true }))
      .toEqual({ file: '/some tools/tool', args: ['two words', ''] });
    expect(resolveCommand('pnpm', ['two words', ''], windows).args[3])
      .toBe('""C:\\Program Files\\nodejs\\pnpm.CMD" "two words" """');
  });
  it('testResolver_MetacharacterInjection', () => {
    expect(() => resolveCommand('pnpm', ['lint; rm -rf /'], windows))
      .toThrow('Disallowed command metacharacter: ;');
  });
  it.each(['&', '|', '<', '>', '^', '%', '!', ';', '"', '\r', '\n', '\0'])('rejects %j', character => {
    const name = character === '\r' ? 'CR' : character === '\n' ? 'LF' : character === '\0' ? 'NUL' : character;
    expect(() => resolveCommand('pnpm', [`a${character}b`], windows)).toThrow(`metacharacter: ${name}`);
  });
  it('rejects expansion characters in a shim path', () => {
    expect(() => resolveCommand('pnpm', [], { ...windows, env: { PATH: 'C:\\%bad%', PATHEXT: '.CMD' }, exists: () => true }))
      .toThrow('metacharacter: %');
  });
  it('reports a missing program', () => {
    expect(() => resolveCommand('missing', [], { ...windows, exists: () => false })).toThrow('Command not found');
  });
  it('preserves exe arguments without shell restrictions', () => {
    expect(resolveCommand('node.exe', ['a&b', 'two words'], { ...windows, exists: () => true }))
      .toEqual({ file: 'C:\\Program Files\\nodejs\\node.exe', args: ['a&b', 'two words'] });
  });
  it('uses ComSpec and accepts an absolute bat path', () => {
    expect(resolveCommand('C:\\tools\\job.bat', [], { ...windows,
      env: { COMSPEC: 'C:\\custom\\cmd.exe' }, exists: () => true }).file).toBe('C:\\custom\\cmd.exe');
  });
});
