// Local preview: rebuilds on every page request, so edits to status/, src/
// and scripts/lib/ show up on reload. Usage: npm run dev [-- --port 8787]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portArg = process.argv.indexOf('--port');
const port = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.PORT || 8787);

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/version.json') {
    // Read what the last build wrote; don't rebuild, so a test can change the
    // page and watch an already open tab notice it.
    try {
      const body = await readFile(path.join(root, 'dist/version.json'));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not built yet');
    }
    return;
  }
  const appFiles = { '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'text/javascript', '/icons/icon-180.png': 'image/png', '/icons/icon-192.png': 'image/png', '/icons/icon-512.png': 'image/png', '/icons/icon-maskable-512.png': 'image/png' };
  if (appFiles[pathname]) {
    try {
      const body = await readFile(path.join(root, 'dist', pathname));
      res.writeHead(200, { 'content-type': appFiles[pathname], 'cache-control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not built yet');
    }
    return;
  }
  if (pathname !== '/' && pathname !== '/index.html') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  try {
    // A fresh process each time: Node caches imported modules, so an in-process
    // build would keep using old copies of scripts/lib/*.mjs.
    execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'ignore', windowsHide: true });
    const html = await readFile(path.join(root, 'dist/index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err.stack || err));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Dashboard preview at http://localhost:${port} (rebuilds on each reload)`);
});
