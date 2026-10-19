import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCommand, CommandOutputLimitError, CommandTimeoutError, MAX_OUTPUT_BYTES } from '../../src/process/runner.js';
import { resolveCommand } from '../../src/checks/resolver.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function temporary() {
  const dir = await mkdtemp(path.join(tmpdir(), 'quorum runner '));
  directories.push(dir);
  return dir;
}

it('captures stdout, stderr and exit code', async () => {
  expect(await runCommand(process.execPath, ['-e', 'process.stdout.write("hello"); process.stderr.write("error"); process.exitCode = 7;']))
    .toEqual({ stdout: 'hello', stderr: 'error', exitCode: 7 });
});

it('kills a sleeping process at the deadline', async () => {
  await expect(runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }))
    .rejects.toBeInstanceOf(CommandTimeoutError);
});

it('kills descendants as well as the parent', async () => {
  const dir = await temporary();
  const pidFile = path.join(dir, 'child.pid');
  const script = `const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000);`;
  await expect(runCommand(process.execPath, ['-e', script, pidFile], { timeoutMs: 1500 }))
    .rejects.toBeInstanceOf(CommandTimeoutError);
  const pid = Number(await readFile(pidFile, 'utf8'));
  await expect.poll(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }).toBe(true);
});

it('caps capture and exposes the prefix and tail on overflow', async () => {
  try {
    await runCommand(process.execPath, ['-e', `process.stdout.write('START' + 'x'.repeat(${MAX_OUTPUT_BYTES}) + 'END')`]);
    expect.fail('Expected output limit error');
  } catch (error) {
    expect(error).toBeInstanceOf(CommandOutputLimitError);
    const limit = error as CommandOutputLimitError;
    expect(Buffer.byteLength(limit.stdout)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(limit.stdout.startsWith('START')).toBe(true);
    expect(limit.stdoutTail.endsWith('END')).toBe(true);
    expect(limit.exitCode).toBe(0);
  }
});

it('reports spawn errors and supplies stdin', async () => {
  await expect(runCommand('quorum-missing-executable', [])).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'input' })).stdout).toBe('input');
});

it('does not split UTF-8 at the prefix capture boundary', async () => {
  try {
    await runCommand(process.execPath, ['-e', `process.stdout.write('x'.repeat(${MAX_OUTPUT_BYTES - 1}) + '😀END')`]);
    expect.fail('Expected output limit error');
  } catch (error) {
    expect(error).toBeInstanceOf(CommandOutputLimitError);
    const limit = error as CommandOutputLimitError;
    expect(Buffer.byteLength(limit.stdout)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(limit.stdout).not.toContain('\ufffd');
    expect(limit.stdoutTail.endsWith('😀END')).toBe(true);
  }
});

it.skipIf(process.platform !== 'win32')('runs a cmd shim with spaces in its path and arguments', async () => {
  const dir = await temporary();
  const shim = path.join(dir, 'echo arguments.cmd');
  await writeFile(shim, '@echo off\r\necho [%~1][%~2]\r\n');
  const resolved = resolveCommand(shim, ['two words', 'last'], { cwd: dir });
  const result = await runCommand(resolved.file, resolved.args, { cwd: dir,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments, timeoutMs: 5000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('[two words][last]');
});
