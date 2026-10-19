import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { main, type CliDependencies } from '../../src/cli/index.js';
import { validateConfig, ConfigError } from '../../src/config/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = path.join(root, 'bin', 'quorum.js');
const builtEntry = path.join(root, 'dist', 'cli', 'index.js');
const version = (
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
).version;

async function run(argv: string[], dependencies?: CliDependencies) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  }, dependencies);
  return { code, out, err };
}

describe('router (in process)', () => {
  it('prints usage and exits 0 on --help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/Usage: quorum/);
    expect(result.err).toBe('');
  });

  it('lets --help win over a command', async () => {
    expect((await run(['review', '--help'])).code).toBe(0);
  });

  it('prints the package version on --version', async () => {
    const result = await run(['--version']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${version}\n`);
  });

  it('requires a specification for feature review', async () => {
    const result = await run(['review']);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--spec is required/);
  });

  it('runs doctor without probes by default and reports WARN without failure', async () => {
    const config = validateConfig({ checks: [] });
    const loadConfig = vi.fn(async () => config);
    const runDoctor = vi.fn<NonNullable<CliDependencies['runDoctor']>>(async () => [
      { id: 'git', status: 'PASS', message: 'Repository found.' },
      { id: 'quota', status: 'WARN', message: 'floor unchecked', fix: 'Sign in.' },
    ]);
    const result = await run(['doctor'], { repoRoot: root, loadConfig, runDoctor });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('[PASS] git: Repository found.');
    expect(result.out).toContain('[WARN] quota: floor unchecked\n  Fix: Sign in.');
    expect(loadConfig).toHaveBeenCalledWith(path.join(root, 'quorum.config.json'));
    expect(runDoctor).toHaveBeenCalledExactlyOnceWith(config, { repoRoot: root, probe: false });
  });

  it('passes --probe explicitly and prints the check list as JSON with exit 2 on FAIL', async () => {
    const config = validateConfig({ checks: [] });
    const checks = [{ id: 'agy', status: 'FAIL' as const, message: 'Missing.', fix: 'Install agy.' }];
    const runDoctor = vi.fn<NonNullable<CliDependencies['runDoctor']>>(async () => checks);
    const result = await run(['doctor', '--probe', '--json'], {
      repoRoot: root,
      loadConfig: async () => config,
      runDoctor,
    });
    expect(result.code).toBe(2);
    expect(result.err).toBe('');
    expect(JSON.parse(result.out)).toEqual(checks);
    expect(runDoctor).toHaveBeenCalledExactlyOnceWith(config, { repoRoot: root, probe: true });
  });

  it('runs doctor even when config is missing', async () => {
    const runDoctor = vi.fn<NonNullable<CliDependencies['runDoctor']>>(async () => [{ id: 'config', status: 'FAIL', message: 'Missing config' }]);
    const result = await run(['doctor', '--json'], {
      loadConfig: async () => { throw new ConfigError(['file not found: quorum.config.json'], 'Cannot load config'); }, runDoctor,
    });
    expect(runDoctor).toHaveBeenCalledOnce();
    expect(JSON.parse(result.out)[0].id).toBe('config');
    expect(result.code).toBe(2);
  });
  it('reports config errors without starting doctor', async () => {
    const runDoctor = vi.fn<NonNullable<CliDependencies['runDoctor']>>();
    const result = await run(['doctor'], {
      loadConfig: async () => { throw new ConfigError(['synthetic invalid config']); },
      runDoctor,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain('synthetic invalid config');
    expect(runDoctor).not.toHaveBeenCalled();
  });

  it('exits 2 on an unknown command', async () => {
    const result = await run(['bogus']);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/Unknown command: bogus/);
  });

  it('exits 2 on an unknown flag', async () => {
    const result = await run(['review', '--nope']);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/Unknown option: --nope/);
  });

  it('exits 2 and prints usage when there is no command', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/Usage: quorum/);
  });
});

describe('bin shim', () => {
  it('says to build first when dist/ is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'quorum-shim-'));
    try {
      mkdirSync(path.join(dir, 'bin'));
      copyFileSync(bin, path.join(dir, 'bin', 'quorum.js'));
      const result = spawnSync(process.execPath, [path.join(dir, 'bin', 'quorum.js'), '--help'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/dist\/ not found\. Run "pnpm build" first/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // These need `pnpm build`. `pnpm test` builds first; running vitest directly without dist fails here on purpose.
  describe('built CLI', () => {
    it('has been built', () => {
      expect(existsSync(builtEntry), 'dist/ is missing: run "pnpm build" (or "pnpm test")').toBe(true);
    });

    it('node bin/quorum.js --help exits 0', () => {
      const result = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8', cwd: root });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Usage: quorum/);
    });

    it('node bin/quorum.js bogus exits 2', () => {
      const result = spawnSync(process.execPath, [bin, 'bogus'], { encoding: 'utf8', cwd: root });
      expect(result.status).toBe(2);
    });
  });
});
