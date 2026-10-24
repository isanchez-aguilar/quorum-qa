import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function compare(a, b) {
  const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return item !== null && typeof item === 'object' ? flatten(item, name) : [[name, item]];
  });
  const left = Object.fromEntries(flatten(a.totals));
  const right = Object.fromEntries(flatten(b.totals));
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().map(metric => {
    const before = left[metric] ?? (metric.startsWith('exitCodes.') ? 0 : null);
    const after = right[metric] ?? (metric.startsWith('exitCodes.') ? 0 : null);
    return { metric, before, after, delta: typeof before === 'number' && typeof after === 'number' ? after - before : null };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node bench/compare.mjs <summaryA.json> <summaryB.json>');
    const [a, b] = await Promise.all(process.argv.slice(2).map(async file => JSON.parse(await readFile(file, 'utf8'))));
    console.log('| Metric | A | B | Delta (B - A) |\n| --- | ---: | ---: | ---: |');
    for (const row of compare(a, b)) console.log(`| ${row.metric} | ${row.before ?? 'n/a'} | ${row.after ?? 'n/a'} | ${row.delta ?? 'n/a'} |`);
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
