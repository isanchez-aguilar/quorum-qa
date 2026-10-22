import type { RuntimeConfig } from '../runtime/config.js';
import { DEFAULT_RUNTIME_IMAGE } from '../runtime/image.js';
import type { RuntimeEvidence } from '../runtime/run.js';
import { UsageError } from './args.js';
import type { CliIo } from './index.js';

export function runtimeReview(config: RuntimeConfig | undefined, dryRun: boolean, io: CliIo): number {
  for (const key of ['start', 'readyUrl', 'flows'] as const) {
    if (!config?.[key]) throw new UsageError(`runtime.${key} is required in runtime mode.`);
  }
  const runtime = config!;
  if (!dryRun) {
    return 2;
  }
  io.out('Runtime plan (no commands run):\n'
    + `  Start: ${runtime.start!.join(' ')}\n`
    + `  Ready URL: ${runtime.readyUrl}\n`
    + `  Flows: ${runtime.flows!.length}; steps: ${runtime.flows!.reduce((count, flow) => count + flow.steps.length, 0)}\n`
    + `  Timeouts: ready ${runtime.readyTimeoutSeconds}s; flow ${runtime.flowTimeoutSeconds}s; step ${runtime.stepTimeoutSeconds}s\n`
    + `  Image: ${runtime.image ?? DEFAULT_RUNTIME_IMAGE}\n`
    + `  Limits: ${runtime.memoryMiB} MiB; ${runtime.pids} pids\n`
    + `  Screenshots: ${runtime.screenshots ? 'on' : 'off'}\n`);
  return 0;
}

export function printRuntimeEvidence(evidence: RuntimeEvidence, json: boolean, io: CliIo): number {
  const sides = Object.fromEntries((['base', 'head'] as const).map(side => {
    const result = evidence[side];
    return [side, result ? {
      flows: Object.keys(result.stable.flows).length,
      completedRuns: result.report.runs.filter(run => run.completed).length,
      stableSignatures: Object.fromEntries(Object.entries(result.stable.flows).map(([flow, signatures]) => [flow, signatures.size])),
      flaky: result.stable.flaky, incomplete: result.stable.incomplete, durationMs: result.durationMs,
    } : null];
  }));
  const message = 'runtime mode: comparison and verdict arrive in R3';
  if (json) io.out(JSON.stringify({ available: evidence.available, ...sides, reasons: evidence.reasons, notes: evidence.notes, message, exitCode: 2 }, null, 2) + '\n');
  else {
    io.out('Runtime evidence (interim):\n');
    for (const side of ['base', 'head']) {
      const result = sides[side];
      io.out(`  ${side}: ${result ? `${result.flows} flows; ${result.completedRuns} completed runs; stable signatures ${JSON.stringify(result.stableSignatures)}; flaky ${JSON.stringify(result.flaky)}; incomplete ${JSON.stringify(result.incomplete)}` : 'unavailable'}\n`);
    }
    for (const reason of evidence.reasons) io.out(`  Reason: ${reason}\n`);
    for (const note of evidence.notes) io.out(`  Note: ${JSON.stringify(note)}\n`);
  }
  io.err(message + '\n');
  return 2;
}
