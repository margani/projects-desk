// The Worker behind projects.example.dev: renders the page on each
// request from D1, so a status change shows on the next load with no commit,
// build or deploy. Manifest, icons and the service worker are static assets.
import { renderSite, parseUsage, checkGithubUsage, checkStorage, checkApps, checkClaude, checkUsers } from './site.mjs';

const PAGE = new Set(['/', '/index.html']);

/** Status rows and usage from D1 in one round trip. */
export async function readData(db) {
  const [status, usage] = await db.batch([
    db.prepare('SELECT project, body, updated_at FROM status ORDER BY project'),
    db.prepare('SELECT key, body, updated_at FROM usage'),
  ]);
  const byKey = Object.fromEntries((usage.results ?? []).map((r) => [r.key, r]));
  const times = [...(status.results ?? []), ...(usage.results ?? [])].map((r) => r.updated_at).filter(Boolean).sort();
  return {
    statusRows: (status.results ?? []).map((r) => ({ name: r.project, text: r.body })),
    usage: parseUsage(byKey.github?.body, checkGithubUsage, 'GitHub usage', console.warn),
    storage: parseUsage(byKey.storage?.body, checkStorage, 'storage usage', console.warn),
    apps: parseUsage(byKey.apps?.body, checkApps, 'desktop apps', console.warn),
    claude: parseUsage(byKey.claude?.body, checkClaude, 'Claude usage', console.warn),
    users: parseUsage(byKey.users?.body, checkUsers, 'user numbers', console.warn),
    updatedAt: times.at(-1) ?? null,
  };
}

const NO_STORE = { 'cache-control': 'no-store' };

export function createWorker({ css, js }) {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (!PAGE.has(pathname) && pathname !== '/version.json') return env.ASSETS.fetch(request);
      let data;
      try {
        data = await readData(env.DB);
      } catch (err) {
        // Say so instead of an empty dashboard that looks like "no projects".
        return new Response(`The dashboard could not read its database: ${err.message}`, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE } });
      }
      const { html, version } = await renderSite({ ...data, css, js, now: Date.now() });
      if (pathname === '/version.json') {
        return new Response(JSON.stringify({ version }) + '\n', { headers: { 'content-type': 'application/json', ...NO_STORE } });
      }
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE } });
    },
  };
}
