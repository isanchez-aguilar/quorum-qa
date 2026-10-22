import { expect, it } from 'vitest';
import { validateConfig } from '../../src/config/schema.js';
import { buildRuntimeReport, runtimeMarkdown, runtimeSarif } from '../../src/reporters/runtime.js';
import { stableObservations } from '../../src/runtime/stable.js';
import type { RuntimeReport } from '../../src/runtime/report.js';

const config = validateConfig({ checks: [], runtime: { flows: [{ name: 'home', steps: [{ goto: '/' }, { fill: 'input', value: 'PRIVATE_VALUE' }] }] } }).runtime!;
function report(strictFlows = false) {
  const make = (head: boolean) => {
    const data: RuntimeReport = { version: 1, runs: ([1, 2] as const).map(run => ({ flow: 'home', run, completed: !head,
      observations: [{ kind: 'console', message: 'existing' }, ...(head ? [
        { kind: 'console' as const, message: 'PRIVATE_VALUE | <script>`bad`\n[link](https://evil.test) ' + 'x'.repeat(400), path: '/PRIVATE_VALUE' },
        { kind: 'flow-failure' as const, step: 1, message: 'PRIVATE_VALUE missing', errorClass: 'selector' as const },
      ] : [])], blockedExternal: { 'PRIVATE_VALUE.test': 2 }, notes: [],
    })) };
    return { report: data, stable: stableObservations(data), durationMs: 1, shots: [] };
  };
  return buildRuntimeReport({ available: true, reasons: [], notes: ['PRIVATE_VALUE <script>'], base: make(false), head: make(true) }, config, { strictFlows });
}
it('escapes hostile page Markdown and caps messages, without fill values in any output', () => {
  const value = report(); const markdown = runtimeMarkdown(value).join('\n');
  expect(markdown).toContain('\\|'); expect(markdown).toContain('&lt;script&gt;'); expect(markdown).toContain('&#96;');
  expect(markdown).not.toContain('[link](https://evil.test)'); expect(markdown).not.toContain('x'.repeat(301));
  expect(markdown).toContain('NEW RUNTIME PROBLEMS'); expect(markdown).toContain('exit 1');
  for (const output of [markdown, JSON.stringify(value), JSON.stringify(runtimeSarif(value)), value.summary]) expect(output).not.toContain('PRIVATE_VALUE');
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
});
it('uses error/warning/note levels and config/logical locations without source lines', () => {
  const results = runtimeSarif(report());
  expect(results.map(item => [item.ruleId, item.level])).toEqual([
    ['quorum-runtime/console', 'error'], ['quorum-runtime/flow-failure', 'warning'], ['quorum-runtime/console', 'note'],
  ]);
  for (const result of results) {
    expect(result.locations[0]!.physicalLocation.artifactLocation.uri).toBe('quorum.config.json');
    expect(result.locations[0]!.physicalLocation).not.toHaveProperty('region');
    expect(result.locations[0]!.logicalLocations[0]!.name).toBe('home');
  }
  expect(results[1]!.locations[0]!.logicalLocations[1]!.name).toBe('step 1');
  expect(runtimeSarif(report(true))[1]!.level).toBe('error');
});
it('reports reasons and unknown coverage even without either side', () => {
  const value = buildRuntimeReport({ available: false, reasons: ['not ready'], notes: [] }, config, { strictFlows: false });
  expect(value.verdict).toBe('UNKNOWN');
  expect(runtimeMarkdown(value).join('\n')).toContain('not ready');
  expect(runtimeMarkdown(value).join('\n')).toContain('only the listed flows');
  expect(runtimeSarif(value)).toEqual([]);
});
