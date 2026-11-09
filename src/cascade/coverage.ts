export const SKIP_REASONS = {
  'budget-exhausted': 'budget exhausted',
  'run-deadline-reached': 'run deadline reached',
  'no-provider-available': 'no provider available',
  'no-usable-response': 'provider returned no usable response',
  'no-diff-content': 'no diff content fits',
} as const;

export type ReviewSkipReason = keyof typeof SKIP_REASONS;
export interface SkippedFileReason { file: string; reason: ReviewSkipReason }

export function skipReasonCounts(skipped: readonly SkippedFileReason[]): Partial<Record<ReviewSkipReason, number>> {
  const counts: Partial<Record<ReviewSkipReason, number>> = {};
  for (const reason of Object.keys(SKIP_REASONS) as ReviewSkipReason[]) {
    const count = new Set(skipped.filter(item => item.reason === reason).map(item => item.file)).size;
    if (count) counts[reason] = count;
  }
  return counts;
}

export function skipRemedy(reason: ReviewSkipReason): string {
  if (reason === 'budget-exhausted') return ' Raise budget.maxCalls or review per lane with a narrower --diff.';
  if (reason === 'run-deadline-reached') return ' Raise budget.maxMinutes or review per lane with a narrower --diff.';
  return '';
}
