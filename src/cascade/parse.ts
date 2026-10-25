import type { CatalogEntry, Finding, ReproductionProposal } from '../types/index.js';

export interface ParseResult {
  findings: Finding[];
  dropped: Array<{ index: number; reason: string }>;
  rawCount: number;
  error?: string;
}

export const MAX_FINDINGS_PER_RESPONSE = 100;

export function extractJson(raw: string, accept: (value: unknown) => boolean = () => true): unknown {
  if (raw.length > 1_048_576) throw new Error('Provider output exceeds 1 MiB character limit');
  let start = -1;
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (start < 0) {
      if (char !== '[' && char !== '{') continue;
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '[' || char === '{') stack.push(char);
    else if (char === ']' || char === '}') {
      const open = stack.pop();
      if ((char === ']' && open !== '[') || (char === '}' && open !== '{')) {
        stack.length = 0;
        start = -1;
      } else if (!stack.length) {
        try {
          const value: unknown = JSON.parse(raw.slice(start, index + 1));
          if (accept(value)) return value;
          start = -1;
        } catch {
          // Balanced prose such as [review complete] is not a JSON payload.
          start = -1;
        }
      }
    }
  }
  throw new Error('No complete JSON array or object found');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseReproductionProposal(raw: string): ReproductionProposal {
  const value = extractJson(raw, item => isRecord(item)
    && ['path', 'content', 'expect'].every(key => typeof item[key] === 'string' && item[key].trim()));
  const proposal = value as Record<string, string>;
  return { path: proposal.path!, content: proposal.content!, expect: proposal.expect!, status: 'pending' };
}

// A synonym never reaches BLOCKER: only an explicit BLOCKER label can fail a run.
const SEVERITY_ALIASES: Record<string, Finding['severity']> = {
  CRITICAL: 'IMPORTANT', HIGH: 'IMPORTANT', MAJOR: 'IMPORTANT', MEDIUM: 'IMPORTANT', P0: 'IMPORTANT', P1: 'IMPORTANT', P2: 'IMPORTANT',
  LOW: 'OPTIONAL', MINOR: 'OPTIONAL', INFO: 'OPTIONAL', NIT: 'OPTIONAL', TRIVIAL: 'OPTIONAL', P3: 'OPTIONAL',
};

export function canonicalSeverity(raw: string): Finding['severity'] | undefined {
  const label = raw.trim().replace(/^\[(.*)\]$/, '$1').toUpperCase();
  if (label === 'BLOCKER' || label === 'IMPORTANT' || label === 'OPTIONAL') return label;
  return SEVERITY_ALIASES[label];
}

function findingFrom(value: unknown, entry: CatalogEntry): Finding {
  if (!isRecord(value)) throw new Error('finding must be an object');
  const strings = ['file', 'trigger', 'impact', 'evidence_quote', 'fix'] as const;
  for (const field of strings) {
    if (typeof value[field] !== 'string' || !value[field].trim()) throw new Error(`${field} must be a non-empty string`);
  }
  if (typeof value.severity !== 'string') throw new Error('invalid severity');
  const severity = canonicalSeverity(value.severity);
  if (!severity) throw new Error(`invalid severity: ${JSON.stringify(value.severity.slice(0, 40))}`);
  // git blame decides introduced vs pre-existing later, and only "improvement" is kept from the model,
  // so an unknown or missing origin (seen from Gemini Flash in a real run) is not a reason to drop the finding.
  const origin: Finding['origin'] = typeof value.origin === 'string' && ['introduced', 'pre-existing', 'improvement'].includes(value.origin)
    ? value.origin as Finding['origin'] : 'introduced';
  if (!Number.isSafeInteger(value.line) || (value.line as number) < 1) throw new Error('line must be a positive integer');
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) throw new Error('confidence must be finite');
  let reproduction: ReproductionProposal | undefined;
  if (value.reproduction !== undefined) {
    const proposal = value.reproduction;
    if (!isRecord(proposal) || !['path', 'content', 'expect'].every(key => typeof proposal[key] === 'string' && proposal[key].trim())) {
      throw new Error('reproduction requires path, content and expect strings');
    }
    reproduction = { path: proposal.path as string, content: proposal.content as string, expect: proposal.expect as string, status: 'pending' };
  }
  const finding: Finding = {
    severity, origin,
    file: value.file as string, line: value.line as number, trigger: value.trigger as string,
    impact: value.impact as string, evidence_quote: value.evidence_quote as string, fix: value.fix as string,
    provider: entry.provider, model: entry.id, family: entry.family, confidence: Math.max(0, Math.min(1, value.confidence)),
  };
  if (reproduction) finding.reproduction = reproduction;
  return finding;
}

export function parseFindings(raw: string, entry: CatalogEntry): ParseResult {
  let value: unknown;
  try { value = extractJson(raw, item => Array.isArray(item) ? item.every(isRecord)
    : isRecord(item) && Array.isArray(item.findings)); } catch (error) {
    return { findings: [], dropped: [], rawCount: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const entries = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.findings) ? value.findings : [value];
  const findings: Finding[] = [];
  const dropped: ParseResult['dropped'] = [];
  entries.forEach((item, index) => {
    if (index >= MAX_FINDINGS_PER_RESPONSE) { dropped.push({ index, reason: 'too many findings' }); return; }
    try { findings.push(findingFrom(item, entry)); } catch (error) {
      dropped.push({ index, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  return { findings, dropped, rawCount: entries.length, ...(entries.length && !findings.length ? { error: 'All findings were invalid' } : {}) };
}
