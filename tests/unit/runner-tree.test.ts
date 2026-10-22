import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandTimeoutError, runCommand } from '../../src/process/runner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.mocked(spawn).mockReset(); });

it.each(['win32', 'linux'] as const)('kills the whole process tree on %s at the deadline', async platform => {
  vi.useFakeTimers();
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  const killer = new EventEmitter();
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>)
    .mockReturnValueOnce(killer as ReturnType<typeof spawn>);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const pending = runCommand('synthetic', [], { timeoutMs: 50 });
  const rejected = expect(pending).rejects.toBeInstanceOf(CommandTimeoutError);
  await vi.advanceTimersByTimeAsync(50);
  expect(spawn).toHaveBeenNthCalledWith(1, 'synthetic', [], expect.objectContaining({ detached: platform !== 'win32', shell: false }));
  if (platform === 'win32') {
    expect(spawn).toHaveBeenNthCalledWith(2, path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', '12345', '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.emit('close', 0);
  } else expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
  child.emit('close', null, 'SIGKILL');
  await rejected;
  expect(child.kill).not.toHaveBeenCalled();
});
