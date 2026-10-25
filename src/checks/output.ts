import { bytePrefix, byteTail } from '../process/runner.js';

/** Compact terminal output before applying the evidence byte limit. */
export function summarizeCheckOutput(output: string, failed: boolean, cap = 4096): string {
  const lines = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map(line => line.split('\r').filter(Boolean).at(-1) ?? '');
  const progress = /^\s*(?:Progress:|(?:npm|yarn)\s+(?:http|timing|progress)|\[\d+\/\d+\]|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/i;
  let lastProgress = -1;
  for (const [index, line] of lines.entries()) if (progress.test(line)) lastProgress = index;
  const compact = lines.filter((line, index) => !progress.test(line) || index === lastProgress);
  if (!failed) return byteTail(compact.filter(line => line.trim()).slice(-8).join('\n'), Math.min(cap, 1024));
  const failures = compact.filter(line => /(?:^\s*not ok \d+\s*-|\bFAIL |[✗×]|Error:|error TS\d+|ERR_)/.test(line)).slice(0, 40);
  if (!failures.length) return byteTail(compact.join('\n'), cap);
  const first = bytePrefix(failures.join('\n'), Math.floor(cap * 0.75));
  const separator = '\n--- tail ---\n';
  return first + separator + byteTail(compact.join('\n'), Math.max(0, cap - Buffer.byteLength(first + separator)));
}

/** Keep metadata outside the shrinking output fields; never slice serialized JSON. */
export function checkEvidence(checks: Array<{ argv: string[]; exitCode: number; timedOut: boolean; timeoutMs: number; stdoutTail: string; stderrTail: string }>, cap = 8192): string {
  const rows = checks.filter(check => check.exitCode !== 0 || check.timedOut).map(check => ({
    name: check.argv.join(' '), exitCode: check.exitCode,
    ...(check.timedOut ? { status: `TIMED OUT after ${check.timeoutMs / 1000}s` } : {}),
    stdout: check.stdoutTail, stderr: check.stderrTail,
  }));
  let outputCap = 4096;
  while (Buffer.byteLength(JSON.stringify(rows)) > cap && outputCap > 0) {
    outputCap = Math.floor(outputCap / 2);
    for (const row of rows) {
      row.stdout = bytePrefix(row.stdout, outputCap);
      row.stderr = bytePrefix(row.stderr, outputCap);
    }
  }
  return JSON.stringify(rows);
}
