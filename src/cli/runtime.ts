import type { RuntimeConfig } from '../runtime/config.js';
import { UsageError } from './args.js';
import type { CliIo } from './index.js';

export function runtimeReview(config: RuntimeConfig | undefined, dryRun: boolean, io: CliIo): number {
  for (const key of ['start', 'readyUrl', 'flows'] as const) {
    if (!config?.[key]) throw new UsageError(`runtime.${key} is required in runtime mode.`);
  }
  const runtime = config!;
  if (!dryRun) {
    io.err('runtime mode: the collector and container orchestration are not built yet (R1-R3)\n');
    return 2;
  }
  io.out('Runtime plan (no commands run):\n'
    + `  Start: ${runtime.start!.join(' ')}\n`
    + `  Ready URL: ${runtime.readyUrl}\n`
    + `  Flows: ${runtime.flows!.length}; steps: ${runtime.flows!.reduce((count, flow) => count + flow.steps.length, 0)}\n`
    + `  Timeouts: ready ${runtime.readyTimeoutSeconds}s; flow ${runtime.flowTimeoutSeconds}s; step ${runtime.stepTimeoutSeconds}s\n`
    + `  Image: ${runtime.image ?? 'default (not pinned yet)'}\n`
    + `  Limits: ${runtime.memoryMiB} MiB; ${runtime.pids} pids\n`
    + `  Screenshots: ${runtime.screenshots ? 'on' : 'off'}\n`);
  return 0;
}
