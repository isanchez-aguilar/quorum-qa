import type { Flow } from './config.js';

export type ObservationKind = 'console' | 'pageerror' | 'http' | 'requestfailed' | 'blank' | 'technicalText' | 'flow-failure';
export interface Observation {
  kind: ObservationKind; step?: number; path?: string; status?: number; resourceType?: string;
  expected?: boolean; message: string; errorClass?: 'timeout' | 'selector' | 'navigation' | 'other';
}
export interface RuntimeRun {
  flow: string; run: 1 | 2; completed: boolean; observations: Observation[];
  blockedExternal: Record<string, number>; notes: string[];
}
export interface RuntimeReport { version: 1; runs: RuntimeRun[] }
export const REPORT_BYTES = 2 * 1024 * 1024;
const kinds = ['console', 'pageerror', 'http', 'requestfailed', 'blank', 'technicalText', 'flow-failure'];
const resources = ['document', 'script', 'stylesheet', 'image', 'font', 'fetch', 'xhr', 'other'];
const forbidden = (key: string) => ['__proto__', 'constructor', 'prototype'].includes(key);
function object(value: unknown, keys?: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => forbidden(key) || keys && !keys.includes(key))) throw new Error('invalid object');
}
function string(value: unknown, cap = 500): string {
  if (typeof value !== 'string') throw new Error('invalid string');
  return value.slice(0, cap);
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid integer');
  return value;
}
export function parseRuntimeReport(raw: string, plan: { flows?: Flow[] }): RuntimeReport | { error: string } {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > REPORT_BYTES) throw new Error('report size cap');
    const value: unknown = JSON.parse(raw); object(value, ['version', 'runs']);
    if (value.version !== 1 || !Array.isArray(value.runs) || value.runs.length > 40) throw new Error('invalid report');
    const flows = new Map(plan.flows?.map(flow => [flow.name, flow]));
    const seen = new Set<string>(); let total = 0;
    const runs = value.runs.map(rawRun => {
      object(rawRun, ['flow', 'run', 'completed', 'observations', 'blockedExternal', 'notes']);
      const flow = flows.get(string(rawRun.flow, 60));
      if (!flow || rawRun.flow !== flow.name || typeof rawRun.completed !== 'boolean') throw new Error('invalid flow');
      const run = integer(rawRun.run, 1, 2) as 1 | 2; const key = `${flow.name}|${run}`;
      if (seen.has(key)) throw new Error('duplicate run'); seen.add(key);
      if (!Array.isArray(rawRun.observations) || rawRun.observations.length > 200
        || (total += rawRun.observations.length) > 2000) throw new Error('observation cap');
      if (!Array.isArray(rawRun.notes) || rawRun.notes.length > 20) throw new Error('invalid notes');
      const notes = rawRun.notes.map(note => string(note));
      const cappedString = (value: unknown, cap = 500) => {
        const result = string(value, cap);
        if ((value as string).length > cap && !notes.includes('cap: string')) notes.push('cap: string');
        return result;
      };
      const observations = rawRun.observations.map(rawObservation => {
        object(rawObservation, ['kind', 'step', 'path', 'status', 'resourceType', 'expected', 'message', 'errorClass']);
        if (!kinds.includes(string(rawObservation.kind))) throw new Error('invalid kind');
        const kind = rawObservation.kind as ObservationKind;
        const observation: Observation = { kind, message: cappedString(rawObservation.message, kind === 'technicalText' ? 200 : kind === 'flow-failure' ? 300 : 500) };
        if ('step' in rawObservation) observation.step = integer(rawObservation.step, 0, flow.steps.length - 1);
        if (['blank', 'technicalText', 'flow-failure'].includes(kind) && observation.step === undefined) throw new Error('missing step');
        if ('path' in rawObservation) {
          const path = cappedString(rawObservation.path);
          if (path !== '' && (!path.startsWith('/') || /[?#]/.test(rawObservation.path as string))) throw new Error('invalid path');
          observation.path = path;
        }
        if ('status' in rawObservation) {
          if (kind !== 'http') throw new Error('unexpected status');
          observation.status = integer(rawObservation.status, 400, 599);
        }
        if ('resourceType' in rawObservation) {
          if (kind !== 'http' || !resources.includes(string(rawObservation.resourceType))) throw new Error('invalid resource type');
          observation.resourceType = rawObservation.resourceType as string;
        }
        if ('expected' in rawObservation) {
          if (typeof rawObservation.expected !== 'boolean' || kind !== 'http') throw new Error('invalid expected');
          observation.expected = rawObservation.expected;
        }
        if ('errorClass' in rawObservation) {
          if (!['timeout', 'selector', 'navigation', 'other'].includes(string(rawObservation.errorClass)) || kind !== 'flow-failure') throw new Error('invalid error class');
          observation.errorClass = rawObservation.errorClass as Observation['errorClass'];
        }
        if (kind === 'http' && (observation.status === undefined || observation.path === undefined || observation.resourceType === undefined)
          || kind === 'flow-failure' && observation.errorClass === undefined) throw new Error('missing observation fields');
        return observation;
      });
      object(rawRun.blockedExternal);
      const blockedExternal: Record<string, number> = Object.create(null) as Record<string, number>;
      if (Object.keys(rawRun.blockedExternal).length > 200) throw new Error('host cap');
      for (const [host, count] of Object.entries(rawRun.blockedExternal)) {
        if (host.length > 253 || !/^[a-zA-Z0-9.[\]:_-]+$/.test(host)) throw new Error('invalid host');
        blockedExternal[host] = integer(count, 1, Number.MAX_SAFE_INTEGER);
      }
      return { flow: flow.name, run, completed: rawRun.completed, observations, blockedExternal, notes };
    });
    // Preserve missing coverage instead of allowing a partial report to appear clean.
    for (const flow of flows.values()) for (const run of [1, 2] as const) if (!seen.has(`${flow.name}|${run}`)) {
      runs.push({ flow: flow.name, run, completed: false, observations: [], blockedExternal: Object.create(null) as Record<string, number>, notes: ['missing run'] });
    }
    return { version: 1, runs };
  } catch { return { error: 'Invalid runtime report' }; }
}
