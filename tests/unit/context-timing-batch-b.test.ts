import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { fastest, expectLinear } from '../helpers/timing.js';
import { parseSymbols } from '../../src/context/codegraph.js';

it('M5: preserves symbol formats, whitespace and invalid-location rejection', () => {
  for (const dash of ['-', '—', '–']) for (const gap of ['', ' ', '\t', '\r ']) {
    expect(parseSymbols(` ${gap}-${gap}\` x \`${gap}(${gap}fn${gap}) arbitrary ${dash}${gap}:${gap}12 \t`))
      .toEqual([{ name: 'x', kind: 'fn', startLine: 12 }]);
  }
  expect(parseSymbols('- `x` ( ) - : 1')).toEqual([{ name: 'x', kind: '', startLine: 1 }]);
  for (const line of ['- `` (fn) - : 1', '- `x` () - : 1', '- `x` (\r) - : 1', '- `x` ((fn)) - : 1',
    '- `x` (fn) - : 0', '- `x` (fn) - : -1', '- `x` (fn) - : 9007199254740992', '- `x` (fn) - : 1x',
    '- `x` (fn) text\u2028text - : 1']) expect(parseSymbols(line)).toEqual([]);
});

it.each([256 * 1024, 1024 * 1024])('M5: malformed symbol line of %i bytes is bounded', async size => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ parseSymbols }) => {
      const input = '- \u0060x\u0060 (fn) ' + ' '.repeat(workerData.size) + 'x';
      const fastest = ${fastest.toString()};
      const best = fastest(() => {
        const symbols = parseSymbols(input);
        if (symbols.length) throw new Error('Malformed line accepted');
      });
      parentPort.postMessage(best);
    });
  `, { eval: true, workerData: { module: new URL('../../dist/context/codegraph.js', import.meta.url).href, size } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const elapsed = await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => resolve(Infinity), 3000);
      worker.once('message', resolve); worker.once('error', reject);
    });
    expect(elapsed).toBeLessThan(100);
  } finally { clearTimeout(timer); await worker.terminate(); }
});

it('M5: symbol parsing scales linearly from 64 KiB to 256 KiB (best of five)', () => {
  const inputs = new Map([64 * 1024, 256 * 1024].map(size => [size, '- `x` (fn) ' + ' '.repeat(size) + 'x']));
  expectLinear(size => { parseSymbols(inputs.get(size)!); }, 64 * 1024, 256 * 1024, { maxRatio: 8 });
});

it.each([['acceptanceCriteria', '# '], ['acceptanceCriteria', '- [ ] '], ['contractClauses', '- ']])(
  'M5: %s rejects an interior Unicode line separator in linear time (%s)', async (fn, prefix) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.module).then(module => {
        const fastest = ${fastest.toString()};
        const input = workerData.prefix + ' '.repeat(65536) + 'x\u2028x';
        parentPort.postMessage(fastest(() => module[workerData.fn](input)));
      });
    `, { eval: true, workerData: { module: new URL('../../dist/modes/index.js', import.meta.url).href, fn, prefix } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const elapsed = await new Promise<number>((resolve, reject) => {
        timer = setTimeout(() => resolve(Infinity), 3000);
        worker.once('message', resolve); worker.once('error', reject);
      });
      expect(elapsed).toBeLessThan(100);
    } finally { clearTimeout(timer); await worker.terminate(); }
  },
);
