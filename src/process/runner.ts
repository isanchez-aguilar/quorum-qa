import { spawn } from 'node:child_process';
import path from 'node:path';
import type { CommandRunner } from '../types/index.js';

export const MAX_OUTPUT_BYTES = 1024 * 1024;

export class CommandOutputLimitError extends Error {
  constructor(public stdout: string, public stderr: string, public stdoutTail: string,
    public stderrTail: string, public exitCode: number) {
    super('Command output exceeded capture limit');
    this.name = 'CommandOutputLimitError';
  }
}

export class CommandTimeoutError extends Error {
  constructor(public stdout: string, public stderr: string) {
    super('Command timed out');
    this.name = 'CommandTimeoutError';
  }
}

export function byteTail(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

export function bytePrefix(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, limit);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

export const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
    reject(new Error('timeoutMs must be finite and non-negative'));
    return;
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let stdoutHead = Buffer.alloc(0);
  let stderrHead = Buffer.alloc(0);
  let exceeded = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> = Promise.resolve();
  const append = (previous: Buffer, chunk: Buffer) => Buffer.concat([previous, chunk]).subarray(-MAX_OUTPUT_BYTES);
  child.stdout.on('data', (chunk: Buffer) => {
    exceeded ||= stdoutHead.length + chunk.length > MAX_OUTPUT_BYTES;
    stdoutHead = Buffer.concat([stdoutHead, chunk]).subarray(0, MAX_OUTPUT_BYTES);
    stdout = append(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    exceeded ||= stderrHead.length + chunk.length > MAX_OUTPUT_BYTES;
    stderrHead = Buffer.concat([stderrHead, chunk]).subarray(0, MAX_OUTPUT_BYTES);
    stderr = append(stderr, chunk);
  });
  child.stdin.on('error', () => { /* A command may exit before consuming its input. */ });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    void termination.then(() => {
      if (timedOut) reject(new CommandTimeoutError(byteTail(stdout.toString(), MAX_OUTPUT_BYTES), byteTail(stderr.toString(), MAX_OUTPUT_BYTES)));
      else if (exceeded) reject(new CommandOutputLimitError(bytePrefix(stdoutHead.toString(), MAX_OUTPUT_BYTES), bytePrefix(stderrHead.toString(), MAX_OUTPUT_BYTES),
        byteTail(stdout.toString(), MAX_OUTPUT_BYTES), byteTail(stderr.toString(), MAX_OUTPUT_BYTES), code ?? 1));
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: code ?? (signal ? 1 : 0) });
    }, reject);
  });
  if (options.timeoutMs !== undefined) timer = setTimeout(() => {
    timedOut = true;
    if (!child.pid) return;
    if (process.platform === 'win32') {
      termination = new Promise<void>((done, fail) => {
        const killer = spawn(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', error => { child.kill(); fail(error); });
        killer.once('close', code => {
          if (code !== 0 && child.exitCode === null) {
            child.kill();
            fail(new CommandTimeoutError(byteTail(stdout.toString(), MAX_OUTPUT_BYTES),
              byteTail(stderr.toString() + `\nTaskkill failed (${code}); process tree termination could not be verified`, MAX_OUTPUT_BYTES)));
            return;
          }
          done();
        });
      });
      // Attach immediately: taskkill can fail before the target closes its pipes.
      void termination.catch(error => {
        child.stdout.destroy();
        child.stderr.destroy();
        reject(error);
      });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
      }
    }
  }, options.timeoutMs);
  child.stdin.end(options.stdin);
});
