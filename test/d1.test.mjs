// The page from D1: the Worker renders it on each request, and the
// laptop keeps D1 in step with status/*.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from '../scripts/lib/worker.mjs';
import { query, planSync, sha256, usageStatement } from '../scripts/lib/d1.mjs';
import { renderWrangler } from '../scripts/lib/config.mjs';
import { build } from '../scripts/build.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const D1 = { account: 'a'.repeat(32), database: '11111111-1111-4111-8111-111111111111', name: 'desk-test' };

const status = (project, extra = {}) => JSON.stringify({
  schema_version: 5, project, repo_url: `https://github.com/acme-user/${project}`,
  urls: { sandbox: null, production: null }, version: { sandbox: null, production: '1.0.0' },
  pending_release: { merged_prs: null, release_pr_url: null },
  open_issues: 0, closed_issues: 0, owner_tasks: [], next_steps: [], health: 'ok', health_reason: null,
  last_session: '2026-10-20T08:00:00+01:00', summary: `summary of ${project}`, links: [], activity: null, ...extra,
});
const storage = { generated_at: '2026-10-20T12:00:00Z', sources: [{ group: 'OneDrive', name: 'onedrive-2', kind: 'OneDrive', total: 1100e9, used: 938e9, free: 166e9, trashed: 0, percent: 84.9, problem: null }] };

