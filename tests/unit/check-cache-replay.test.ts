import { expect, it } from 'vitest';
import { cacheReplay } from '../../src/checks/output.js';

it.each([
  [' Tasks:    13 successful, 13 total\nCached:    13 cached, 13 total\n  Time:    1.2s >>> FULL TURBO', '13 of 13 tasks replayed from the Turbo cache'],
  ['Tasks:    5 successful, 5 total\nCached:    2 cached, 5 total\n  Time:    9s', '2 of 5 tasks replayed from the Turbo cache'],
  ['\x1b[1mCached:\x1b[0m    3 cached, 3 total', '3 of 3 tasks replayed from the Turbo cache'],
  ['  Time:    80ms >>> FULL TURBO', 'replayed from the Turbo cache'],
  ['Nx read the output from the cache instead of running the command for 4 out of 6 tasks.', '4 of 6 tasks replayed from the Nx cache'],
  ['Nx read the output from the cache instead of running the command for 1 out of 1 task.', '1 of 1 tasks replayed from the Nx cache'],
])('detects a cache replay in %j', (output, expected) => {
  expect(cacheReplay(output)).toBe(expected);
});

it.each([
  'Tasks:    13 successful, 13 total\nCached:    0 cached, 13 total',
  'Nx read the output from the cache instead of running the command for 0 out of 6 tasks.',
  '# tests 491\n# pass 491',
  'src/cache.ts: FULL coverage',
  '✓ supports FULL TURBO mode',
  'Cached:    0 cached, 13 total\n  Time:    9s >>> FULL TURBO',
  '  log: Cached: 3 cached, 3 total (quoted inside another line)',
  '',
])('reports a real run for %j', output => {
  expect(cacheReplay(output)).toBeUndefined();
});
