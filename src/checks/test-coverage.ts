import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether the configured deterministic checks run the project's tests.
 *
 * A repository can configure typecheck and lint and leave its unit tests out
 * (they are slow, or a narrower `test:scripts` stood in for them). Then a
 * change that breaks a test reports «0 failed deterministic checks», which
 * reads as «tests pass» while the repository's own test suite is red. The
 * review says so instead of staying silent.
 */

const TEST_RUNNERS = new Set(['test', 'vitest', 'jest', 'mocha', 'ava', 'tap', 'pytest', 'phpunit', 'rspec']);
const SUBCOMMAND_RUNNERS = new Set(['go', 'cargo', 'dotnet', 'deno', 'bun']);

/** True when some check runs a test runner or a `test` script (`pnpm run test`, `turbo run test --filter=…`, `go test`). */
export function checksRunTests(checks: readonly (readonly string[])[]): boolean {
  return checks.some(argv => argv.some((arg, index) => {
    const name = path.basename(arg).replace(/\.(cmd|exe|bat|js|cjs|mjs)$/i, '').toLowerCase();
    if (TEST_RUNNERS.has(name)) return true;
    return SUBCOMMAND_RUNNERS.has(name) && argv[index + 1] === 'test';
  }));
}

/** True when the repository's package.json declares a non-empty `test` script. */
export async function hasTestScript(root: string): Promise<boolean> {
  try {
    const scripts = (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts;
    const test = scripts?.test;
    return typeof test === 'string' && test.trim().length > 0;
  } catch { return false; }
}

export const UNTESTED_CHECKS_MESSAGE = 'No configured check runs the unit tests although package.json has a "test" script: a change that breaks a test still reports 0 failed deterministic checks.';
export const UNTESTED_CHECKS_FIX = 'Add a check that runs the tests, ideally only the affected packages (for example ["pnpm", "turbo", "run", "test", "--filter=...[origin/main]"]).';
