'use strict';
const { scrubForDisplay, redact } = require('./scrub.cjs');

const CHROMIUM_ARGS = Object.freeze(['--no-sandbox', '--disable-dev-shm-usage']);
const MAX_BYTES = 2 * 1024 * 1024;
// about:blank and other opaque URLs have no absolute path; record none.
const pathname = value => { try { const path = new URL(value).pathname; return path.startsWith('/') ? path : ''; } catch { return ''; } };

// Runs in the page. Return only matched snippets; redact before bounding them outside.
function inspectBody() {
  const text = document.body?.innerText || '';
  const visible = [...document.querySelectorAll('img,svg,canvas,video,input')].some(element => {
    const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  });
  const patterns = [/\bat [\w.$<>]+ \([^\n)]*:\d+:\d+\)/, /\bTypeError:/, /\bReferenceError:/, /\bSyntaxError:/,
    /\bundefined\b/, /\[object Object\]/, /\bNaN\b/, /\bInternal Server Error\b/, /\bECONNREFUSED\b/, /^\s*\{\s*"(?:error|message)"/];
  const snippets = [];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) snippets.push(match[0]);
  }
  return { blank: text.trim() === '' && !visible, snippets };
}

async function run({ playwright, plan, now = Date.now }) {
  const report = { version: 1, runs: plan.flows.flatMap(flow => [1, 2].map(run => ({
    flow: flow.name, run, completed: false, observations: [], blockedExternal: Object.create(null), notes: [],
  }))) };
  // Reserve bounded metadata space (hosts, notes and completion) before observations.
  let bytes = Buffer.byteLength(JSON.stringify(report)); let total = 0; let sizeCapped = false;
  const reserve = report.runs.length * 16000;
  const clean = text => scrubForDisplay(redact(text, plan));
  const infrastructure = (result, error) => {
    result.completed = false;
    const message = clean(String(error.message ?? error));
    if (message.length > 2000 && !result.notes.includes('cap: message')) result.notes.push('cap: message');
    // Reserve includes one infrastructure failure per run, even after observation caps.
    if (result.observations.some(item => item.errorClass === 'infrastructure')) return;
    if (result.observations.length >= 200) { result.observations.pop(); result.notes.push('cap: observations per run'); }
    result.observations.push({ kind: 'flow-failure', step: 0, errorClass: 'infrastructure', message: message.slice(0, 2000) });
  };
  let browser;
  try { browser = await playwright.chromium.launch({ args: CHROMIUM_ARGS }); }
  catch (error) { for (const result of report.runs) infrastructure(result, error); return report; }
  try {
    for (let index = 0; index < report.runs.length; index++) {
      const result = report.runs[index]; const flow = plan.flows[Math.floor(index / 2)];
      let context; let page; let step = 0; let active = true; let expected; let currentAction;
      const requests = new WeakMap();
      const deadline = now() + (plan.flowTimeoutSeconds ?? 60) * 1000;
      const note = message => { if (!result.notes.includes(message)) result.notes.push(message); };
      const add = observation => {
        if (!active) return;
        const cap = 2000;
        observation.message = clean(observation.message);
        if (observation.message.length > cap) note('cap: message');
        observation.message = observation.message.slice(0, cap);
        if (observation.path) observation.path = scrubForDisplay('http://runtime' + redact(observation.path, plan)).slice('http://runtime'.length);
        if (observation.path?.length > 500) { note('cap: path'); observation.path = observation.path.slice(0, 500); }
        if (result.observations.length >= 200) { note('cap: observations per run'); return; }
        if (total >= 2000 - report.runs.length) { note('cap: observations per report'); return; }
        const size = Buffer.byteLength(JSON.stringify(observation)) + 1;
        if (sizeCapped || bytes + size + reserve > MAX_BYTES) { sizeCapped = true; note('cap: report size'); return; }
        bytes += size; total++; result.observations.push(observation);
      };
      const event = (kind, message, fields = {}) => add({ kind, step, path: pathname(page.url()), message, ...fields });
      const timeout = () => Object.assign(new Error('Flow timeout'), { name: 'TimeoutError' });
      async function bounded(operation, limit) {
        const remaining = Math.min(limit, deadline - now());
        if (remaining <= 0) throw timeout();
        let timer;
        try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), remaining); })]); }
        finally { clearTimeout(timer); }
      }
      try {
        context = await bounded(async () => {
          const created = await browser.newContext({ serviceWorkers: 'block' });
          if (!active) { await created.close(); throw timeout(); }
          return created;
        }, Infinity);
        await bounded(() => context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue();
          if (active && url.hostname) {
            const host = clean(url.hostname);
            if (Object.hasOwn(result.blockedExternal, host)) result.blockedExternal[host]++;
            else if (['__proto__', 'constructor', 'prototype'].includes(url.hostname)) note('cap: external hosts');
            else if (sizeCapped || bytes + reserve + 300 > MAX_BYTES) { sizeCapped = true; note('cap: report size'); }
            else if (Object.keys(result.blockedExternal).length < 200) { result.blockedExternal[host] = 1; bytes += 300; }
            else note('cap: external hosts');
          }
          return route.fulfill({ status: 204, body: '' });
        }), Infinity);
        page = await bounded(() => context.newPage(), Infinity);
        page.on('request', request => { if (active) requests.set(request, step); });
        page.on('console', message => { if (message.type() === 'error') event('console', message.text()); });
        page.on('pageerror', error => event('pageerror', String(error.message ?? error)));
        page.on('response', response => {
          const status = response.status(); if (status < 400) return;
          const request = response.request(); const type = request.resourceType();
          const resourceType = ['document', 'script', 'stylesheet', 'image', 'font', 'fetch', 'xhr'].includes(type) ? type : 'other';
          const path = pathname(response.url());
          const isExpected = status < 500 && expected?.includes(status) && requests.get(request) === step
            && (['fetch', 'xhr'].includes(type) || type === 'document' && request.isNavigationRequest() && request.frame() === page.mainFrame());
          event('http', `${status} ${path}`, { path, status, resourceType, ...(isExpected ? { expected: true } : {}) });
        });
        page.on('requestfailed', request => event('requestfailed', request.failure()?.errorText ?? 'Request failed', { path: pathname(request.url()) }));
        for (step = 0; step < flow.steps.length; step++) {
          const action = flow.steps[step]; const timeoutMs = (action.timeoutSeconds ?? plan.stepTimeoutSeconds ?? 10) * 1000;
          currentAction = Object.keys(action).find(key => ['goto', 'click', 'fill', 'press', 'waitForUrl', 'waitForSelector', 'wait'].includes(key));
          expected = ['goto', 'click'].includes(currentAction) ? action.expectStatus : undefined;
          await bounded(async () => {
            const options = { timeout: Math.min(timeoutMs, deadline - now()) };
            const url = path => new URL(path, new URL(plan.readyUrl).origin).href;
            if (currentAction === 'goto') await page.goto(url(action.goto), options);
            else if (currentAction === 'click') await page.click(action.click, options);
            else if (currentAction === 'fill') await page.fill(action.fill, action.value, options);
            else if (currentAction === 'press') await page.press(action.press, action.key, options);
            else if (currentAction === 'waitForUrl') await page.waitForURL(url(action.waitForUrl), options);
            else if (currentAction === 'waitForSelector') await page.waitForSelector(action.waitForSelector, options);
            else await page.waitForTimeout(action.wait);
            if (!active) return;
            if (['goto', 'click', 'press', 'waitForUrl', 'waitForSelector'].includes(currentAction)) {
              await page.waitForLoadState('domcontentloaded', options);
              try { await page.waitForLoadState('networkidle', { timeout: Math.min(2000, options.timeout) }); }
              catch (error) { if (error.name !== 'TimeoutError') throw error; }
              if (!active) return;
              const body = await page.evaluate(inspectBody);
              if (!active) return;
              if (body.truncated) note('cap: message');
              if (body.blank) event('blank', 'blank');
              for (const snippet of body.snippets) event('technicalText', snippet);
            }
          }, timeoutMs);
          expected = undefined;
        }
        result.completed = true;
      } catch (error) {
        const message = String(error.message ?? error);
        const errorClass = !currentAction ? 'infrastructure' : error.name === 'TimeoutError' || /timed? ?out|timeout/i.test(message) ? 'timeout'
          : /selector|No element|strict mode violation/i.test(message) ? 'selector'
          : /net::|navigation|navigate/i.test(message) ? 'navigation' : 'other';
        add({ kind: 'flow-failure', step: Math.min(step, flow.steps.length - 1), errorClass, message });
      } finally {
        active = false; expected = undefined;
        if (context) try { await context.close(); } catch (error) { infrastructure(result, error); }
      }
    }
  } finally { try { await browser.close(); } catch (error) { for (const result of report.runs) infrastructure(result, error); } }
  return report;
}

module.exports = { run, CHROMIUM_ARGS };
if (require.main === module) {
  const fs = require('node:fs/promises');
  const [planPath, reportPath] = process.argv.slice(2);
  (async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    const report = await run({ playwright: require('/quorum/playwright/node_modules/playwright-core'), plan });
    await fs.writeFile(reportPath, JSON.stringify(report));
  })().catch(() => { process.exitCode = 1; });
}
