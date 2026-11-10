// Each project's user numbers: config, collection, carry-forward, page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConfig, collectUsers, carryUsers, checkUsers, renderUsersLine } from '../scripts/lib/users.mjs';
import { build } from '../scripts/build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACC = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DB = '22222222-2222-4222-8222-222222222222';
const project = (metrics) => ({ d1: { account: ACC, database: DB }, metrics });
const visits = [{ label: 'visits yesterday', sql: 'SELECT 11 AS n' }, { label: 'last 7 days', sql: 'SELECT 26 AS n' }];

test('users: the config is checked before anything is read', async () => {
  assert.deepEqual(checkConfig({ projects: { pingly: project(visits) } }), []);
  // The repo's own config is usable.
  const real = JSON.parse(await readFile(path.join(root, 'users.config.example.json'), 'utf8'));
  assert.ok(Object.keys(real.projects).length > 0);
  assert.deepEqual(checkConfig(real), []);
  const bad = checkConfig({ projects: {
    a: project([{ label: 'x', sql: 'DELETE FROM daily' }]),
    b: project(Array.from({ length: 6 }, () => ({ label: 'x', sql: 'SELECT 1 AS n' }))),
    c: { d1: { account: 'nope', database: DB }, metrics: visits },
    d: project([{ label: '', sql: 'SELECT 1 AS n' }]),
  } });
  assert.equal(bad.length, 4);
  assert.match(bad.join('\n'), /a: metrics\[0\]\.sql must be a SELECT/);
  assert.match(bad.join('\n'), /b: 1 to 5 metrics/);
  assert.match(bad.join('\n'), /c: d1\.account and d1\.database must be ids/);
  assert.match(bad.join('\n'), /d: metrics\[0\]\.label/);
  assert.deepEqual(checkConfig({}), ['no "projects" object']);
});

test('users: each project is read from its own database; one failure never hides the others', async () => {
  const calls = [];
  const query = async (statements, opts) => {
    calls.push({ statements, opts });
    if (opts.target.database === 'ffffffff-ffff-ffff-ffff-ffffffffffff') throw new Error('D1: 7403: not authorized');
    if (statements[0].sql.includes('wrong')) return [{ results: [{ total: 3 }] }];
    return statements.map((s) => ({ results: [{ n: s.sql.includes('NULL') ? null : Number(s.sql.match(/\d+/)[0]) }] }));
  };
  const config = { projects: {
    pingly: project([...visits, { label: 'installs', sql: 'SELECT NULL AS n' }]),
    gone: { d1: { account: ACC, database: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }, metrics: visits },
    typo: project([{ label: 'visits', sql: 'SELECT 3 AS wrong' }]),
  } };
  const u = await collectUsers(config, { query, now: Date.parse('2026-11-06T06:40:00Z') });
  assert.equal(checkUsers(u), null);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.find((c) => c.opts.target.database === DB && c.statements.length === 3).opts.target, { account: ACC, database: DB });
  const by = Object.fromEntries(u.projects.map((p) => [p.project, p]));
  // An empty day (SUM over no rows is NULL) is a zero.
  assert.deepEqual(by.pingly, { project: 'pingly', metrics: [{ label: 'visits yesterday', n: 11 }, { label: 'last 7 days', n: 26 }, { label: 'installs', n: 0 }], read_at: '2026-11-06T06:40:00.000Z', problem: null });
  assert.equal(by.gone.metrics, null);
  assert.match(by.gone.problem, /not authorized/);
  // A query without a column n is a broken config, never a zero.
  assert.equal(by.typo.metrics, null);
  assert.match(by.typo.problem, /"visits": no row with a column n/);
});

