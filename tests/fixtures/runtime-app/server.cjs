const { createServer } = require('node:http');

function createFixtureServer(behavior = process.env.QUORUM_FIXTURE || 'good') {
  const scripts = {
    'console-error': "<script>console.error('boom')</script>",
    uncaught: "<script>throw new Error('uncaught')</script>",
    http500: "<script>fetch('/api/data')</script>",
    http404: '<script src="/missing.js"></script>',
    external: '<script src="https://example.test/x.js"></script><script>fetch(\'https://example.test/x.js\')</script>',
  };
  return createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === '/api/data') {
      res.writeHead(behavior === 'http500' ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(behavior === 'http500' ? '{"error":"fixture failure"}' : '{"ok":true}');
    } else if (pathname === '/' || pathname === '/about') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const body = pathname === '/about' ? '<h1>About</h1><p>A synthetic fixture page.</p>'
        : behavior === 'blank' ? ''
        : behavior === 'technical' ? '<h1>TypeError: x is not a function</h1><p>Internal Server Error</p>'
        : '<h1>Runtime fixture</h1><a href="/about">About</a>' + (scripts[behavior] || '');
      res.end('<!doctype html><html><head><title>Runtime fixture</title></head><body>' + body + '</body></html>');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
}

module.exports = { createFixtureServer };
if (require.main === module) createFixtureServer().listen(Number(process.env.PORT || 4173), '127.0.0.1');
