// Loopback-only static preview. This server has no database-management endpoints.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const files = new Set(['index.html', 'styles.css', 'app.js', 'core.js', 'store.js', 'config.js', 'favicon.svg', 'README.md', 'vendor/supabase.js', 'vendor/README.md', 'vendor/SUPABASE-LICENSE.txt']);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 4173);
createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const name = path === '/' ? 'index.html' : path.slice(1);
    if (!files.has(name)) { res.writeHead(404).end('Not found'); return; }
    const data = await readFile(new URL('../' + name, import.meta.url));
    res.writeHead(200, { 'Content-Type': `${types[extname(name)] || 'text/plain'}; charset=utf-8` }).end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