test('users: a project that failed today keeps its last numbers, and the line says from when', () => {
  const previous = { generated_at: '2026-11-05T06:40:00Z', projects: [{ project: 'pingly', metrics: [{ label: 'visits yesterday', n: 9 }], read_at: '2026-11-05T06:40:00.000Z', problem: null }] };
  const fresh = { generated_at: '2026-11-06T06:40:00Z', projects: [{ project: 'pingly', metrics: null, read_at: null, problem: 'D1: no answer after 30 s' }, { project: 'new', metrics: null, read_at: null, problem: 'boom' }] };
  const u = carryUsers(fresh, previous);
  assert.deepEqual(u.projects[0], { project: 'pingly', metrics: [{ label: 'visits yesterday', n: 9 }], read_at: '2026-11-05T06:40:00.000Z', problem: 'D1: no answer after 30 s' });
  assert.equal(u.projects[1].metrics, null);
  assert.match(renderUsersLine(u, 'pingly'), /<b>9<\/b> visits yesterday<\/span> <span class="users-old">· from 5 Nov<\/span>/);
  // Never read: nothing on the row, the reason on the page.
  assert.equal(renderUsersLine(u, 'new'), '');
  assert.match(renderUsersLine(u, 'new', { page: true }), /User numbers could not be read: boom/);
  assert.equal(renderUsersLine(u, 'other'), '');
  assert.equal(renderUsersLine(null, 'pingly'), '');
});

const status = (name) => ({
  schema_version: 2,
  project: name,
  repo_url: `https://github.com/o/${name}`,
  urls: { sandbox: null, production: null },
  version: { sandbox: null, production: '1.0.0' },
  pending_release: { merged_prs: null, release_pr_url: null },
  open_issues: 0,
  owner_tasks: [],
  next_steps: [],
  health: 'ok',
  health_reason: null,
  last_session: '2026-11-06T08:00:00+00:00',
  summary: null,
  links: [],
});

test('users: the numbers show small on the project row and its page, only for projects that have them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-users-'));
  await mkdir(path.join(dir, 'status'));
  for (const name of ['pingly', 'blog']) await writeFile(path.join(dir, 'status', `${name}.json`), JSON.stringify(status(name)));
  const usersFile = path.join(dir, 'users.json');
  await writeFile(usersFile, JSON.stringify({ generated_at: '2026-11-06T06:40:00Z', projects: [{ project: 'pingly', metrics: [{ label: 'visits yesterday', n: 1234 }, { label: 'last 7 days', n: 26 }], read_at: '2026-11-06T06:40:00.000Z', problem: null }] }));
  const none = path.join(dir, 'none.json');
  await build({ statusDir: path.join(dir, 'status'), usageFile: none, storageFile: none, appsFile: none, claudeFile: none, usersFile, outDir: path.join(dir, 'dist'), log: () => {} });
  const html = await readFile(path.join(dir, 'dist/index.html'), 'utf8');
  // Each count in its own nowrap span, so a long line never splits one.
  const line = '<span class="users-n"><b>1,234</b> visits yesterday</span> · <span class="users-n"><b>26</b> last 7 days</span>';
  assert.match(html, /<a class="row row-head has-users" href="#\/p\/pingly"/);
  assert.match(html, /<a class="row row-head" href="#\/p\/blog"/);
  assert.ok(html.includes(`<span class="users-line" title="Read 6 Nov">${line}</span>`));
  const page = html.slice(html.indexOf('id="project-pingly"'));
  assert.ok(page.includes(`<p class="users-line" title="Read 6 Nov">${line}</p>`));
  assert.equal(html.split('users-line"').length - 1, 2);
  // A broken file is left out, never a failed build.
  await writeFile(usersFile, '{"projects":1}');
  const logs = [];
  await build({ statusDir: path.join(dir, 'status'), usageFile: none, storageFile: none, appsFile: none, claudeFile: none, usersFile, outDir: path.join(dir, 'dist'), log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /INVALID {2}user numbers file/.test(m)));
  assert.doesNotMatch(await readFile(path.join(dir, 'dist/index.html'), 'utf8'), /row-head has-users|class="users-line/);
});
