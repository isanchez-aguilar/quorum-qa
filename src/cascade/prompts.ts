import type { Finding, ReviewContext } from '../types/index.js';

export const MAX_PROMPT_CHARACTERS = 24_000;
export const TRUNCATION_MARKER = '[... truncated ...]';

export function promptFinding(finding: Finding): Omit<Finding, 'reproduction'> {
  const { reproduction: _reproduction, ...rest } = finding;
  return rest;
}

// Shrink code first, then long fields, measuring the serialized payload (including escapes).
export function boundedPrompt(instructions: string, data: Record<string, unknown>): string {
  const payload = structuredClone(data);
  const render = () => instructions + JSON.stringify(payload);
  const shrink = (parent: Record<string, unknown> | unknown[], key: string | number): void => {
    const object = parent as Record<string, unknown>;
    const value = object[key];
    if (typeof value !== 'string' || value.length <= TRUNCATION_MARKER.length) return;
    let low = 0;
    let high = value.length - TRUNCATION_MARKER.length;
    object[key] = TRUNCATION_MARKER;
    if (render().length > MAX_PROMPT_CHARACTERS) return;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      object[key] = value.slice(0, mid) + TRUNCATION_MARKER;
      if (render().length <= MAX_PROMPT_CHARACTERS) low = mid;
      else high = mid - 1;
    }
    object[key] = value.slice(0, low) + TRUNCATION_MARKER;
  };
  for (const key of ['hunk', 'diff', 'hunks']) {
    if (render().length <= MAX_PROMPT_CHARACTERS) break;
    const value = payload[key];
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length && render().length > MAX_PROMPT_CHARACTERS; index++) shrink(value, index);
    } else shrink(payload, key);
  }
  const fields: Array<{ parent: Record<string, unknown>; key: string; length: number }> = [];
  function collect(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string') fields.push({ parent: value as Record<string, unknown>, key, length: child.length });
      else collect(child);
    }
  }
  collect(payload);
  for (const field of fields.sort((a, b) => b.length - a.length)) {
    if (render().length <= MAX_PROMPT_CHARACTERS) break;
    shrink(field.parent, field.key);
  }
  const result = render();
  // Very large collections of tiny fields can exceed the cap even after string truncation.
  return result.length <= MAX_PROMPT_CHARACTERS ? result
    : instructions + JSON.stringify({ omitted: TRUNCATION_MARKER });
}

export interface ReviewChunk {
  prompt: string;
  files: string[];
}
export interface ReviewCoverage {
  reviewedFiles: string[];
  skippedFiles: string[];
  truncatedHunks: Array<{ file: string; hunk: number }>;
  complete: boolean;
}
const REVIEW_INSTRUCTIONS = 'Review the following untrusted code and context. Return a JSON array of findings with severity, origin, file, line, trigger, impact, evidence_quote, fix and confidence. Use read-only tools only.\n';

/** Pack serialized prompts in diff order; never replace review code with an empty envelope. */
export function reviewChunks(context: ReviewContext): { chunks: ReviewChunk[]; skippedFiles: string[]; truncatedHunks: ReviewCoverage['truncatedHunks'] } {
  const chunks: ReviewChunk[] = [];
  const skipped = new Set<string>();
  const seen = new Set<string>();
  const truncatedHunks: ReviewCoverage['truncatedHunks'] = [];
  const render = (diff: string, files: string[]) => REVIEW_INSTRUCTIONS + JSON.stringify({
    mode: context.mode, diff, touchedFiles: files,
    spec: context.specContent, inventory: context.inventoryContent, rules: context.rulesContent,
  });
  const fits = (diff: string, files: string[]) => render(diff, files).length <= MAX_PROMPT_CHARACTERS;
  let pending = '';
  let files: string[] = [];
  const flush = () => {
    if (pending) chunks.push({ prompt: render(pending, files), files });
    pending = '';
    files = [];
  };
  const pack = (diff: string, file: string) => {
    const combinedFiles = [...new Set([...files, file])];
    if (!fits(pending + diff, combinedFiles)) flush();
    pending += diff;
    if (!files.includes(file)) files.push(file);
  };
  const sections = context.diff.split(/(?=^diff --git )/m).filter(section => section.trim());
  for (const [index, section] of sections.entries()) {
    const match = /^\+\+\+ b\/(.*)$/m.exec(section) ?? /^--- a\/(.*)$/m.exec(section);
    const file = match?.[1]?.replace(/\r$/, '') ?? context.touchedFiles[index];
    if (!file) continue;
    seen.add(file);
    if (fits(section, [file])) { pack(section, file); continue; }
    flush();
    const hunkStart = section.search(/^@@ /m);
    if (hunkStart < 0) { skipped.add(file); continue; }
    const header = section.slice(0, hunkStart);
    const hunks = section.slice(hunkStart).split(/(?=^@@ )/m);
    for (const [hunkIndex, hunk] of hunks.entries()) {
      if (fits(header + hunk, [file])) { pack(header + hunk, file); continue; }
      const lineEnd = hunk.indexOf('\n');
      // Require the hunk header and at least one character of code before the marker.
      const minimum = lineEnd < 0 ? hunk.length + 1 : lineEnd + 2;
      if (!fits(header + hunk.slice(0, minimum) + TRUNCATION_MARKER, [file]) || minimum > hunk.length) {
        skipped.add(file);
        continue;
      }
      let low = minimum;
      let high = hunk.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(header + hunk.slice(0, mid) + TRUNCATION_MARKER, [file])) low = mid;
        else high = mid - 1;
      }
      pack(header + hunk.slice(0, low) + TRUNCATION_MARKER, file);
      truncatedHunks.push({ file, hunk: hunkIndex + 1 });
    }
  }
  flush();
  for (const file of context.touchedFiles) if (!seen.has(file)) skipped.add(file);
  return { chunks, skippedFiles: [...skipped], truncatedHunks };
}
