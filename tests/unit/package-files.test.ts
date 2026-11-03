import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

it('packs the CLI, its runtime scripts and the license, and nothing internal', () => {
  // npm.cmd needs a shell on Windows; the arguments are fixed literals.
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  const files: string[] = JSON.parse(output)[0].files.map((file: { path: string }) => file.path.replace(/\\/g, '/'));
  for (const required of ['bin/quorum.js', 'dist/cli/index.js', 'src/runtime/runner.cjs', 'src/runtime/scrub.cjs',
    'src/runtime/collector.cjs', 'LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md', 'package.json']) expect(files).toContain(required);
  const internal = files.filter(file => /^(tests|bench|docs|plugin|scripts|\.ai|\.claude|\.claude-plugin|\.quorum)\//.test(file)
    || /^(AGENTS|CLAUDE|GEMINI|CONTRIBUTING)\.md$/.test(file) || file.endsWith('.map')
    || (file.startsWith('src/') && !file.endsWith('.cjs')));
  expect(internal).toEqual([]);
}, 60_000);
