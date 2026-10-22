import { expect } from 'vitest';

export function fastest(fn: () => Promise<unknown>, runs?: number): Promise<number>;
export function fastest(fn: () => void, runs?: number): number;
export function fastest(fn: () => unknown, runs = 3): number | Promise<number> {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('runs must be a positive integer');
  let best = Infinity;
  const sample = (remaining: number): number | Promise<number> => {
    const start = performance.now();
    const result = fn();
    const finish = () => {
      best = Math.min(best, performance.now() - start);
      return remaining > 1 ? sample(remaining - 1) : best;
    };
    return result instanceof Promise ? result.then(finish) : finish();
  };
  return sample(runs);
}

export function expectLinear(run: (size: number) => void, small: number, large: number, { maxRatio }: { maxRatio: number }): void {
  run(small); run(large);
  const smallMs = fastest(() => run(small), 5);
  const largeMs = fastest(() => run(large), 5);
  expect(largeMs / Math.max(smallMs, Number.EPSILON)).toBeLessThan(maxRatio);
}
