import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { canonicalPath } from '../../src/paths.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'quorum-paths-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('canonicalizes existing roots and explicitly permitted missing descendants', async () => {
  expect(canonicalPath(root)).toBe(await realpath(root));
  expect(canonicalPath(path.join(root, 'missing', 'leaf'), true)).toBe(path.join(await realpath(root), 'missing', 'leaf'));
  expect(() => canonicalPath(path.join(root, 'missing'))).toThrow();
});

it('does not treat dangling links or non-directory parents as missing paths', async () => {
  await symlink(path.join(root, 'missing'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => canonicalPath(path.join(root, 'link'), true)).toThrow();
  expect(() => canonicalPath(path.join(root, 'link', 'leaf'), true)).toThrow();
  await writeFile(path.join(root, 'file'), 'synthetic');
  expect(() => canonicalPath(path.join(root, 'file', 'leaf'), true)).toThrow();
});

it('resolves linked ancestors without claiming they are safe for writes', async () => {
  await mkdir(path.join(root, 'target'));
  await symlink(path.join(root, 'target'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(canonicalPath(path.join(root, 'link', 'new'), true)).toBe(path.join(await realpath(root), 'target', 'new'));
});
