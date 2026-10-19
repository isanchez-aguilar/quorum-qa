import { describe, expect, it } from 'vitest';
import { hostEnvironment, sanitizeHostDisplay } from '../../src/reproduce/index.js';

describe('informed host execution', () => {
  it('strips ANSI, C0/C1 and bidi controls but preserves newline and tab', () => {
    const controls = Array.from({ length: 160 }, (_, i) => i)
      .filter(i => (i < 32 || i >= 127) && i !== 9 && i !== 10).map(i => String.fromCharCode(i)).join('');
    expect(sanitizeHostDisplay('start\u001b[2J\u001b]0;title\u0007' + controls + '\u202a\u202e\u2066\u2069\u200e\u200f\n\tend'))
      .toBe('start\n\tend');
  });
  it('uses only the platform allowlist, including mixed-case Windows environment keys', () => {
    const source = { Path: '/tools', PATH: '/bin', SystemRoot: 'C:/Windows', ComSpec: 'cmd.exe', PATHEXT: '.EXE', TEMP: '/temp', TMP: '/tmp',
      HOME: '/home/synthetic', TMPDIR: '/scratch', LANG: 'en_US.UTF-8', NODE_OPTIONS: '--import=evil', SYNTHETIC_TOKEN: 'fixture' };
    expect(hostEnvironment('win32', source)).toEqual({ Path: '/tools', PATH: '/bin', SystemRoot: 'C:/Windows', ComSpec: 'cmd.exe', PATHEXT: '.EXE', TEMP: '/temp', TMP: '/tmp' });
    expect(hostEnvironment('linux', source)).toEqual({ PATH: '/bin', HOME: '/home/synthetic', TMPDIR: '/scratch', LANG: 'en_US.UTF-8' });
  });
});
