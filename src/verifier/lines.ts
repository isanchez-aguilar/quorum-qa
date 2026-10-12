// Search radius around the cited line, in lines.
export const WINDOW_RADIUS = 10;

// Splits file content into lines. A final line terminator does not make an extra empty line, and a
// leading BOM is not part of the first line.
export function splitLines(content: string): string[] {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// A cited line can be NaN, 0, negative, fractional or absurdly large when a model hallucinates.
export function isCitableLine(line: number): boolean {
  return Number.isInteger(line) && line >= 1;
}

export interface LineWindow {
  first: number;
  last: number;
}

// The 1-indexed inclusive range [L - W, L + W] clamped to the file, or null when the cited line is
// not citable or falls entirely outside the file (the caller then searches the whole file).
export function localWindow(
  citedLine: number,
  totalLines: number,
  radius: number = WINDOW_RADIUS,
): LineWindow | null {
  if (!isCitableLine(citedLine)) return null;
  const first = Math.max(1, citedLine - radius);
  const last = Math.min(totalLines, citedLine + radius);
  return first > last ? null : { first, last };
}

// Distance used by the tie-break. An unusable cited line makes every candidate equally far away.
export function lineDistance(candidate: number, citedLine: number): number {
  return Number.isFinite(citedLine) ? Math.abs(candidate - citedLine) : 0;
}
