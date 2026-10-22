'use strict';

function sanitize(text, plan) {
  for (const flow of plan.flows) for (const step of flow.steps) {
    if ('fill' in step && step.value) text = text.split(step.value).join('[redacted]');
  }
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').slice(-2000);
}

async function run({ start, plan, childProcess = require('node:child_process'), http = require('node:http'),
  kill = process.kill, env = process.env, collect = options => require('./collector.cjs').run(options),
  playwright, now = Date.now }) {
  const url = new URL(plan.readyUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Invalid readiness URL');
  const app = childProcess.spawn(start[0], start.slice(1), {
    shell: false, detached: true, cwd: '/work', stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: env.PATH, HOME: '/tmp', TMPDIR: '/tmp', XDG_CACHE_HOME: '/tmp', NODE_ENV: 'development',
      ...(url.port ? { PORT: url.port } : {}), CI: '1' },
  });
  let tail = ''; let exited = false; let exitCode;
  app.stderr.on('data', chunk => { tail = (tail + chunk.toString()).slice(-4000); });
  app.once('exit', code => { exited = true; if (Number.isInteger(code)) exitCode = code; });
  app.once('error', () => { exited = true; });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = now() + plan.readyTimeoutSeconds * 1000;
  const probe = () => new Promise(resolve => {
    let request; let settled = false;
    const finish = ready => { if (settled) return; settled = true; clearTimeout(timer); request?.destroy(); resolve(ready); };
    const timer = setTimeout(() => finish(false), Math.max(1, Math.min(1000, deadline - now())));
    try {
      request = http.get(url, response => { response.resume(); finish(response.statusCode < 500); });
      request.once('error', () => finish(false));
    } catch { finish(false); }
  });
  try {
    while (!exited && now() < deadline) {
      const ready = await probe();
      if (exited) break;
      if (ready) return await collect({ playwright: playwright ?? require('/quorum/playwright/node_modules/playwright-core'), plan });
      await sleep(Math.max(0, Math.min(250, deadline - now())));
    }
    return { error: exited ? 'app-exited' : 'not-ready', ...(exitCode === undefined ? {} : { exitCode }), stderrTail: sanitize(tail, plan) };
  } finally {
    // Kill the group even when the leader exited: descendants can still hold ports/pipes.
    if (app.pid) {
      try { kill(-app.pid, 'SIGTERM'); } catch {}
      await sleep(3000);
      try { kill(-app.pid, 'SIGKILL'); } catch {}
    }
    app.stderr.destroy?.();
  }
}

module.exports = { run, sanitize };
if (require.main === module) {
  const [planPath, marker, encodedStart] = process.argv.slice(2);
  (async () => {
    const plan = JSON.parse(require('node:fs').readFileSync(planPath, 'utf8'));
    const report = await run({ start: JSON.parse(encodedStart), plan });
    process.stdout.write('\n' + marker + JSON.stringify(report) + '\n');
  })().catch(() => { process.exitCode = 1; });
}
