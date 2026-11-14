const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { ConfigStore } = require('./config');
const { createApi } = require('./api');

const PUBLIC = path.join(__dirname, '..', 'frontend');
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/playback.js', ['playback.js', 'text/javascript; charset=utf-8']],
  ['/workspaces.js', ['workspaces.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function createServer(options = {}) {
  const store = options.store || new ConfigStore(options.dataDir);
  const azure = options.azure || require('./azure');
  const api = createApi({ store, azure, foundry: options.foundry || require('./foundry') });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const origin = new URL(`${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
        throw Object.assign(new Error('This dashboard is available through localhost only.'), { status: 403 });
      }
      const url = new URL(req.url, origin);
      if (url.origin !== origin.origin) throw Object.assign(new Error('Invalid request origin.'), { status: 403 });
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.headers['x-dashboard-request'] !== '1' || (req.headers.origin && req.headers.origin !== origin.origin)) {
          throw Object.assign(new Error('Invalid dashboard request origin.'), { status: 403 });
        }
      }
      if (url.pathname === '/healthz' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ ok: true }));
      }
      if (url.pathname.startsWith('/api/')) {
        const result = await api(req, res, url);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify(result));
      }
      const entry = staticFiles.get(url.pathname);
      if (!entry || !['GET', 'HEAD'].includes(req.method)) throw Object.assign(new Error('Not found.'), { status: 404 });
      const content = await fs.promises.readFile(path.join(PUBLIC, entry[0]));
      res.setHeader('Content-Type', entry[1]);
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (err) {
      if (res.destroyed) return;
      const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
      if (status >= 500) console.error('Dashboard request failed:', err.message);
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 500 ? 'Dashboard request failed. Check the backend output.' : err.message);
    }
  });
  server.requestTimeout = 60000;
  server.on('close', () => azure.stopLogin?.());
  return server;
}

if (require.main === module) {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '3000' }, host: { type: 'string', default: '127.0.0.1' }, 'data-dir': { type: 'string' },
  } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535.');
  const server = createServer({ dataDir: values['data-dir'] });
  server.on('error', (err) => { console.error('Dashboard failed to start:', err.message); process.exitCode = 1; });
  server.listen(port, values.host, () => console.log(`Agent Dashboard on http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    require('./azure').stopLogin();
    server.close();
    server.closeIdleConnections();
  });
}

module.exports = { createServer };
