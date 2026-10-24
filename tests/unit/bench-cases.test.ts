import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runCommand } from '../../src/process/runner.js';

const root = path.resolve('bench/cases');
async function files(dir: string, prefix = ''): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(output, await files(path.join(dir, entry.name), name));
    else output[name] = await readFile(path.join(dir, entry.name), 'utf8');
  }
  return output;
}

it('ships twelve valid, changed, syntactically valid synthetic projects', async () => {
  const ids = await readdir(root);
  expect(ids).toHaveLength(12);
  let seeded = 0;
  for (const id of ids) {
    const dir = path.join(root, id);
    const item = JSON.parse(await readFile(path.join(dir, 'case.json'), 'utf8'));
    expect(Object.keys(item).sort()).toEqual(['id', 'kind', 'mode', 'spec', 'title', 'truth']);
    expect(item.id).toBe(id);
    expect(item.title).toEqual(expect.any(String));
    expect(item.title.length).toBeGreaterThan(0);
    expect(['seeded', 'control']).toContain(item.kind);
    expect(item.mode).toBe('feature');
    expect(item.spec).toBe('spec.md');
    const spec = await readFile(path.join(dir, item.spec), 'utf8');
    const criteria = spec.match(/^- \[[ x]\] .+/gm) ?? [];
    expect(criteria.length).toBeGreaterThanOrEqual(2);
    expect(criteria.length).toBeLessThanOrEqual(4);
    const base = await files(path.join(dir, 'base'));
    const head = await files(path.join(dir, 'head'));
    expect(head).not.toEqual(base);
    for (const [side, snapshot] of [['base', base], ['head', head]] as const) {
      expect(Object.keys(snapshot).length).toBeGreaterThanOrEqual(1);
      expect(Object.keys(snapshot).length).toBeLessThanOrEqual(4);
      for (const file of Object.keys(snapshot)) if (/\.(?:m?[jt]s)$/.test(file)) {
        const parsed = await runCommand(process.execPath, ['--check', path.join(dir, side, file)]);
        expect(parsed.exitCode, `${id}/${side}/${file}: ${parsed.stderr}`).toBe(0);
      }
    }
    expect(Array.isArray(item.truth)).toBe(true);
    if (item.kind === 'control') expect(item.truth).toEqual([]);
    else { seeded++; expect(item.truth.length).toBeGreaterThan(0); }
    for (const truth of item.truth) {
      expect(Object.keys(truth).sort()).toEqual(['class', 'file', 'lines', 'minSeverity']);
      expect(typeof truth.class).toBe('string');
      expect(truth.class.length).toBeGreaterThan(0);
      expect(['IMPORTANT', 'BLOCKER']).toContain(truth.minSeverity);
      expect(head[truth.file]).toBeDefined();
      expect(truth.lines).toHaveLength(2);
      expect(truth.lines.every(Number.isInteger)).toBe(true);
      expect(truth.lines[0]).toBeGreaterThanOrEqual(1);
      expect(truth.lines[1]).toBeGreaterThanOrEqual(truth.lines[0]);
      expect(truth.lines[1]).toBeLessThanOrEqual(head[truth.file]!.trimEnd().split('\n').length);
    }
  }
  expect(seeded).toBe(8);
});
