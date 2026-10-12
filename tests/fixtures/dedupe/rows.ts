// Synthetic findings for the ten rows of IMPLEMENTATION.md 5.5, plus control pairs.
// Every text here was written by hand for this repository. The wording of the paraphrase pairs is
// deliberately different, because that is the case the similarity metric has to handle.
import type { Family, Finding, Origin, Severity } from '../../../src/types/index.js';

interface Spec {
  file?: string;
  line: number;
  severity: Severity;
  confidence: number;
  family: Family;
  provider?: string;
  model?: string;
  origin?: Origin;
  trigger: string;
  impact: string;
  fix: string;
}

const DEFAULT_PROVIDER: Record<Family, { provider: string; model: string }> = {
  google: { provider: 'agy', model: 'gemini-3.1-pro-high' },
  anthropic: { provider: 'claude', model: 'sonnet' },
  openai: { provider: 'codex', model: 'gpt-5' },
  local: { provider: 'qwen', model: 'qwen-local' },
};

export function finding(spec: Spec): Finding {
  const defaults = DEFAULT_PROVIDER[spec.family];
  return {
    severity: spec.severity,
    origin: spec.origin ?? 'introduced',
    file: spec.file ?? 'src/payment.ts',
    line: spec.line,
    trigger: spec.trigger,
    impact: spec.impact,
    evidence_quote: `// synthetic quote for line ${spec.line}`,
    fix: spec.fix,
    provider: spec.provider ?? defaults.provider,
    model: spec.model ?? defaults.model,
    family: spec.family,
    confidence: spec.confidence,
  };
}

export interface DedupeRow {
  row: number;
  findings: Finding[];
  // What the confidence arithmetic of 5.3 gives when the reviewers used the same words, so that
  // the findings are a strong match and merge. This is the "Final Sev / Final Conf" of the table.
  sameWording?: { severity: Severity; confidence: number; origin?: Origin };
  // Index pairs that paraphrase one defect. They are never merged (the wording is not strongly
  // similar) but each is annotated as possibly related to the other.
  paraphrases?: Array<[number, number]>;
  // Index pairs that share a location but are different defects: not merged, not annotated.
  distinct?: Array<[number, number]>;
}

