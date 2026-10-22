import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Quorum keeps a per-user secret (the cache MAC key) under the home directory. A test run must
// never create or read files in the developer's real home, so every test worker gets its own.
const home = mkdtempSync(path.join(tmpdir(), 'quorum-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.HOMEDRIVE = '';
process.env.HOMEPATH = '';
process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });
