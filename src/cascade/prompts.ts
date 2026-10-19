import type { Finding } from '../types/index.js';

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
