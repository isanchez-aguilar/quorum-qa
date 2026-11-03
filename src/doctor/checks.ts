import { canonicalPath } from '../paths.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandRunner } from '../types/index.js';
import { resolveCommand } from '../checks/resolver.js';
import { createReviewWorktree, isClean } from '../worktree/index.js';
import { CLAUDE_LOGIN_HINT, claudeArgs, claudeAnswer, claudeAuthFailure, claudeEnvelope } from '../providers/claude.js';
import { QwenProvider } from '../providers/qwen.js';
import { loopbackUrl } from '../providers/loopback.js';

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
  value = canonicalPath(value, true);
  const normalized = value.replace(/\\/g, '/').replace(/^[a-z]:/i, '');
  return path.posix.normalize(normalized).replace(/\/$/, '') || '/';
}

export async function checkPermissions(homedir: string, repoRoot: string): Promise<DoctorCheck[]> {
  const parent = permissionPath(path.join(repoRoot, '.quorum', 'worktrees'));
  const rule = `read_file(${parent})`;
  let allowed = false;
  try {
    // PowerShell writes a UTF-8 BOM, which agy accepts and JSON.parse does not.
    const text = (await readFile(path.join(canonicalPath(homedir), '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).replace(/^﻿/, '');
    const settings: unknown = JSON.parse(text);
    const allow = (settings as { permissions?: { allow?: unknown } } | null)?.permissions?.allow;
    const deny = (settings as { permissions?: { deny?: unknown } } | null)?.permissions?.deny;
    const covers = (entry: unknown): boolean => {
      if (typeof entry !== 'string') return false;
      const match = /^read_file\(([^\r\n]+)\)$/.exec(entry);
      if (match?.[1] === '*') return true;
      if (!match || !match[1]!.startsWith('/')) return false;
      // agy rules carry no drive letter. Resolve them on the repository's drive, not the
      // current directory's, or an 8.3 alias in the rule cannot be expanded.
      const drive = process.platform === 'win32' ? /^[a-z]:/i.exec(canonicalPath(repoRoot, true))?.[0] ?? '' : '';
      let permitted = permissionPath(drive + match[1]!.replace(/\/\*\*?$/, ''));
      let target = parent;
      if (process.platform === 'win32') { permitted = permitted.toLowerCase(); target = target.toLowerCase(); }
      return permitted === '/' || target === permitted || target.startsWith(`${permitted}/`);
    };
    allowed = Array.isArray(allow) && allow.some(covers) && !(Array.isArray(deny) && deny.some(covers));
  } catch { /* Only report the result, never settings contents or parse errors. */ }
  return [
    { id: 'agy.permissions.read', status: allowed ? 'PASS' : 'FAIL',
      message: allowed ? 'agy permits reading review worktrees.' : 'agy settings do not allow reading review worktrees or contain a covering read deny rule.',
      ...(!allowed ? { fix: `Add ${rule} to permissions.allow in ~/.gemini/antigravity-cli/settings.json.` } : {}) },
    { id: 'agy.permissions.deny', status: 'WARN', message: 'Write and shell deny tool names are unverified (ASSUMPTION 1).',
      fix: 'Suggested permissions.deny rules (unverified): write_file(*), run_command(*). Verify the actual tool names in agy documentation before adding them.' },
  ];
}

export async function checkQwenModels(provider: QwenProvider, required = false): Promise<{ checks: DoctorCheck[]; model?: string }> {
  const failure = required ? 'FAIL' : 'WARN';
  try {
    if (provider.qwenOptions.endpoint) loopbackUrl(provider.qwenOptions.endpoint, 'models');
  } catch { return { checks: [
    { id: 'qwen.endpoint', status: failure, message: 'Qwen endpoint refused: use an HTTP(S) loopback host (127.0.0.1, ::1 or localhost).' },
    { id: 'qwen.model', status: failure, message: 'Qwen model could not be checked.' },
  ] }; }
  try {
    const models = await provider.listModels();
    const model = provider.qwenOptions.model ?? models[0]!;
    const available = models.includes(model);
    return { ...(available ? { model } : {}), checks: [
      { id: 'qwen.endpoint', status: 'PASS', message: 'Qwen endpoint responds.' },
      { id: 'qwen.model', status: available ? 'PASS' : failure, message: available ? `Qwen model: ${model}.` : `Configured Qwen model ${model} is not listed by /models.` },
    ] };
  } catch (error) { return { checks: [
    { id: 'qwen.endpoint', status: error instanceof Error && error.message.includes('invalid models list') ? 'PASS' : failure, message: 'Qwen models request did not produce a usable model list.' },
    { id: 'qwen.model', status: failure, message: 'Qwen model unavailable; local triage will be skipped.' },
  ] }; }
}

export async function checkQwen(endpoint: string, fetcher: typeof globalThis.fetch = globalThis.fetch): Promise<DoctorCheck> {
  return (await checkQwenModels(new QwenProvider({ endpoint, fetch: fetcher }), true)).checks[0]!;
}

export async function readProbe(provider: 'agy' | 'codex' | 'claude', model: string, context: CheckContext): Promise<DoctorCheck> {
  const id = `${provider}.probe`;
  try {
    const head = await command(context, 'git', ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (head.exitCode !== 0) throw new Error('Cannot resolve HEAD');
    const worktree = await createReviewWorktree(context.repoRoot, head.stdout.trim(), context.runner);
    try {
      const expected = (await readFile(path.join(worktree.path, 'README.md'), 'utf8')).split(/\r?\n/)[0]!;
      // agy headless stops at the first denied command, so it is told to use file-read tools only. Codex reads files
      // through its shell, and its read-only guarantee is the -s read-only sandbox, so its prompt must not forbid commands.
      const prompt = provider === 'agy'
        ? 'Using ONLY file-read tools, return only the first line of README.md. Never write files or run shell commands.'
        : 'Read README.md and return only its first line, with nothing else. Do not modify any file.';
      let output: string;
      if (provider === 'agy') {
        const result = await command(context, 'agy', ['--model', model, '--sandbox', '--output-format', 'json', '--print-timeout', '30s', `--print=${prompt}`], worktree.path);
        if (result.exitCode !== 0) throw new Error(`exit code ${result.exitCode}`);
        const envelope = JSON.parse(result.stdout) as { status?: unknown; response?: unknown };
        if (envelope.status !== 'SUCCESS' || typeof envelope.response !== 'string') throw new Error('Invalid response');
        output = envelope.response;
      } else if (provider === 'claude') {
        const result = await command(context, 'claude', claudeArgs(model), worktree.path, prompt);
        if (claudeAuthFailure(claudeEnvelope(result.stdout))) throw new Error(CLAUDE_LOGIN_HINT);
        if (result.exitCode !== 0) throw new Error(`exit code ${result.exitCode}`);
        const answer = claudeAnswer(claudeEnvelope(result.stdout));
        if (answer === undefined) throw new Error('Invalid response');
        output = answer;
      } else {
        const temp = await mkdtemp(path.join(canonicalPath(tmpdir()), 'quorum-doctor-'));
        try {
          const file = path.join(temp, 'response.txt');
          const result = await command(context, 'codex', ['exec', '-C', worktree.path, '-s', 'read-only', '-o', file, '-'], worktree.path, prompt);
          if (result.exitCode !== 0) throw new Error(`exit code ${result.exitCode}`);
          output = await readFile(file, 'utf8');
        } finally { await rm(temp, { recursive: true, force: true }); }
      }
      if (!await isClean(worktree.path, context.runner)) throw new Error('Probe dirtied worktree');
      if (output.trim() !== expected.trim()) throw new Error('README first line mismatch');
      return { id, status: 'PASS', message: `${provider} read the first line of README.md in a clean disposable worktree.` };
    } finally { await worktree.cleanup(); }
  } catch (error) {
    // Only the reason is reported: never the model output or file contents.
    const reason = error instanceof Error ? error.message.slice(0, 120) : 'unknown error';
    return { id, status: 'FAIL', message: `${provider} read-only probe failed: ${reason}.`,
      fix: provider === 'agy' ? `Verify the agy login and read_file(${permissionPath(path.join(context.repoRoot, '.quorum', 'worktrees'))}) permission.` : `Verify the ${provider} login and read-only access.` };
  }
}
