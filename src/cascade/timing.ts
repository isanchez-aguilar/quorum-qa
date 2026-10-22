export interface PhaseDurations {
  checks: number;
  triage: number;
  escalation: number;
  confirmation: number;
  total: number;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function completionTiming(durations: PhaseDurations, parallel: boolean): string {
  return `quorum: done in ${formatDuration(durations.total)} (checks ${formatDuration(durations.checks)} ${parallel ? 'ran in parallel with' : 'ran before'} triage ${formatDuration(durations.triage)})`;
}
