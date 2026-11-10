// Schema v3: closed_issues, summed in the header and shown per project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION, loadStatus, validateStatus } from '../scripts/lib/schema.mjs';
import { build } from '../scripts/build.mjs';

const v2 = (project = 'demo', open_issues = 2) => ({
  schema_version: 2,
  project,
  repo_url: `https://github.com/o/${project}`,
  urls: { sandbox: null, production: null },
  version: { sandbox: null, production: '1.0.0' },
  pending_release: { merged_prs: null, release_pr_url: null },
  open_issues,
  owner_tasks: [],
  next_steps: [],
  health: 'ok',
  health_reason: null,
  last_session: '2026-10-09T08:00:00+01:00',
  summary: null,
  links: [],
});
const v3 = (project = 'demo', open_issues = 2, closed_issues = 10) =>
  ({ ...v2(project, open_issues), schema_version: 3, closed_issues });

test('v3 closed_issues: integer >= 0 or null, required', () => {
  assert.deepEqual(validateStatus(v3(), 'demo'), []);
  assert.deepEqual(validateStatus(v3('demo', 2, null), 'demo'), []);
  assert.ok(validateStatus(v3('demo', 2, -1), 'demo').some((p) => p.includes('"closed_issues" must be an integer ≥ 0 or null')));
  const missing = v3(); delete missing.closed_issues;
  assert.ok(validateStatus(missing, 'demo').includes('Missing field "closed_issues".'));
  assert.ok(validateStatus({ ...v2(), closed_issues: 1 }, 'demo').includes('Unknown field "closed_issues".'));
});

test('v2 still renders, marked outdated; a newer version is unknown', () => {
  const r = loadStatus('demo', JSON.stringify(v2()));
  assert.equal(r.ok, true, r.problems?.join('; '));
  assert.equal(r.outdated, true);
  assert.equal(loadStatus('demo', JSON.stringify(v3())).ok, true);
  assert.match(validateStatus({ ...v3(), schema_version: CURRENT_SCHEMA_VERSION + 1 }, 'demo')[0], new RegExp(`only understands ${CURRENT_SCHEMA_VERSION}`));
});

async function page(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-closed-'));
  await mkdir(path.join(dir, 'status'));
  for (const s of files) await writeFile(path.join(dir, 'status', `${s.project}.json`), JSON.stringify(s));
  const { entries } = await build({ statusDir: path.join(dir, 'status'), outDir: path.join(dir, 'dist'), log: () => {} });
  assert.equal(entries.filter((x) => x.ok).length, files.length);
  return readFile(path.join(dir, 'dist/index.html'), 'utf8');
}
const header = (html) => html.slice(html.indexOf('class="stats"'), html.indexOf('id="tasks-heading"'));
const tile = (value, label) => new RegExp(`<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`);

test('header sums open and closed; closed only over projects that report it', async () => {
  const html = await page([v3('a', 3, 10), v3('b', 4, null), v2('c', 5)]);
  assert.match(header(html), tile(12, 'open issues'));
  assert.match(header(html), tile(10, 'closed issues'));
});

test('no closed tile while no project reports closed', async () => {
  const row = header(await page([v2('a', 3), v2('b', 4)]));
  assert.match(row, tile(7, 'open issues'));
  assert.doesNotMatch(row, /closed issue/);
});

// A project's page shows the Overview's tiles with its own numbers.
const projectStats = (html, name) => {
  const pageHtml = html.slice(html.indexOf(`id="project-${name}"`));
  return pageHtml.slice(pageHtml.indexOf('class="stats"'), pageHtml.indexOf('class="details-grid'));
};

test('project page shows its own open, closed and task tiles', async () => {
  const a = { ...v3('a', 4, 120), owner_tasks: [{ title: 'Approve', url: 'https://github.com/o/a/issues/1' }] };
  const html = await page([a, v3('b', 1, 7)]);
  const stats = projectStats(html, 'a');
  assert.match(stats, tile(4, 'open issues'));
  assert.match(stats, tile(120, 'closed issues'));
  assert.match(stats, tile(1, 'your task'));
  assert.match(projectStats(html, 'b'), tile(0, 'your tasks'));
});

test('project page hides the tiles its status file does not report', async () => {
  const html = await page([v3('a', 2, null), { ...v2('c', 3), open_issues: null }]);
  const a = projectStats(html, 'a');
  assert.match(a, tile(2, 'open issues'));
  assert.doesNotMatch(a, /closed issue/);
  const c = projectStats(html, 'c');
  assert.doesNotMatch(c, /open issue|closed issue/);
  assert.match(c, tile(0, 'your tasks'));
});
