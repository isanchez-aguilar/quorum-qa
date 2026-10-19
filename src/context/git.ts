import type { CommandRunner } from '../types/index.js';
import { resolveCommand } from '../checks/resolver.js';
import { CommandOutputLimitError } from '../process/runner.js';

export function validateRef(ref: string, allowRange = true): void {
  const plain = (part: string) => /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(part)
    && !part.includes('..') && !part.includes('//') && !part.endsWith('.')
    && !part.endsWith('/') && !part.split('/').some(segment => segment.startsWith('.') || segment.endsWith('.lock'));
  const parts = allowRange ? ref.split(/\.{2,3}/) : [ref];
  if (parts.length > 2 || !parts.every(plain)) throw new Error(`Invalid git ref: ${ref}`);
}

export async function git(args: string[], cwd: string, runner: CommandRunner) {
  const resolved = resolveCommand('git', args, { cwd });
  return runner(resolved.file, resolved.args, { cwd, timeoutMs: 30_000,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments });
}

async function output(args: string[], cwd: string, runner: CommandRunner): Promise<string> {
  const result = await git(args, cwd, runner);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed (${result.exitCode}): ${result.stderr}`);
  return result.stdout;
}

export async function revParse(ref: string, cwd: string, runner: CommandRunner): Promise<string> {
  validateRef(ref, false);
  return (await output(['rev-parse', '--verify', `${ref}^{commit}`], cwd, runner)).trim();
}

export async function mergeBase(base: string, head: string, cwd: string, runner: CommandRunner): Promise<string> {
  validateRef(base, false);
  validateRef(head, false);
  return (await output(['merge-base', base, head], cwd, runner)).trim();
}

export async function diffRange(range: string, cwd: string, runner: CommandRunner): Promise<string> {
  validateRef(range);
  try {
    return await output(['diff', '--no-ext-diff', '--no-textconv', '--unified=3', range, '--'], cwd, runner);
  } catch (error) {
    if (error instanceof CommandOutputLimitError && error.exitCode === 0) {
      return error.stdout + '\n[Quorum: command output truncated]\n';
    }
    throw error;
  }
}

export async function changedFiles(range: string, cwd: string, runner: CommandRunner): Promise<Array<{ status: string; path: string }>> {
  validateRef(range);
  const text = await output(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', range, '--'], cwd, runner);
  const fields = text.split('\0');
  fields.pop();
  if (fields.length % 2) throw new Error('Incomplete git changed-files output');
  const files = [];
  for (let i = 0; i < fields.length; i += 2) files.push({ status: fields[i]!, path: fields[i + 1]! });
  return files;
}

export async function fileExistsAtCommit(commit: string, file: string, cwd: string, runner: CommandRunner): Promise<boolean> {
  validateRef(commit, false);
  // Resolve the commit first so a missing revision is not mistaken for a new file.
  const sha = await revParse(commit, cwd, runner);
  if (!file || file.includes('\0')) throw new Error('Invalid git path');
  const result = await git(['cat-file', '-e', `${sha}:${file}`], cwd, runner);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 128 || result.exitCode === 1) return false;
  throw new Error(`git cat-file failed (${result.exitCode}): ${result.stderr}`);
}

export async function worktreeRoot(cwd: string, runner: CommandRunner): Promise<string> {
  return (await output(['rev-parse', '--show-toplevel'], cwd, runner)).trim();
}
