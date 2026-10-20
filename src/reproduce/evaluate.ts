import type { TestReport } from '../types/index.js';

type Test = TestReport['tests'][number];
export type ReproductionEvaluation = 'assertion-failure-matching' | 'assertion-failure-other-message'
  | 'non-assertion-failure' | 'passed' | 'other-test-failed' | 'unproven';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanMessage(message: string): string {
  return message.replace(/\u001b\[[0-9;]*m/g, '').trim();
}

function normalizeFile(file: string, root = '/work'): string {
  const normalized = file.replace(/\\/g, '/');
  const prefix = root.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  const matches = process.platform === 'win32' ? normalized.toLowerCase().startsWith(prefix.toLowerCase()) : normalized.startsWith(prefix);
  return matches ? normalized.slice(prefix.length) : normalized.replace(/^\.\//, '');
}

function failureKind(message: string, details: unknown): Test['failureKind'] {
  if (/^(?:SyntaxError|TransformError)\b|(?:^|\n).*Transform failed\b/i.test(message)) return 'syntax';
  if (/^(?:Error: )?(?:Cannot find (?:module|package)|Failed to (?:resolve|load)|ERR_MODULE_NOT_FOUND)\b|^ImportError\b/i.test(message)) return 'import';
  if (/^(?:Error: )?(?:Test timed out|Exceeded timeout)\b/i.test(message)) return 'timeout';
  if (/^(?:AssertionError|JestAssertionError)(?:\b|:)|^Error: expect\(|^expect\([^\n]*\)\./.test(message)
    || Array.isArray(details) && details.some(detail => record(detail) && record(detail.matcherResult))) return 'assertion';
  return 'error';
}

// Both runners use Jest's JSON schema. Jest identifies itself through testExecError,
// failureDetails or the top-level wasInterrupted field; the overlapping subset is Vitest.
export function parseTestReport(raw: unknown, worktreeRoot = '/work'): TestReport | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!record(value) || !Array.isArray(value.testResults)) return null;
  const isJest = 'wasInterrupted' in value || value.testResults.some(suite => record(suite)
    && ('testExecError' in suite || Array.isArray(suite.assertionResults)
      && suite.assertionResults.some(assertion => record(assertion) && 'failureDetails' in assertion)));
  const report: TestReport = { runner: isJest ? 'jest' : 'vitest', tests: [], suiteErrors: [], suiteFiles: [] };
  for (const suite of value.testResults) {
    if (!record(suite) || typeof suite.name !== 'string' || !Array.isArray(suite.assertionResults)) return null;
    const file = normalizeFile(suite.name, worktreeRoot);
    report.suiteFiles!.push(file);
    if ('testExecError' in suite) report.runner = 'jest';
    if (record(suite.testExecError)) {
      report.suiteErrors.push(typeof suite.testExecError.message === 'string' ? cleanMessage(suite.testExecError.message) : 'Test suite execution error');
    }
    // Jest repeats assertion failures in suite.message; Vitest uses it for loading errors.
    if (typeof suite.message === 'string' && suite.message.trim()
      && (report.runner === 'vitest' || suite.assertionResults.length === 0)) report.suiteErrors.push(cleanMessage(suite.message));
    for (const assertion of suite.assertionResults) {
      if (!record(assertion) || typeof assertion.status !== 'string'
        || !['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled'].includes(assertion.status)
        || !Array.isArray(assertion.failureMessages) || assertion.failureMessages.some(message => typeof message !== 'string')) return null;
      if ('failureDetails' in assertion) report.runner = 'jest';
      const name = typeof assertion.fullName === 'string' ? assertion.fullName : assertion.title;
      if (typeof name !== 'string') return null;
      const test: Test = { file, name, status: assertion.status === 'passed' ? 'passed' : assertion.status === 'failed' ? 'failed' : 'skipped' };
      if (typeof assertion.title === 'string' && Array.isArray(assertion.ancestorTitles)
        && assertion.ancestorTitles.every(title => typeof title === 'string')) {
        test.title = assertion.title;
        test.ancestorTitles = [...assertion.ancestorTitles] as string[];
      }
      if (test.status === 'failed') {
        const messages = (assertion.failureMessages as string[]).map(cleanMessage);
        for (const message of messages) {
          if (failureKind(message, assertion.failureDetails) !== 'assertion' && infrastructureReason(message)) report.suiteErrors.push(message);
        }
        const message = messages[0] ?? '';
        const kinds = messages.map(item => failureKind(item, assertion.failureDetails));
        test.failureKind = kinds.length > 0 && kinds.every(kind => kind === 'assertion') ? 'assertion'
          : kinds.find(kind => kind !== 'assertion') ?? 'error';
        test.message = message.split(/\r?\n/, 1)[0] ?? '';
      }
      report.tests.push(test);
    }
    if (suite.status === 'failed' && suite.assertionResults.length === 0 && !suite.message && !suite.testExecError) report.suiteErrors.push('Test suite failed before running tests');
  }
  return report;
}

export function evaluateReproduction(report: TestReport, testFile: string, expected: string): ReproductionEvaluation {
  if (infrastructureFailure(report, '', testFile)) return 'unproven';
  if (report.suiteErrors.length > 0) return 'non-assertion-failure';
  const target = normalizeFile(testFile);
  const tests = report.tests.filter(test => normalizeFile(test.file) === target);
  const failed = tests.filter(test => test.status === 'failed');
  if (failed.some(test => test.failureKind !== 'assertion')) return 'non-assertion-failure';
  if (failed.length > 0) {
    // A literal substring, never a model-supplied regular expression. Empty expectations cannot prove a defect.
    return expected.trim() && failed.some(test => test.message?.includes(expected.trim()))
      ? 'assertion-failure-matching' : 'assertion-failure-other-message';
  }
  if (report.tests.some(test => test.status === 'failed')) return 'other-test-failed';
  return tests.length > 0 && tests.every(test => test.status === 'passed') ? 'passed' : 'non-assertion-failure';
}

export function passedAtBase(report: TestReport, testFile: string): boolean {
  return evaluateReproduction(report, testFile, '') === 'passed';
}

export function infrastructureReason(output: string): string | undefined {
  if (/worker[^\r\n]*(?:crash|exit|died)|out of memory|\b(?:ENOSPC|EMFILE|ENOMEM)\b|\bprocess (?:was )?killed\b|\bexited with signal\b|\bterminated by signal\b/i.test(output)
    || /\b(?:SIGKILL|SIGSEGV|SIGTERM|SIGABRT|SIGBUS|SIGILL|SIGFPE)\b/.test(output)) return 'test infrastructure failure';
  if (/\b(?:EROFS|EACCES)\b[^\r\n]*(?:cache|node_modules|\.vite)|(?:cache|node_modules|\.vite)[^\r\n]*\b(?:EROFS|EACCES)\b/i.test(output)) return 'cache is not writable';
  if (/\bcommand not found\b|\bexecutable file not found\b|\bspawn [^\r\n]+ ENOENT\b/i.test(output)) return 'command not found';
  return undefined;
}

export function infrastructureFailure(report: TestReport | null, diagnostic = '', testFile?: string): string | undefined {
  const reason = infrastructureReason([diagnostic, ...(report?.suiteErrors ?? [])].join('\n'));
  if (reason) return reason;
  if (report === null) return 'missing test report';
  if (testFile !== undefined && report.suiteFiles?.length && !report.suiteFiles.some(file => normalizeFile(file) === normalizeFile(testFile))) {
    return 'target test missing from report';
  }
  const tests = testFile === undefined ? [] : report.tests.filter(test => normalizeFile(test.file) === normalizeFile(testFile));
  if (tests.length && tests.every(test => test.status === 'skipped')) return 'target test only skipped';
  // Ordinary compile/import suite errors still disprove the proposed test.
  if (report.suiteErrors.length) return undefined;
  if (!report.tests.length) return 'empty test report';
  if (testFile !== undefined) {
    if (!tests.length) return 'target test missing from report';
  }
  return undefined;
}
