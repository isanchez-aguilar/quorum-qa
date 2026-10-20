import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir as userHome } from 'node:os';
import { resolveCommand } from '../checks/resolver.js';
import { runCommand } from '../process/runner.js';
import { parseAgyQuota } from '../providers/agy.js';
import type { CommandRunner, QuorumConfig } from '../types/index.js';
import { checkPermissions, checkQwenModels, command, readProbe } from './checks.js';
import { QwenProvider } from '../providers/qwen.js';
import { CodeGraphContextProvider, hasCodeGraphIndex } from '../context/codegraph.js';
import type { DoctorCheck } from './checks.js';
import { ConfigError } from '../config/schema.js';
import { RULES_FILE_NAME, validateRules } from '../rules/index.js';

export type { DoctorCheck } from './checks.js';
export interface DoctorOptions { runner?: CommandRunner; env?: NodeJS.ProcessEnv; homedir?: string; repoRoot?: string; probe?: boolean; fetch?: typeof globalThis.fetch }

export async function runDoctor(config: QuorumConfig | undefined, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const context = { runner: options.runner ?? runCommand, env: options.env ?? process.env, repoRoot: options.repoRoot ?? process.cwd() };
  const results: DoctorCheck[] = [];
  try {
    const text = await readFile(path.join(context.repoRoot, RULES_FILE_NAME), 'utf8');
    const rules = validateRules(JSON.parse(text.replace(/^\uFEFF/, '')));
    results.push({ id: 'rules', status: 'PASS', message: `${RULES_FILE_NAME} is valid (${rules.length} rules).` });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const problem = error instanceof ConfigError ? error.issues[0]
        : error instanceof SyntaxError ? 'invalid JSON' : String(error);
      results.push({ id: 'rules', status: 'WARN', message: `${RULES_FILE_NAME}: ${problem}` });
    }
  }
  if (config?.checks.length && !config.setup?.length && existsSync(path.join(context.repoRoot, 'package.json'))) {
    results.push({ id: 'checks.setup', status: 'WARN', message: 'checks run in a fresh worktree without node_modules',
      fix: 'Configure setup argv commands to install dependencies before checks.' });
  }
  const indexFound = await hasCodeGraphIndex(context.repoRoot);
  if (config?.context?.provider === 'codegraph') {
    const provider = new CodeGraphContextProvider({ env: context.env });
    let available = false;
    if (indexFound && await provider.available(context.repoRoot)) {
      try {
        const resolved = provider.resolveInvocation(['--version'], context.repoRoot);
        const version = await context.runner(resolved.file, resolved.args, { cwd: context.repoRoot, env: context.env, timeoutMs: 10_000,
          windowsVerbatimArguments: resolved.windowsVerbatimArguments });
        available = version.exitCode === 0;
      } catch { /* Optional context never fails doctor. */ }
    }
    results.push({ id: 'context.codegraph', status: available ? 'PASS' : 'WARN',
      message: available ? 'CodeGraph context is available; the index may be stale.' : 'CodeGraph context unavailable (no .codegraph index, codegraph not on PATH, or --version failed); using git context.' });
  } else if (indexFound) results.push({ id: 'context.codegraph', status: 'PASS', message: 'CodeGraph index found; set context.provider to use it' });
  if (!config) results.push({ id: 'config', status: 'FAIL', message: 'quorum.config.json is missing.', fix: 'Create quorum.config.json with the repository checks and configured model ids.' });
  const run = async (name: string, args: string[]) => {
    try { return await command(context, name, args); } catch { return undefined; }
  };
  const git = await run('git', ['rev-parse', '--is-inside-work-tree']);
  results.push({ id: 'git.repo', status: git?.exitCode === 0 && git.stdout.trim() === 'true' ? 'PASS' : 'FAIL',
    message: git?.exitCode === 0 && git.stdout.trim() === 'true' ? 'Git repository detected.' : 'Git repository not detected. Run quorum from a valid repository root.' });
  for (const [index, argv] of (config?.checks ?? []).entries()) {
    try {
      resolveCommand(argv[0]!, argv.slice(1), { env: context.env, cwd: context.repoRoot });
      results.push({ id: `check.${index}`, status: 'PASS', message: `Configured check ${argv[0]} resolves.` });
    } catch { results.push({ id: `check.${index}`, status: 'FAIL', message: `Configured check ${argv[0]} cannot be resolved safely.`, fix: 'Install the executable or update quorum.config.json.' }); }
  }
  const agy = await run('agy', ['--help']);
  results.push({ id: 'agy.path', status: agy?.exitCode === 0 ? 'PASS' : 'FAIL', message: agy?.exitCode === 0 ? 'agy is available (version unknown).' : 'agy --help failed; install agy and check PATH.' });
  const models = await run('agy', ['models']);
  const listed = new Set(models?.exitCode === 0 ? models.stdout.split(/\r?\n/).filter(line => line.includes('\t')).map(line => line.split('\t')[0]!.trim()) : []);
  results.push({ id: 'agy.models', status: models?.exitCode === 0 && listed.size > 0 ? 'PASS' : 'FAIL', message: listed.size ? 'agy models are readable.' : 'agy models failed; open agy interactively and sign in.' });
  const names = [...Object.values(config?.tiers ?? {}).flat(), ...Object.values(config?.escalate.routes ?? {}).flat()];
  const configured = [...new Set(names.filter((ref: string) => ref.startsWith('agy:')).map((ref: string) => ref.slice(4)))];
  for (const model of configured) results.push({ id: `agy.model.${model}`, status: listed.has(model) ? 'PASS' : 'FAIL', message: listed.has(model) ? `${model} is available.` : `Configured model ${model} is not in agy models.`, ...(!listed.has(model) ? { fix: 'Update quorum.config.json to an available model id.' } : {}) });
  const usage = await run('agy', ['--output-format', 'json', '--print-timeout', '30s', '--print=/usage']);
  const quotaModels = configured.length ? configured : ['gemini-3.8-flash-medium'];
  const readable = usage?.exitCode === 0 && quotaModels.every(model => parseAgyQuota(usage.stdout, model) !== 'unknown');
  results.push({ id: 'agy.quota', status: readable ? 'PASS' : 'WARN', message: readable ? 'agy quota is readable.' : 'Could not read agy quota; floor unchecked.' });
  results.push(...await checkPermissions(options.homedir ?? userHome(), context.repoRoot));
  const codex = await run('codex', ['--version']);
  results.push({ id: 'codex.path', status: codex?.exitCode === 0 ? 'PASS' : 'FAIL', message: codex?.exitCode === 0 ? 'Codex is available.' : 'codex --version failed; install Codex and check PATH.' });
  const docker = await run('docker', ['--version']);
  const podman = docker?.exitCode === 0 ? undefined : await run('podman', ['--version']);
  const container = docker?.exitCode === 0 || podman?.exitCode === 0;
  results.push({ id: 'container', status: container ? 'PASS' : 'WARN', message: container ? 'Container runtime is available.' : 'Neither Docker nor Podman is available; reproduction requires explicit interactive confirmation.' });
  const required = (provider: string) => names.some(ref => ref === provider || ref.startsWith(`${provider}:`));
  const claude = await run('claude', ['--version']);
  results.push({ id: 'claude.path', status: claude?.exitCode === 0 ? 'PASS' : required('claude') ? 'FAIL' : 'WARN',
    message: claude?.exitCode === 0 ? 'Claude Code is available.' : 'claude --version failed; install Claude Code and check PATH.' });
  const qwen = new QwenProvider({ ...config?.qwen, fetch: options.fetch });
  const local = config?.qwen || required('qwen') ? await checkQwenModels(qwen, required('qwen')) : undefined;
  if (local) results.push(...local.checks);
  if (options.probe) {
    const model = configured.find(id => listed.has(id));
    results.push(model ? await readProbe('agy', model, context) : { id: 'agy.probe', status: 'FAIL', message: 'No configured agy model is listed by agy models; read probe skipped.' });
    results.push(await readProbe('codex', 'codex', context));
    if (required('claude')) {
      const ref = names.find(ref => ref === 'claude' || ref.startsWith('claude:'))!;
      results.push(await readProbe('claude', ref.split(':')[1] ?? 'sonnet', context));
    } else results.push({ id: 'claude.probe', status: 'WARN', message: 'Claude probe skipped: provider is not configured in tiers or routes.' });
    if (required('qwen') && local?.model) {
      try {
        const answer = await qwen.complete(local.model, 'Reply with OK', { deadlineMs: 30_000 }, 'You are a local connectivity probe. Reply with OK.');
        const accepted = answer?.trim().replace(/\p{P}+$/u, '').toUpperCase() === 'OK';
        results.push({ id: 'qwen.probe', status: accepted ? 'PASS' : 'FAIL', message: accepted ? 'Qwen replied with OK.' : 'Qwen probe did not reply with OK.' });
      } catch { results.push({ id: 'qwen.probe', status: 'FAIL', message: 'Qwen chat probe failed.' }); }
    } else results.push({ id: 'qwen.probe', status: required('qwen') ? 'FAIL' : 'WARN', message: 'Qwen probe skipped: no configured, available model.' });
  }
  return results;
}