export const ROWS: DedupeRow[] = [
  {
    row: 1,
    sameWording: { severity: 'BLOCKER', confidence: 0.95 },
    paraphrases: [[0, 1]],
    findings: [
      finding({
        line: 40,
        severity: 'BLOCKER',
        confidence: 0.7,
        family: 'google',
        trigger: 'Unchecked integer overflow in balance',
        impact:
          'Adding a large deposit to the account balance wraps around, so the stored balance can become negative or smaller than before.',
        fix: 'Use checked arithmetic or BigInt and reject amounts that exceed the maximum balance.',
      }),
      finding({
        line: 42,
        severity: 'IMPORTANT',
        confidence: 0.65,
        family: 'openai',
        trigger: 'Integer overflow vulnerability on balance math',
        impact:
          'The balance arithmetic has no upper bound, so a crafted amount overflows and corrupts the account balance.',
        fix: 'Validate the amount against Number.MAX_SAFE_INTEGER before adding it to the balance.',
      }),
    ],
  },
  {
    row: 2,
    sameWording: { severity: 'IMPORTANT', confidence: 0.8 },
    paraphrases: [[0, 1]],
    findings: [
      finding({
        line: 100,
        severity: 'IMPORTANT',
        confidence: 0.8,
        family: 'anthropic',
        provider: 'claude',
        model: 'sonnet',
        trigger: 'Missing CSRF header check',
        impact:
          'The state-changing endpoint does not verify the CSRF header, so a malicious page can submit requests on behalf of a logged-in user.',
        fix: 'Reject requests whose x-csrf-token header is absent or does not match the session token.',
      }),
      finding({
        line: 101,
        severity: 'IMPORTANT',
        confidence: 0.75,
        family: 'anthropic',
        provider: 'agy',
        model: 'claude-opus-5-5-high',
        trigger: 'CSRF token validation omitted',
        impact:
          'Requests are accepted without validating the CSRF token, which lets cross-site forms perform actions as the user.',
        fix: 'Validate the CSRF token on every POST handler.',
      }),
    ],
  },
  {
    row: 3,
    findings: [
      finding({
        line: 20,
        severity: 'IMPORTANT',
        confidence: 0.8,
        family: 'google',
        trigger: 'SQL injection in search query',
        impact:
          'User input is concatenated into the SQL string, so an attacker can read or modify arbitrary rows.',
        fix: 'Use a parameterized query for the search term.',
      }),
      finding({
        line: 32,
        severity: 'IMPORTANT',
        confidence: 0.8,
        family: 'openai',
        trigger: 'SQL injection in search query',
        impact:
          'The search term is placed directly in the query text, which allows an attacker to run arbitrary SQL.',
        fix: 'Bind the search term as a query parameter.',
      }),
    ],
  },
  {
    row: 4,
    distinct: [[0, 1]],
    findings: [
      finding({
        line: 50,
        severity: 'OPTIONAL',
        confidence: 0.6,
        family: 'google',
        trigger: 'Variable name typo `usre`',
        impact: 'The misspelled identifier makes the code harder to read and to search.',
        fix: 'Rename usre to user.',
      }),
      finding({
        line: 50,
        severity: 'BLOCKER',
        confidence: 0.9,
        family: 'openai',
        trigger: 'Null pointer dereference on user session',
        impact:
          'When the session has expired the lookup returns null and the next property access throws, crashing the request.',
        fix: 'Check the session for null before reading its fields.',
      }),
    ],
  },
  {
    row: 5,
    sameWording: { severity: 'IMPORTANT', confidence: 0.95 },
    paraphrases: [[0, 1]],
    findings: [
      finding({
        line: 12,
        severity: 'IMPORTANT',
        confidence: 0.7,
        family: 'google',
        trigger: 'Missing rate limit on login',
        impact:
          'The login endpoint accepts unlimited attempts, which allows password guessing at high speed.',
        fix: 'Add a rate limiter keyed by IP address and account to the login route.',
      }),
      finding({
        line: 14,
        severity: 'OPTIONAL',
        confidence: 0.5,
        family: 'local',
        trigger: 'Brute force possible without rate limit',
        impact: 'An attacker can try many passwords because attempts are never throttled.',
        fix: 'Throttle repeated failed logins.',
      }),
    ],
  },
  {
    row: 6,
    sameWording: { severity: 'BLOCKER', confidence: 1 },
    paraphrases: [
      [0, 1],
      [1, 2],
    ],
    findings: [
      finding({
        line: 80,
        severity: 'BLOCKER',
        confidence: 0.75,
        family: 'anthropic',
        trigger: 'Payment captured twice on retry',
        impact:
          'If the client retries after a timeout, the handler captures the charge again and the customer pays twice.',
        fix: 'Persist the capture result and return it for repeated requests.',
      }),
      finding({
        line: 81,
        severity: 'BLOCKER',
        confidence: 0.8,
        family: 'google',
        trigger: 'Idempotency key missing, double charge',
        impact:
          'The payment request carries no idempotency key, so a retried request creates a second charge.',
        fix: 'Send an idempotency key derived from the order id with every capture call.',
      }),
      finding({
        line: 82,
        severity: 'BLOCKER',
        confidence: 0.85,
        family: 'openai',
        trigger: 'Retry can charge the customer a second time',
        impact:
          'The retry loop sends the capture again without checking whether the first attempt succeeded, which produces a duplicate charge.',
        fix: 'Check the capture status before retrying.',
      }),
    ],
  },
  {
    row: 7,
    findings: [
      finding({
        file: 'src/a.ts',
        line: 10,
        severity: 'OPTIONAL',
        confidence: 0.6,
        family: 'google',
        trigger: 'Unused variable `x`',
        impact: 'The variable is declared and never read.',
        fix: 'Remove the variable.',
      }),
      finding({
        file: 'src/b.ts',
        line: 10,
        severity: 'OPTIONAL',
        confidence: 0.6,
        family: 'google',
        trigger: 'Unused variable `x`',
        impact: 'The variable is declared and never read.',
        fix: 'Remove the variable.',
      }),
    ],
  },
  {
    row: 8,
    sameWording: { severity: 'OPTIONAL', confidence: 0.75 },
    paraphrases: [[0, 1]],
    findings: [
      finding({
        line: 60,
        severity: 'OPTIONAL',
        confidence: 0.5,
        family: 'openai',
        trigger: 'Missing JSDoc comment on public method',
        impact: 'The public method has no documentation, so callers cannot tell what it returns.',
        fix: 'Add a JSDoc block describing the parameters and the return value.',
      }),
      finding({
        line: 63,
        severity: 'OPTIONAL',
        confidence: 0.5,
        family: 'google',
        trigger: 'Public export lacks documentation comments',
        impact: 'This exported function is undocumented, which makes the API harder to use.',
        fix: 'Document the exported function with a comment.',
      }),
    ],
  },
  {
    row: 9,
    sameWording: { severity: 'IMPORTANT', confidence: 1, origin: 'introduced' },
    paraphrases: [[0, 1]],
    findings: [
      finding({
        line: 90,
        severity: 'IMPORTANT',
        confidence: 0.7,
        family: 'google',
        origin: 'introduced',
        trigger: 'Write error is silently ignored',
        impact:
          'When the disk write fails the function still returns success, so data loss goes unnoticed.',
        fix: 'Propagate the error from the write call to the caller.',
      }),
      finding({
        line: 92,
        severity: 'IMPORTANT',
        confidence: 0.75,
        family: 'anthropic',
        origin: 'pre-existing',
        trigger: 'Failed write is not reported to the caller',
        impact:
          'The catch block discards the error and reports success, which hides failed writes.',
        fix: 'Rethrow the error from the catch block.',
      }),
    ],
  },
  {
    row: 10,
    distinct: [[0, 1]],
    findings: [
      finding({
        line: 15,
        severity: 'IMPORTANT',
        confidence: 0.8,
        family: 'google',
        trigger: 'Unclosed database client leak',
        impact:
          'The database client opened for each request is never closed, which exhausts the connection pool over time.',
        fix: 'Close the client in a finally block.',
      }),
      finding({
        line: 17,
        severity: 'IMPORTANT',
        confidence: 0.8,
        family: 'openai',
        trigger: 'Memory leak in query cache buffer',
        impact:
          'The query cache keeps growing because entries are never evicted, so memory use rises without bound.',
        fix: 'Bound the cache size and evict old entries.',
      }),
    ],
  },
];

