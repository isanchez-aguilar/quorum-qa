import { createHash } from 'node:crypto';
import { git } from '../context/git.js';
import type { CommandRunner } from '../types/index.js';

export interface CheckoutSnapshot { status: string; head: string; contentHash: string }

export async function checkoutSnapshot(root: string, runner: CommandRunner): Promise<CheckoutSnapshot> {
  const status = await git(['status', '--porcelain', '--untracked-files=all'], root, runner);
  const head = await git(['rev-parse', '--verify', 'HEAD'], root, runner);
  const diff = await git(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--'], root, runner);
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], root, runner);
  if (diff.exitCode !== 0 || untracked.exitCode !== 0) throw new Error('Cannot verify user checkout contents; run aborted.');
  if (status.exitCode !== 0 || head.exitCode !== 0) throw new Error('Cannot verify user checkout status and HEAD; run aborted.');
  return { status: status.stdout, head: head.stdout.trim(), contentHash: createHash('sha256').update(diff.stdout).update('\0').update(untracked.stdout).digest('hex') };
}

export function checkoutDifference(before: CheckoutSnapshot, after: CheckoutSnapshot): string | undefined {
  if (before.status === after.status && before.head === after.head && before.contentHash === after.contentHash) return undefined;
  const previous = new Set(before.status.split(/\r?\n/).filter(Boolean));
  const current = new Set(after.status.split(/\r?\n/).filter(Boolean));
  const paths = [...new Set([...previous, ...current].filter(line => previous.has(line) !== current.has(line)).map(line => line.slice(3)))];
  if (before.head !== after.head) paths.push('HEAD');
  return `User checkout changed; run aborted: ${paths.join(', ') || 'tracked contents or untracked file list changed'}`;
}
