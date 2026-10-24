import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from '../dist/process/runner.js';
import { markdown, scoreCase, summarize } from './score.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const casesRoot = path.join(root, 'bench', 'cases');

export function parseArgs(args) {
  const options = { repeat: 1, dryRun: false, timeoutMs: 1_320_000 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (!['--cases', '--out', '--repeat', '--config', '--timeout-ms', '--mode'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--cases') options.cases = value.split(',');
    else if (arg === '--repeat') options.repeat = Number(value);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value);
    else options[arg.slice(2)] = value;
  }
  for (const key of ['repeat', 'timeoutMs']) if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer`);
  if (options.mode && !['general', 'feature'].includes(options.mode)) throw new Error('mode must be general or feature');
  return options;
}

export async function loadCases(ids) {
  const available = (await readdir(casesRoot, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort();
  const selected = ids ?? available;
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !available.includes(id))) throw new Error('Unknown, empty or duplicate case selection');
  return Promise.all(selected.map(async id => JSON.parse(await readFile(path.join(casesRoot, id, 'case.json'), 'utf8'))));
}

function validReport(report) {
  const finding = item => item && typeof item.file === 'string' && Number.isInteger(item.line) && item.line > 0
    && ['OPTIONAL', 'IMPORTANT', 'BLOCKER'].includes(item.severity)
    && (item.confirmationFamilies === undefined || (Array.isArray(item.confirmationFamilies) && item.confirmationFamilies.every(family => typeof family === 'string')));
  return report && Array.isArray(report.findings) && report.findings.every(finding)
    && Array.isArray(report.unconfirmed) && report.unconfirmed.every(finding)
    && Array.isArray(report.ledgerDraft) && report.ledgerDraft.every(item => item && Number.isSafeInteger(item.callsUsed) && item.callsUsed >= 0)
    && (report.rejectedOnConfirmation === undefined || (Array.isArray(report.rejectedOnConfirmation) && report.rejectedOnConfirmation.every(item => item && finding(item.finding))));
}

async function prepare(testCase, config, tmp) {
  const cwd = path.join(tmp, 'repo');
  await mkdir(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
    GIT_AUTHOR_NAME: 'Benchmark', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
    GIT_COMMITTER_NAME: 'Benchmark', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid' };
  // Do not inherit a caller's index, worktree or injected Git configuration.
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/.test(key)) delete env[key];
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  const git = async args => {
    const result = await runCommand('git', ['-c', 'core.hooksPath=' + path.join(tmp, 'no-hooks'), '-c', 'commit.gpgsign=false', ...args], { cwd, env, timeoutMs: 30_000 });
    if (result.exitCode) throw new Error(`Temporary git ${args[0]} failed: ${result.stderr}`);
  };
  await git(['init', '--initial-branch=main']);
  const source = path.join(casesRoot, testCase.id);
  await cp(path.join(source, 'base'), cwd, { recursive: true });
  await writeFile(path.join(cwd, 'quorum.config.json'), JSON.stringify(config, null, 2));
  await writeFile(path.join(cwd, '.gitignore'), '.quorum/\n');
  await cp(path.join(source, testCase.spec), path.join(cwd, 'spec.md'));
  await git(['add', '.']);
  await git(['commit', '-m', 'Synthetic base']);
  await git(['switch', '-c', 'benchmark-head']);
  for (const entry of await readdir(path.join(source, 'base'))) await rm(path.join(cwd, entry), { recursive: true, force: true });
  await cp(path.join(source, 'head'), cwd, { recursive: true });
  await git(['add', '-A']);
  await git(['commit', '-m', 'Synthetic change']);
  return { cwd, env };
}

export async function runBench(options = {}, dependencies = {}) {
  const runner = dependencies.runner ?? runCommand;
  const print = dependencies.print ?? (value => console.log(value));
  const selected = await loadCases(options.cases);
  const raw = JSON.parse((await readFile(path.resolve(options.config ?? path.join(root, 'quorum.config.json')), 'utf8')).replace(/^\uFEFF/, ''));
  const config = { base: 'main', checks: [], setup: [], context: { provider: 'git' },
    tiers: raw.tiers, ...(raw.budget ? { budget: raw.budget } : {}), ...(raw.escalate ? { escalate: raw.escalate } : {}) };
  const rows = [], plans = [];
  for (let repeat = 1; repeat <= (options.repeat ?? 1); repeat++) for (const testCase of selected) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'quorum-bench-'));
    let start, result, report, failure, wallMs = 0;
    try {
      const { cwd, env } = await prepare(testCase, config, tmp);
      const mode = options.mode ?? testCase.mode;
      if (!['general', 'feature'].includes(mode)) throw new Error('mode must be general or feature');
      const args = [path.join(root, 'bin', 'quorum.js'), 'review', '--mode', mode,
        ...(mode === 'feature' ? ['--spec', 'spec.md'] : []), '--diff', 'main...HEAD', '--json', '--no-cache', '--out', path.join(tmp, 'report.md')];
      if (options.dryRun) args.push('--dry-run');
      start = performance.now();
      result = await runner(process.execPath, args, { cwd, env, timeoutMs: options.timeoutMs ?? 1_320_000, maxOutputBytes: 16 * 1024 * 1024 });
      if (options.dryRun) {
        const initialCalls = Number(result.stdout.match(/Review chunks: (\d+)/)?.[1]);
        const maxCalls = Number(result.stdout.match(/Max API Calls: (\d+)/)?.[1]);
        if (result.exitCode !== 0 || !Number.isFinite(initialCalls) || !Number.isFinite(maxCalls)) throw new Error('Invalid dry-run plan');
        plans.push({ id: testCase.id, repeat, initialCalls, maxCalls });
        print(`${testCase.id} #${repeat}: ${initialCalls} initial calls; ceiling ${maxCalls}`);
      } else {
        const parsed = JSON.parse(result.stdout);
        if (!validReport(parsed)) throw new Error('Invalid review JSON');
        report = parsed;
      }
    } catch (error) { failure = error.name === 'CommandTimeoutError' ? 'timeout' : 'error'; }
    finally {
      wallMs = start === undefined ? 0 : Math.round(performance.now() - start);
      await rm(tmp, { recursive: true, force: true });
    }
    if (options.dryRun) {
      if (failure) throw new Error(`Dry-run failed for ${testCase.id}`);
      continue;
    }
    rows.push({ id: testCase.id, kind: testCase.kind, repeat,
      status: failure ?? (result.exitCode > 1 || report.errors?.length ? 'error' : 'ok'),
      exitCode: result?.exitCode ?? null, wallMs,
      calls: report?.ledgerDraft.reduce((n, item) => n + item.callsUsed, 0) ?? null,
      score: scoreCase(testCase, report ?? {}), report: report ?? null });
  }
  if (options.dryRun) {
    const totals = { initialCalls: plans.reduce((n, p) => n + p.initialCalls, 0), maxCalls: plans.reduce((n, p) => n + p.maxCalls, 0) };
    print(`Total: ${totals.initialCalls} initial calls; ceiling ${totals.maxCalls}. No providers called.`);
    return { plans, totals };
  }
  const summary = { version: 1, timestamp: new Date().toISOString(), config, cases: rows, totals: summarize(rows) };
  const out = path.resolve(options.out ?? path.join(root, '.quorum', 'bench', summary.timestamp.replaceAll(':', '-')));
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(path.join(out, 'summary.md'), markdown(summary));
  print(markdown(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = await runBench(parseArgs(process.argv.slice(2))); if (result.totals.failedRuns) process.exitCode = 2; }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