export interface ControlPair {
  name: string;
  expect: 'paraphrase' | 'distinct';
  a: Finding;
  b: Finding;
}

function pair(
  name: string,
  expect: 'paraphrase' | 'distinct',
  a: Pick<Spec, 'trigger' | 'impact' | 'fix'>,
  b: Pick<Spec, 'trigger' | 'impact' | 'fix'>,
): ControlPair {
  return {
    name,
    expect,
    a: finding({ line: 30, severity: 'IMPORTANT', confidence: 0.7, family: 'google', ...a }),
    b: finding({ line: 32, severity: 'IMPORTANT', confidence: 0.7, family: 'openai', ...b }),
  };
}

// Extra pairs written after the ten rows, only to check that a metric calibrated on the rows is
// not just memorizing them. They are not part of the spec table.
export const CONTROLS: ControlPair[] = [
  pair(
    'paraphrase: hardcoded credential',
    'paraphrase',
    {
      trigger: 'Hardcoded API key in source',
      impact: 'The key is readable by anyone who can open the repository.',
      fix: 'Load the key from an environment variable.',
    },
    {
      trigger: 'Secret token committed in configuration file',
      impact: 'Credentials checked into the repository can be extracted from its history.',
      fix: 'Remove the secret and rotate it.',
    },
  ),
  pair(
    'paraphrase: cart race',
    'paraphrase',
    {
      trigger: 'Race condition when two requests update the same cart',
      impact: 'The second write replaces the first, so items added by the other request are lost.',
      fix: 'Use an atomic update or optimistic locking.',
    },
    {
      trigger: 'Concurrent cart updates can overwrite each other',
      impact: 'Two simultaneous requests read the same cart and the last one saved wins.',
      fix: 'Add a version column and retry on conflict.',
    },
  ),
  pair(
    'paraphrase: pagination bound',
    'paraphrase',
    {
      trigger: 'Off-by-one in pagination loop skips last page',
      impact: 'Users never see the final page of results.',
      fix: 'Use <= when comparing with the page count.',
    },
    {
      trigger: 'Loop bound excludes the final page of results',
      impact: 'The last page is never fetched because the loop ends one iteration early.',
      fix: 'Iterate through the last page index.',
    },
  ),
  pair(
    'paraphrase: open redirect',
    'paraphrase',
    {
      trigger: 'Unvalidated redirect target in login callback',
      impact: 'An attacker can send users to a malicious site after they sign in.',
      fix: 'Only redirect to paths on the same origin.',
    },
    {
      trigger: 'Open redirect through the returnUrl parameter',
      impact: 'The login flow redirects to any URL supplied in the query string, enabling phishing.',
      fix: 'Allow only relative return URLs.',
    },
  ),
  pair(
    'paraphrase: due date timezone',
    'paraphrase',
    {
      trigger: 'Timezone ignored when computing invoice due date',
      impact: 'Invoices become due a day early for customers west of UTC.',
      fix: 'Compute the due date in the customer time zone.',
    },
    {
      trigger: 'Due date is calculated in UTC instead of the local time of the customer',
      impact: 'Customers in other time zones see a wrong due date on their invoice.',
      fix: 'Convert to the customer time zone before adding the term.',
    },
  ),
  pair(
    'paraphrase: stream not closed',
    'paraphrase',
    {
      trigger: 'File handle never closed on error path',
      impact: 'Repeated failures exhaust the process file descriptors.',
      fix: 'Close the handle in a finally block.',
    },
    {
      trigger: 'Resource leak: stream remains open when parsing throws',
      impact: 'An exception during parsing leaves the stream open until the process exits.',
      fix: 'Use try/finally to destroy the stream.',
    },
  ),
  pair(
    'distinct: await vs import',
    'distinct',
    {
      trigger: 'Missing await on database save',
      impact: 'The handler responds before the record is persisted, so failures are lost.',
      fix: 'Await the save call.',
    },
    {
      trigger: 'Unused import of lodash',
      impact: 'The unused import increases the bundle size.',
      fix: 'Remove the import.',
    },
  ),
  pair(
    'distinct: injection vs timeout',
    'distinct',
    {
      trigger: 'SQL injection in search filter',
      impact: 'An attacker controls the WHERE clause and can read other tenants data.',
      fix: 'Use parameterized queries.',
    },
    {
      trigger: 'Hardcoded timeout of 30 seconds',
      impact: 'Slow networks cannot be accommodated without a code change.',
      fix: 'Move the timeout to configuration.',
    },
  ),
  pair(
    'distinct: division vs shadowing',
    'distinct',
    {
      trigger: 'Division by zero when the cart is empty',
      impact: 'The average price computation returns NaN and breaks the summary page.',
      fix: 'Guard the empty cart case.',
    },
    {
      trigger: 'Variable shadows outer scope name',
      impact: 'Readers can confuse the inner total with the outer one.',
      fix: 'Rename the inner variable.',
    },
  ),
  pair(
    'distinct: password log vs reset token',
    'distinct',
    {
      trigger: 'Password logged in plain text',
      impact: 'Anyone with access to the logs can read user passwords.',
      fix: 'Remove the password from the log message.',
    },
    {
      trigger: 'Password reset token never expires',
      impact: 'A leaked reset link stays valid forever and can take over the account.',
      fix: 'Expire reset tokens after one hour.',
    },
  ),
  pair(
    'distinct: null check vs email validation',
    'distinct',
    {
      trigger: 'Missing null check on user profile',
      impact: 'Accounts without a profile make the page throw.',
      fix: 'Return early when the profile is null.',
    },
    {
      trigger: 'Missing input validation on email field',
      impact: 'Malformed addresses are stored and later bounce.',
      fix: 'Validate the email format before saving.',
    },
  ),
  pair(
    'distinct: leak vs naming',
    'distinct',
    {
      trigger: 'Event listener registered on every render and never removed',
      impact: 'Listeners pile up and the page slows down over time.',
      fix: 'Remove the listener in the cleanup function.',
    },
    {
      trigger: 'Function name does not describe what it does',
      impact: 'The name getData hides that the function also writes to disk.',
      fix: 'Rename to loadAndCacheData.',
    },
  ),
];

// Two different defects at nearby lines whose wording is close ("Missing authorization when
// deleting users" and "Missing audit when deleting users"). Two families, equal confidence. A
// merge would hide one of them and raise the survivor to 0.95; they must stay apart and only
// point at each other.
export const ADVERSARIAL: [Finding, Finding] = [
  finding({
    file: 'src/users.ts',
    line: 10,
    severity: 'IMPORTANT',
    confidence: 0.7,
    family: 'google',
    trigger: 'Missing authorization when deleting users',
    impact: "Lets one delete other people's accounts.",
    fix: 'Check that the caller is an administrator before deleting.',
  }),
  finding({
    file: 'src/users.ts',
    line: 12,
    severity: 'IMPORTANT',
    confidence: 0.7,
    family: 'openai',
    trigger: 'Missing audit when deleting users',
    impact: 'Makes it impossible to trace who deleted an account.',
    fix: 'Write an audit record for every deletion.',
  }),
];
