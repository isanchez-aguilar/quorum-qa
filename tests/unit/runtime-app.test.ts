import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import { get } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const request = (port: number, path: string) => new Promise<{ status: number; body: string; cache: string | undefined }>((resolve, reject) => {
  get({ hostname: '127.0.0.1', port, path }, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode!, body, cache: response.headers['cache-control'] }));
    response.on('error', reject);
  }).on('error', reject);
});
it.each([
  ['good', '<a href="/about">About</a>'], ['console-error', "console.error('boom')"],
  ['uncaught', "throw new Error('uncaught')"], ['http500', "fetch('/api/data')"],
  ['http404', '<script src="/missing.js">'], ['blank', '<body></body>'],
  ['technical', 'TypeError: x is not a function'], ['external', "fetch('https://example.test/x.js')"],
  ['layout-break', 'position:absolute'],
])('serves %s on loopback with no caching', async (behavior, expected) => {
  const { createFixtureServer } = require('../fixtures/runtime-app/server.cjs') as { createFixtureServer: () => Server };
  const previous = process.env.QUORUM_FIXTURE;
  process.env.QUORUM_FIXTURE = behavior;
  let server: Server;
  try { server = createFixtureServer(); }
  finally {
    if (previous === undefined) delete process.env.QUORUM_FIXTURE;
    else process.env.QUORUM_FIXTURE = previous;
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    expect(address.address).toBe('127.0.0.1');
    const home = await request(address.port, '/');
    expect(home).toMatchObject({ status: 200, cache: 'no-store' }); expect(home.body).toContain(expected);
    const about = await request(address.port, '/about');
    expect(about).toMatchObject({ status: 200, cache: 'no-store' }); expect(about.body).toContain('About');
    expect(await request(address.port, '/missing.js')).toMatchObject({ status: 404, cache: 'no-store' });
    const api = await request(address.port, '/api/data');
    expect(api).toEqual({ status: behavior === 'http500' ? 500 : 200,
      cache: 'no-store', body: behavior === 'http500' ? '{"error":"fixture failure"}' : '{"ok":true}' });
    if (behavior === 'technical') expect(home.body).toContain('Internal Server Error');
    if (behavior === 'external') expect(home.body).toContain('<script src="https://example.test/x.js">');
    if (behavior === 'layout-break') {
      expect(home.body).toContain('Layout box two'); expect(home.body).not.toContain('<button');
      expect(home.body).not.toContain('<script');
    }
    if (behavior === 'good') expect(home.body).toContain('<button');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
it('defaults to the good behavior', async () => {
  const { createFixtureServer } = require('../fixtures/runtime-app/server.cjs') as { createFixtureServer: (behavior: string) => Server };
  const server = createFixtureServer('');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    expect((await request(address.port, '/')).body).toContain('<a href="/about">About</a>');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