/** A D1 binding answering from in-memory rows, like env.DB in the Worker. */
function fakeDb(tables) {
  const prepare = (sql) => ({ sql });
  return {
    prepare,
    async batch(statements) {
      return statements.map(({ sql }) => {
        if (tables.fail) throw new Error(tables.fail);
        const name = /FROM (\w+)/.exec(sql)[1];
        return { results: tables[name] ?? [] };
      });
    },
  };
}
const env = (tables) => ({
  DB: fakeDb(tables),
  ASSETS: { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`) },
});
const worker = createWorker({ css: 'body{}', js: '/* client */' });
const get = (p, e) => worker.fetch(new Request(`https://projects.example.dev${p}`), e);

test('worker: the page comes from D1 rows, and version.json matches the page', async () => {
  const e = env({
    status: [
      { project: 'alpha', body: status('alpha'), updated_at: '2026-10-20T11:00:00Z' },
      { project: 'broken', body: '{ not json', updated_at: '2026-10-20T11:30:00Z' },
    ],
    usage: [{ key: 'storage', body: JSON.stringify(storage), updated_at: '2026-10-20T12:00:00Z' }],
  });
  const res = await get('/', e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('summary of alpha'));
  assert.ok(html.includes('Not valid JSON'), 'a broken file still shows, as a warning card');
  assert.ok(html.includes('id="storage-heading"'), 'usage rows reach the Storage tab');
  assert.ok(html.includes('<style>body{}</style>') && html.includes('/* client */'));
  // The footer says when the newest data arrived, not when the page rendered.
  assert.ok(html.includes('Last update <time datetime="2026-10-20T12:00:00Z"'));

  const v = await (await get('/version.json', e)).json();
  assert.match(v.version, /^[0-9a-f]{16}$/);
  assert.ok(html.includes(`<meta name="dashboard-version" content="${v.version}">`));
  // A status change changes the version, so open pages offer the update.
  const changed = env({ status: [{ project: 'alpha', body: status('alpha', { summary: 'new' }), updated_at: '2026-10-20T12:30:00Z' }], usage: [] });
  assert.notEqual((await (await get('/version.json', changed)).json()).version, v.version);
});

test('worker: static files go to the assets; a D1 failure says so instead of an empty page', async () => {
  assert.equal(await (await get('/manifest.webmanifest', env({}))).text(), 'asset /manifest.webmanifest');
  assert.equal(await (await get('/icons/icon-192.png', env({}))).text(), 'asset /icons/icon-192.png');
  const res = await get('/', env({ fail: 'D1_ERROR: database unavailable' }));
  assert.equal(res.status, 503);
  assert.match(await res.text(), /could not read its database: D1_ERROR: database unavailable/);
  // Broken usage JSON is left out; the page still renders.
  const html = await (await get('/', env({ status: [{ project: 'a', body: status('a'), updated_at: '2026-10-20T11:00:00Z' }], usage: [{ key: 'storage', body: '{"sources": 3}', updated_at: 'x' }] }))).text();
  assert.ok(html.includes('No storage numbers yet'));
});

test('sync: only changed files are written, broken ones are kept out, removed ones deleted', () => {
  const a = status('alpha');
  const files = [
    { name: 'alpha', text: a },
    { name: 'beta', text: status('beta') },
    { name: 'gamma', text: '{"half": ' },
  ];
  const remote = [
    { project: 'alpha', sha: sha256(a) },
    { project: 'beta', sha: 'old' },
    { project: 'gamma', sha: 'last-good' },
    { project: 'retired', sha: 'x' },
  ];
  const plan = planSync(files, remote, Date.parse('2026-10-20T12:00:00Z'));
  assert.deepEqual(plan.upserts, ['beta']);
  assert.deepEqual(plan.deletes, ['retired'], 'gamma keeps its last good copy');
  assert.deepEqual(plan.invalid.map((x) => x.name), ['gamma']);
  assert.equal(plan.invalid[0].sha, sha256('{"half": '));
  assert.equal(plan.statements.length, 2);
  assert.match(plan.statements[0].sql, /^INSERT INTO status .* ON CONFLICT\(project\) DO UPDATE/);
  assert.deepEqual(plan.statements[0].params, ['beta', status('beta'), sha256(status('beta')), '2026-10-20T12:00:00Z']);
  assert.deepEqual(plan.statements[1], { sql: 'DELETE FROM status WHERE project = ?', params: ['retired'] });
  // Nothing new: no statements at all.
  assert.equal(planSync([{ name: 'alpha', text: a }], [{ project: 'alpha', sha: sha256(a) }], 0).statements.length, 0);
  assert.equal(planSync([{ name: 'list', text: '[1]' }], [], 0).invalid[0].message, 'top level is not a JSON object');
  assert.deepEqual(usageStatement('storage', { a: 1 }, Date.parse('2026-10-20T12:00:00Z')).params, ['storage', '{"a":1}', '2026-10-20T12:00:00Z']);
});

test('d1 client: reads with the read token, writes with --edit, one batch through a file', async () => {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    const body = JSON.parse(await readFile(args.at(-1).slice(1), 'utf8'));
    calls.push({ cmd, args, opts, body });
    return { stdout: JSON.stringify({ success: true, errors: [], result: [{ results: [{ project: 'a', sha: 'x' }] }] }) };
  };
  const [r] = await query([{ sql: 'SELECT project, sha FROM status' }], { exec, target: D1 });
  assert.deepEqual(r.results, [{ project: 'a', sha: 'x' }]);
  assert.deepEqual(calls[0].args.slice(0, 2), ['POST', `/accounts/${D1.account}/d1/database/${D1.database}/query`]);
  assert.deepEqual(calls[0].body, { sql: 'SELECT project, sha FROM status' });
  assert.ok(calls[0].opts.timeout > 0);

  await query([{ sql: 'A', params: ['1'] }, { sql: 'B' }], { exec, write: true, target: D1 });
  assert.equal(calls[1].args[0], '--edit');
  assert.deepEqual(calls[1].body, { batch: [{ sql: 'A', params: ['1'] }, { sql: 'B' }] });
  // The temporary body file is gone afterwards.
  await assert.rejects(access(calls[1].args.at(-1).slice(1)));

  const failing = async () => { throw Object.assign(new Error('Command failed: cfapi'), { code: 1, stdout: JSON.stringify({ success: false, errors: [{ code: 7500, message: 'no such table: status' }] }) }); };
  await assert.rejects(query([{ sql: 'SELECT 1' }], { exec: failing, target: D1 }), /D1: 7500: no such table: status/);
});

test('deploy: the Worker binds the same database the laptop writes, and the build ships no stale page', async () => {
  const cfg = renderWrangler({ worker_name: 'desk-test', d1: D1, domains: ['desk.example.dev'] });
  assert.equal(cfg.main, 'src/worker.mjs');
  assert.deepEqual(cfg.d1_databases, [{ binding: 'DB', database_name: D1.name, database_id: D1.database }]);
  assert.equal(cfg.account_id, D1.account);
  assert.equal(cfg.assets.binding, 'ASSETS');
  assert.deepEqual(cfg.assets.run_worker_first, ['/', '/index.html', '/version.json'], 'the page is never a stale file');
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);

  // Workers Builds has no status/ folder: app files and inline.mjs only.
  const dir = await mkdtemp(path.join(tmpdir(), 'd1-build-'));
  const out = path.join(dir, 'dist');
  const log = [];
  await build({ statusDir: path.join(dir, 'status'), outDir: out, log: (l) => log.push(l) });
  const files = (await readdir(out)).sort();
  assert.ok(files.includes('inline.mjs') && files.includes('manifest.webmanifest') && files.includes('sw.js'));
  assert.ok(!files.includes('index.html'), 'no page from build time');
  const inline = await import(path.join(out, 'inline.mjs'));
  assert.equal(inline.css, await readFile(path.join(root, 'src/styles.css'), 'utf8'));
  assert.equal(inline.js, await readFile(path.join(root, 'src/client.js'), 'utf8'));
  // A local build's page never goes up as a file that would shadow the Worker.
  assert.deepEqual((await readFile(path.join(out, '.assetsignore'), 'utf8')).trim().split('\n'), ['index.html', 'version.json', 'inline.mjs']);
  assert.ok(log.some((l) => l.includes('No status/ folder')));

  // With status files (the laptop, tests) the local page is still built.
  await mkdir(path.join(dir, 'status'));
  await writeFile(path.join(dir, 'status/a.json'), status('a'));
  await build({ statusDir: path.join(dir, 'status'), outDir: out, log: () => {} });
  assert.ok((await readFile(path.join(out, 'index.html'), 'utf8')).includes('summary of a'));
});
