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
        : behavior === 'layout-break' ? '<h1>Runtime fixture</h1><a href="/about">About</a><div style="position:relative;height:200px"><div style="position:absolute;top:0;left:0;width:240px;background:coral">Layout box one</div><div style="position:absolute;top:0;left:40px;width:240px;background:skyblue">Layout box two</div></div>'
        : '<h1>Runtime fixture</h1><a href="/about">About</a><div>Layout box one</div><div>Layout box two</div><button type="button">Primary action</button>' + (scripts[behavior] || '');
      res.end('<!doctype html><html><head><title>Runtime fixture</title></head><body>' + body + '</body></html>');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
}

module.exports = { createFixtureServer };
if (require.main === module) createFixtureServer().listen(Number(process.env.PORT || 4173), '127.0.0.1');
