import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandRunner } from '../types/index.js';
import { resolveCommand } from '../checks/resolver.js';
import { createReviewWorktree, isClean } from '../worktree/index.js';

export interface DoctorCheck {
  id: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  fix?: string;
}

export interface CheckContext { runner: CommandRunner; env: NodeJS.ProcessEnv; repoRoot: string }

export async function command(context: CheckContext, name: string, args: string[], cwd = context.repoRoot, stdin?: string) {
  const resolved = resolveCommand(name, args, { env: context.env, cwd });
  return context.runner(resolved.file, resolved.args, { cwd, env: context.env, stdin,
    timeoutMs: 30_000, windowsVerbatimArguments: resolved.windowsVerbatimArguments });
}

export function permissionPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^[a-z]:/i, '');
  return path.posix.normalize(normalized).replace(/\/$/, '') || '/';
}

export async function checkPermissions(homedir: string, repoRoot: string): Promise<DoctorCheck[]> {
  const parent = permissionPath(path.join(repoRoot, '.quorum', 'worktrees'));
  const rule = `read_file(${parent})`;
  let allowed = false;
  try {
    const settings: unknown = JSON.parse(await readFile(path.join(homedir, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
    const allow = (settings as { permissions?: { allow?: unknown } } | null)?.permissions?.allow;
    allowed = Array.isArray(allow) && allow.some(entry => {
      if (typeof entry !== 'string') return false;
      const match = /^read_file\(([^\r\n]+)\)$/.exec(entry);
      if (!match || !match[1]!.startsWith('/')) return false;
      let permitted = permissionPath(match[1]!);
      let target = parent;
      if (process.platform === 'win32') { permitted = permitted.toLowerCase(); target = target.toLowerCase(); }
      return permitted === '/' || target === permitted || target.startsWith(`${permitted}/`);
    });
  } catch { /* Only report the result, never settings contents or parse errors. */ }
  return [
    { id: 'agy.permissions.read', status: allowed ? 'PASS' : 'FAIL',
      message: allowed ? 'agy permits reading review worktrees.' : 'agy settings do not allow reading review worktrees.',
      ...(!allowed ? { fix: `Add ${rule} to permissions.allow in ~/.gemini/antigravity-cli/settings.json.` } : {}) },
    { id: 'agy.permissions.deny', status: 'WARN', message: 'Write and shell deny tool names are unverified (ASSUMPTION 1).',
      fix: 'Suggested permissions.deny rules (unverified): write_file(*), run_command(*). Verify the actual tool names in agy documentation before adding them.' },
  ];
}

export async function checkQwen(endpoint: string): Promise<DoctorCheck> {
  const id = 'qwen.endpoint';
  let url: URL;
  try {
    url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password) throw new Error('not loopback');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
    url.search = ''; url.hash = '';
  } catch { return { id, status: 'FAIL', message: 'Qwen endpoint refused: use an HTTP(S) loopback host (127.0.0.1, ::1 or localhost).' }; }
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000), redirect: 'error' });
    await response.body?.cancel();
    return { id, status: response.ok ? 'PASS' : 'WARN', message: response.ok ? 'Qwen endpoint responds.' : 'Qwen endpoint did not respond successfully; local triage will be skipped.' };
  } catch { return { id, status: 'WARN', message: 'Qwen endpoint unavailable; local triage will be skipped.' }; }
}

export async function readProbe(provider: 'agy' | 'codex', model: string, context: CheckContext): Promise<DoctorCheck> {
  const id = `${provider}.probe`;
  try {
    const head = await command(context, 'git', ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (head.exitCode !== 0) throw new Error('Cannot resolve HEAD');
    const worktree = await createReviewWorktree(context.repoRoot, head.stdout.trim(), context.runner);
    try {
      const expected = (await readFile(path.join(worktree.path, 'README.md'), 'utf8')).split(/\r?\n/)[0]!;
      const prompt = 'Using ONLY file-read tools, return only the first line of README.md. Never write files or run shell commands.';
      let output: string;
      if (provider === 'agy') {
        const result = await command(context, 'agy', ['--model', model, '--sandbox', '--output-format', 'json', '--print-timeout', '30s', `--print=${prompt}`], worktree.path);
        if (result.exitCode !== 0) throw new Error('Probe failed');
        const envelope = JSON.parse(result.stdout) as { status?: unknown; response?: unknown };
        if (envelope.status !== 'SUCCESS' || typeof envelope.response !== 'string') throw new Error('Invalid response');
        output = envelope.response;
      } else {
        const temp = await mkdtemp(path.join(tmpdir(), 'quorum-doctor-'));
        try {
          const file = path.join(temp, 'response.txt');
          const result = await command(context, 'codex', ['exec', '-C', worktree.path, '-s', 'read-only', '-o', file, '-'], worktree.path, prompt);
          if (result.exitCode !== 0) throw new Error('Probe failed');
          output = await readFile(file, 'utf8');
        } finally { await rm(temp, { recursive: true, force: true }); }
      }
      if (!await isClean(worktree.path, context.runner)) throw new Error('Probe dirtied worktree');
      if (output.trim() !== expected.trim()) throw new Error('README first line mismatch');
      return { id, status: 'PASS', message: `${provider} read the first line of README.md in a clean disposable worktree.` };
    } finally { await worktree.cleanup(); }
  } catch {
    return { id, status: 'FAIL', message: `${provider} read-only probe failed.`,
      fix: provider === 'agy' ? `Verify the agy login and read_file(${permissionPath(path.join(context.repoRoot, '.quorum', 'worktrees'))}) permission.` : 'Run codex login and verify read-only sandbox access.' };
  }
}
