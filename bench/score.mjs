import path from 'node:path';

const severity = { OPTIONAL: 1, IMPORTANT: 2, BLOCKER: 3 };
const normalize = file => path.posix.normalize(file.replaceAll('\\', '/'));
const ratio = (a, b) => b ? a / b : null;

export function hits(finding, truth) {
  return typeof finding.file === 'string' && Number.isInteger(finding.line)
    && normalize(finding.file) === normalize(truth.file)
    && finding.line >= truth.lines[0] - 3 && finding.line <= truth.lines[1] + 3;
}

export function isConfirmed(finding) {
  return finding.confirmed === true
    || new Set([finding.family, ...(finding.confirmationFamilies ?? [])].filter(Boolean)).size >= 2;
}

function score(truth, findings) {
  const matches = truth.map(item => {
    const best = findings.filter(f => hits(f, item)).sort((a, b) => severity[b.severity] - severity[a.severity])[0];
    return { ...item, hit: Boolean(best), bestSeverity: best?.severity ?? null,
      severityMet: Boolean(best && severity[best.severity] >= severity[item.minSeverity]) };
  });
  const TP = matches.filter(item => item.hit).length;
  const FP = findings.filter(f => !truth.some(item => hits(f, item))).length;
  return { TP, FN: truth.length - TP, FP, reported: findings.length,
    severityHits: matches.filter(item => item.severityMet).length,
    recall: ratio(TP, truth.length), precision: ratio(TP, TP + FP),
    severityAccuracy: ratio(matches.filter(item => item.severityMet).length, TP), matches };
}

export function scoreCase(testCase, report) {
  const all = [...(report.findings ?? []), ...(report.unconfirmed ?? [])].filter(f => severity[f.severity]);
  const rejected = (report.rejectedOnConfirmation ?? []).map(item => item.finding).filter(f => severity[f.severity]);
  return { all: score(testCase.truth, all), confirmed: score(testCase.truth, all.filter(isConfirmed)),
    rejectedWouldBeTP: rejected.filter(f => testCase.truth.some(t => hits(f, t))).length,
    rejectedTruthItems: testCase.truth.filter(t => rejected.some(f => hits(f, t))).length };
}

export function summarize(rows) {
  const totals = {};
  for (const group of ['all', 'confirmed']) {
    const sum = key => rows.reduce((n, row) => n + row.score[group][key], 0);
    const TP = sum('TP'), FN = sum('FN'), FP = sum('FP');
    const controls = rows.filter(row => row.kind === 'control');
    totals[group] = { TP, FN, FP, recall: ratio(TP, TP + FN), precision: ratio(TP, TP + FP),
      severityAccuracy: ratio(sum('severityHits'), TP),
      falseFindingsPerControl: ratio(controls.reduce((n, row) => n + row.score[group].FP, 0), controls.length) };
  }
  return { ...totals, calls: rows.reduce((n, row) => n + (row.calls ?? 0), 0),
    unknownCallRuns: rows.filter(row => row.calls === null).length,
    wallMs: rows.reduce((n, row) => n + row.wallMs, 0),
    rejectedWouldBeTP: rows.reduce((n, row) => n + row.score.rejectedWouldBeTP, 0),
    rejectedTruthItems: rows.reduce((n, row) => n + row.score.rejectedTruthItems, 0),
    failedRuns: rows.filter(row => row.status !== 'ok').length,
    exitCodes: rows.reduce((counts, row) => { const key = String(row.exitCode); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}) };
}

export function markdown(summary) {
  const lines = ['| Case | Run | Status | All TP/FN/FP | Confirmed TP/FN/FP | Severity met (all/confirmed) | Rejected TP | Calls | Wall ms | Exit |',
    '| --- | ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- |'];
  for (const row of summary.cases) {
    const counts = group => ['TP', 'FN', 'FP'].map(key => row.score[group][key]).join('/');
    lines.push(`| ${row.id} | ${row.repeat} | ${row.status} | ${counts('all')} | ${counts('confirmed')} | ${row.score.all.severityHits}/${row.score.confirmed.severityHits} | ${row.score.rejectedWouldBeTP} | ${row.calls ?? 'unknown'} | ${row.wallMs} | ${row.exitCode ?? 'none'} |`);
  }
  lines.push('', '| Metric | All reported | Confirmed |', '| --- | ---: | ---: |');
  for (const key of ['TP', 'FN', 'FP', 'recall', 'precision', 'severityAccuracy', 'falseFindingsPerControl']) {
    lines.push(`| ${key} | ${summary.totals.all[key] ?? 'n/a'} | ${summary.totals.confirmed[key] ?? 'n/a'} |`);
  }
  lines.push('', `Calls: ${summary.totals.calls} known (${summary.totals.unknownCallRuns} unknown runs). Wall: ${summary.totals.wallMs} ms. Failed runs: ${summary.totals.failedRuns}.`,
    `Exit codes: ${JSON.stringify(summary.totals.exitCodes)}. Rejected would-be TPs: ${summary.totals.rejectedWouldBeTP}.`, '');
  return lines.join('\n');
}
