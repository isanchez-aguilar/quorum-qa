import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { USAGE } from '../../src/cli/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

it('ships a plugin manifest and a marketplace entry that point at each other', () => {
  const plugin = JSON.parse(read('plugin/.claude-plugin/plugin.json')) as { name: string; version: string; description: string };
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json')) as { plugins: { name: string; source: string }[] };
  expect(plugin.name).toBe('quorum');
  expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(plugin.description.length).toBeGreaterThan(20);
  expect(marketplace.plugins).toContainEqual(expect.objectContaining({ name: 'quorum', source: './plugin' }));
});

it('the /quorum skill has frontmatter and mentions only flags the CLI accepts', () => {
  const skill = read('plugin/skills/quorum/SKILL.md').replace(/\r\n/g, '\n');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
  expect(frontmatter).toMatch(/^name: quorum$/m);
  expect(frontmatter).toMatch(/^description: .{40,}$/m);
  const flags = [...new Set(skill.match(/--[a-z][a-z-]+/g) ?? [])];
  expect(flags.length).toBeGreaterThan(5);
  for (const flag of flags) expect(USAGE, `${flag} is not in the CLI usage`).toContain(flag);
});
