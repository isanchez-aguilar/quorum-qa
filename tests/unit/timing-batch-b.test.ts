import { expect, it, vi } from 'vitest';
import { fastest, expectLinear } from '../helpers/timing.js';

it('T1: fastest filters load noise without relaxing the bound', () => {
  const clock = vi.spyOn(performance, 'now');
  for (const value of [0, 500, 1000, 1001, 2000, 2002]) clock.mockReturnValueOnce(value);
  try { expect(fastest(() => {})).toBe(1); } finally { clock.mockRestore(); }
});
it('T1: fastest propagates failures and measures async executions', async () => {
  expect(() => fastest(() => { throw new Error('failed'); })).toThrow('failed');
  let calls = 0;
  expect(await fastest(async () => { calls++; })).toBeGreaterThanOrEqual(0);
  expect(calls).toBe(3);
});
it('T1: scaling rejects quadratic work even when absolute times are small', () => {
  let time = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
  try {
    expectLinear(size => { time += size; }, 1, 4, { maxRatio: 8 });
    expect(() => expectLinear(size => { time += size * size; }, 1, 4, { maxRatio: 8 })).toThrow();
  } finally { clock.mockRestore(); }
});
