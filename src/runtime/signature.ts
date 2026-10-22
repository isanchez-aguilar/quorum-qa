import type { Observation } from './report.js';

export function normalizeMessage(text: string): string {
  // Token-scoped passes avoid backtracking across long runs of slashes/colons.
  return text.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g, '')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{4}(?:[ ,]+\d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?)?\b/g, '')
    .replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, '')
    .replace(/\S+/g, token => {
      let result = token.replace(/:\d+:\d+\b/g, '').replace(/[?#].*$/, '');
      const prefix = result.startsWith('(') ? '(' : '';
      const path = result.slice(prefix.length);
      // V8 frames wrap the URL in parentheses: `at f (http://127.0.0.1:4173/app.js:1:2)`.
      if (/^https?:\/\//.test(path)) return prefix + path.replace(/^(https?:\/\/(?:\[[^\]]+\]|[^/:]+)):\d+/, '$1');
      if (/^(?:[A-Za-z]:[\\/]|\/)/.test(path) && /[^/\\]/.test(path)) result = prefix + path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
      return result;
    }).replace(/\b[\da-f]{7,}\b/gi, '').replace(/\b\d{4,}\b/g, '').replace(/\s+/g, ' ').trim();
}
export function signature(observation: Observation, flow: string): string | undefined {
  if (observation.kind === 'http') {
    if (observation.expected && observation.status! >= 400 && observation.status! < 500
      && !['script', 'stylesheet', 'image', 'font'].includes(observation.resourceType ?? '')) return undefined;
    // HTTP paths identify resources, not filesystem paths; keep their leading slash.
    return `http|${flow}|${observation.status} ${normalizeMessage('http://runtime' + (observation.path ?? '')).replace('http://runtime', '')}`;
  }
  // A failed request is identified by its resource too: the same net:: error on a different
  // endpoint is a different problem.
  if (observation.kind === 'requestfailed' && observation.path) {
    return `requestfailed|${flow}|${normalizeMessage('http://runtime' + observation.path).replace('http://runtime', '')} ${normalizeMessage(observation.message)}`;
  }
  const step = ['blank', 'technicalText', 'flow-failure'].includes(observation.kind) ? `${observation.step}|` : '';
  return `${observation.kind}|${flow}|${step}${normalizeMessage(observation.message)}`;
}
