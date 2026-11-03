// Records real command output with timings: node record.mjs <cwd> <out.json> -- "<command>" ...
// Each command runs through the shell; stdout and stderr chunks are stored with their offset.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [cwd, out, separator, ...commands] = process.argv.slice(2);
if (separator !== '--') throw new Error('usage: record.mjs <cwd> <out.json> -- "<command>" ...');
const session = [];
for (const command of commands) {
  const started = Date.now();
  const events = [];
  const code = await new Promise(resolve => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    const keep = chunk => events.push([Date.now() - started, chunk.toString('utf8')]);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', resolve);
  });
  session.push({ command, code, durationMs: Date.now() - started, events });
  console.error(`${command} -> exit ${code} in ${Math.round((Date.now() - started) / 1000)}s`);
}
writeFileSync(out, JSON.stringify(session, null, 2));
