export type Step = (
  | { goto: string; expectStatus?: number[] }
  | { click: string; expectStatus?: number[] }
  | { fill: string; value: string }
  | { press: string; key: string }
  | { waitForUrl: string }
  | { waitForSelector: string }
  | { wait: number }
) & { timeoutSeconds?: number };
export interface Flow { name: string; steps: Step[] }
export interface RuntimeConfig {
  start?: string[];
  readyUrl?: string;
  flows?: Flow[];
  readyTimeoutSeconds: number;
  flowTimeoutSeconds: number;
  stepTimeoutSeconds: number;
  screenshots: boolean;
  image?: string;
  memoryMiB: number;
  pids: number;
}

type Obj = Record<string, unknown>;
const actions = ['goto', 'click', 'fill', 'press', 'waitForUrl', 'waitForSelector', 'wait'] as const;
const own = (object: Obj, key: string) => Object.prototype.hasOwnProperty.call(object, key);

// Check the original authority too: URL normalises alternate IPv4 spellings and dot segments.
function loopbackUrl(value: string): boolean {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password;
  } catch { return false; }
}
function navigation(value: string): boolean {
  if (/[\s\\\u0000-\u001f]/.test(value)) return false;
  if (!(value.startsWith('/') && !value.startsWith('//')) && !loopbackUrl(value)) return false;
  try {
    const pathname = value.startsWith('/') ? value.split(/[?#]/)[0]! : value.replace(/^http:\/\/[^/?#]+/i, '').split(/[?#]/)[0]!;
    return !decodeURIComponent(pathname).split(/[\\/]/).includes('..');
  } catch { return false; }
}

export function readRuntimeConfig(raw: unknown, issues: string[]): RuntimeConfig | undefined {
  if (raw === undefined) return undefined;
  function object(value: unknown, path: string, keys: readonly string[]): Obj {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) {
      issues.push(`${path} must be an object`); return {};
    }
    const result = value as Obj;
    // Do not interpolate unknown keys or supplied values: they may contain test credentials.
    if (Object.keys(result).some(key => !keys.includes(key))) issues.push(`${path} has unknown keys; allowed: ${keys.join(', ')}`);
    return result;
  }
  function number(value: unknown, path: string, fallback: number, min: number, max: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      issues.push(`${path} must be an integer between ${min} and ${max}`); return fallback;
    }
    return value;
  }
  function string(value: unknown, path: string, min: number, max: number): value is string {
    if (typeof value === 'string' && value.length >= min && value.length <= max) return true;
    issues.push(`${path} must be a string of ${min}-${max} characters`); return false;
  }
  const block = object(raw, 'runtime', ['start', 'readyUrl', 'readyTimeoutSeconds', 'flowTimeoutSeconds', 'stepTimeoutSeconds',
    'screenshots', 'image', 'memoryMiB', 'pids', 'flows']);
  const result: RuntimeConfig = {
    readyTimeoutSeconds: number(block.readyTimeoutSeconds, 'runtime.readyTimeoutSeconds', 60, 5, 300),
    flowTimeoutSeconds: number(block.flowTimeoutSeconds, 'runtime.flowTimeoutSeconds', 60, 10, 300),
    stepTimeoutSeconds: number(block.stepTimeoutSeconds, 'runtime.stepTimeoutSeconds', 10, 1, 60),
    screenshots: block.screenshots === true,
    memoryMiB: number(block.memoryMiB, 'runtime.memoryMiB', 2048, 2048, 8192),
    pids: number(block.pids, 'runtime.pids', 512, 512, 2048),
  };
  if (block.screenshots !== undefined && typeof block.screenshots !== 'boolean') issues.push('runtime.screenshots must be a boolean');
  if (block.start !== undefined) {
    if (!Array.isArray(block.start) || !block.start.length || !block.start.every(arg => typeof arg === 'string' && arg.trim() !== '')) {
      issues.push('runtime.start must be a non-empty argv array of non-empty strings, not a shell string');
    } else result.start = [...block.start] as string[];
  }
  if (block.readyUrl !== undefined) {
    if (typeof block.readyUrl !== 'string' || /[\s\\\u0000-\u001f]/.test(block.readyUrl) || !loopbackUrl(block.readyUrl)) {
      issues.push('runtime.readyUrl must be an http URL on 127.0.0.1, localhost or [::1], without userinfo');
    } else result.readyUrl = block.readyUrl;
  }
  if (block.image !== undefined) {
    if (typeof block.image !== 'string' || !/^[^\s@]+@sha256:[a-fA-F0-9]{64}$/.test(block.image)) issues.push('runtime.image must be a digest-pinned reference (@sha256: followed by 64 hex digits)');
    else result.image = block.image;
  }
  if (block.flows !== undefined) {
    if (!Array.isArray(block.flows) || block.flows.length < 1 || block.flows.length > 20) issues.push('runtime.flows must contain 1-20 flows');
    else {
      const names = new Set<string>();
      result.flows = block.flows.map((rawFlow, flowIndex) => {
        const flowPath = `runtime.flows[${flowIndex}]`;
        const flow = object(rawFlow, flowPath, ['name', 'steps']);
        const validName = string(flow.name, `${flowPath}.name`, 1, 60) && /^[A-Za-z0-9 _.-]+$/.test(flow.name);
        if (!validName) issues.push(`${flowPath}.name must use only letters, digits, spaces, _, . or -`);
        const name = validName ? flow.name as string : '';
        if (names.has(name)) issues.push(`${flowPath}.name must be unique`);
        names.add(name);
        const steps: Step[] = [];
        if (!Array.isArray(flow.steps) || flow.steps.length < 1 || flow.steps.length > 50) issues.push(`${flowPath} (${name}).steps must contain 1-50 steps`);
        else flow.steps.forEach((rawStep, index) => {
          const stepPath = `${flowPath} (${name}).steps[${index}]`;
          const step = object(rawStep, stepPath, [...actions, 'value', 'key', 'timeoutSeconds', 'expectStatus']);
          const selected = actions.filter(action => own(step, action));
          if (selected.length !== 1) { issues.push(`${stepPath} must have exactly one action key`); return; }
          const action = selected[0]!;
          if (action === 'wait') {
            if (!own(step, 'wait') || step.wait === undefined) issues.push(`${stepPath}.wait is required`);
            number(step.wait, `${stepPath}.wait`, 1, 1, 5000);
          } else if (action === 'goto' || action === 'waitForUrl') {
            if (typeof step[action] !== 'string' || !navigation(step[action])) issues.push(`${stepPath}.${action} must be a path or loopback http URL without userinfo or .. segments`);
          } else string(step[action], `${stepPath}.${action}`, 1, 300);
          if (action === 'fill') string(step.value, `${stepPath}.value`, 0, 500);
          else if (own(step, 'value')) issues.push(`${stepPath}.value is only allowed with fill`);
          if (action === 'press') {
            if (string(step.key, `${stepPath}.key`, 1, 40) && !/^[A-Za-z0-9+]+$/.test(step.key)) issues.push(`${stepPath}.key must use letters, digits or +`);
          } else if (own(step, 'key')) issues.push(`${stepPath}.key is only allowed with press`);
          if (own(step, 'timeoutSeconds')) number(step.timeoutSeconds, `${stepPath}.timeoutSeconds`, 10, 1, 60);
          if (own(step, 'expectStatus')) {
            if (!['goto', 'click'].includes(action)) issues.push(`${stepPath}.expectStatus is only allowed on goto and click`);
            if (!Array.isArray(step.expectStatus) || step.expectStatus.length < 1 || step.expectStatus.length > 5
              || !step.expectStatus.every(status => Number.isInteger(status) && status >= 400 && status <= 499)) {
              issues.push(`${stepPath}.expectStatus must contain 1-5 integers between 400 and 499`);
            }
          }
          steps.push({ ...step } as Step);
        });
        return { name, steps };
      });
    }
  }
  return result;
}
