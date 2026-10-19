import type { CommandRunner, Origin } from '../types/index.js';
import { fileExistsAtCommit, git, requireWorktreeRoot, revParse } from './git.js';

export async function determineOrigin(
  file: string, line: number, baseSha: string, headSha: string, cwd: string, runner: CommandRunner,
): Promise<Origin> {
  if (!Number.isSafeInteger(line) || line < 1) throw new Error('Line must be a positive integer');
  await requireWorktreeRoot(cwd, runner);
  const base = await revParse(baseSha, cwd, runner);
  const head = await revParse(headSha, cwd, runner);
  const blame = await git(['blame', '--porcelain', '-L', `${line},${line}`, head, '--', file], cwd, runner);
  if (blame.exitCode !== 0) throw new Error(`git blame failed: ${blame.stderr}`);
  const commit = blame.stdout.match(/^([a-f0-9]{40,64}) /)?.[1];
  if (!commit) throw new Error('Invalid git blame output');
  if (!await fileExistsAtCommit(base, file, cwd, runner)) return 'introduced';
  const ancestor = await git(['merge-base', '--is-ancestor', commit, base], cwd, runner);
  if (ancestor.exitCode === 0) return 'pre-existing';
  if (ancestor.exitCode === 1) return 'introduced';
  throw new Error(`git merge-base failed: ${ancestor.stderr}`);
}
