import { writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { expect, it } from 'vitest';

it('rejects an attempted write outside the worktree', () => {
  let escaped = false;
  try {
    writeFileSync('/quorum-escape', 'synthetic escape attempt');
    escaped = true;
  } catch { /* Read-only root must reject the write. */ }
  expect(escaped, 'sandbox allowed a write outside /work').toBe(false);
});

it('rejects an attempted external network socket', async () => {
  const connected = await new Promise(resolve => {
    const socket = createConnection({ host: '1.1.1.1', port: 80 });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
  expect(connected, 'sandbox allowed an external network socket').toBe(false);
});
