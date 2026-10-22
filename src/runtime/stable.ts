import type { RuntimeReport } from './report.js';
import { signature } from './signature.js';

export const isScreenshotNote = (note: string): boolean => /^cap: screenshot (?:failed|size|budget|count)$/.test(note);

export function stableObservations(report: RuntimeReport): {
  flows: Record<string, Set<string>>; counts: Record<string, [number, number]>; flaky: string[]; incomplete: string[];
} {
  const flows: Record<string, Set<string>> = Object.create(null) as Record<string, Set<string>>;
  const counts: Record<string, [number, number]> = Object.create(null) as Record<string, [number, number]>;
  const flaky: string[] = []; const incomplete: string[] = [];
  for (const flow of new Set(report.runs.map(run => run.flow))) {
    const runs = [1, 2].map(index => report.runs.find(run => run.flow === flow && run.run === index));
    // Failures are matched by step: the error text of the same failing step may vary between runs.
    const failures = [new Set<number>(), new Set<number>()];
    const sets = runs.map((run, index) => {
      const set = new Set<string>();
      for (const observation of run?.observations ?? []) {
        const key = signature(observation, flow); if (key === undefined) continue;
        set.add(key); (counts[key] ??= [0, 0])[index as 0 | 1]++;
        if (observation.kind === 'flow-failure' && observation.step !== undefined) failures[index]!.add(observation.step);
      }
      return set;
    });
    flows[flow] = new Set([...sets[0]!].filter(key => sets[1]!.has(key)));
    const stableFailure = [...failures[0]!].some(step => failures[1]!.has(step));
    if (Boolean(runs[0]?.completed) !== Boolean(runs[1]?.completed)
      || [...failures[0]!, ...failures[1]!].some(step => !failures[0]!.has(step) || !failures[1]!.has(step))) flaky.push(flow);
    // Even a truncated message/path can hide a difference between revisions.
    if (runs.some(run => !run || run.notes.some(note => !isScreenshotNote(note)) || run.observations.some(item => item.errorClass === 'infrastructure'))
      || !runs[0]?.completed && !runs[1]?.completed && !stableFailure) incomplete.push(flow);
  }
  return { flows, counts, flaky, incomplete };
}
