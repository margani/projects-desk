// Totals row: open issues, closed issues, the owner's tasks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from '../scripts/build.mjs';

const status = (project, open_issues, tasks = 0) => ({
  schema_version: 2,
  project,
  repo_url: `https://github.com/o/${project}`,
  urls: { sandbox: null, production: null },
  version: { sandbox: null, production: '1.0.0' },
  pending_release: { merged_prs: null, release_pr_url: null },
  open_issues,
  owner_tasks: Array.from({ length: tasks }, (_, i) => ({ title: `t${i}`, url: `https://github.com/o/${project}/issues/${i + 1}` })),
  next_steps: [],
  health: 'ok',
  health_reason: null,
  last_session: '2026-10-09T08:00:00+01:00',
  summary: null,
  links: [],
});

async function pageFor(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-total-'));
  await mkdir(path.join(dir, 'status'));
  for (const s of files) await writeFile(path.join(dir, 'status', `${s.project}.json`), JSON.stringify(s));
  await build({ statusDir: path.join(dir, 'status'), outDir: path.join(dir, 'dist'), log: () => {} });
  return readFile(path.join(dir, 'dist/index.html'), 'utf8');
}

async function headerFor(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-total-'));
  await mkdir(path.join(dir, 'status'));
  for (const s of files) await writeFile(path.join(dir, 'status', `${s.project}.json`), JSON.stringify(s));
  const { entries } = await build({ statusDir: path.join(dir, 'status'), outDir: path.join(dir, 'dist'), log: () => {} });
  assert.equal(entries.length, files.length);
  const html = await readFile(path.join(dir, 'dist/index.html'), 'utf8');
  return html.slice(html.indexOf('class="stats"'), html.indexOf('id="tasks-heading"'));
}

const tile = (value, label) => new RegExp(`<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`);

test('stats row sums open issues (null left out) and the owner tasks', async () => {
  const row = await headerFor([status('a', 3, 2), status('b', 4, 1), status('c', null)]);
  assert.match(row, tile(7, 'open issues'));
  assert.match(row, tile(3, 'your tasks'));
  assert.doesNotMatch(row, /closed issue/, 'no closed tile while no project reports it');
});

test('singular labels, and zero still shows', async () => {
  const one = await headerFor([status('a', 1, 1)]);
  assert.match(one, tile(1, 'open issue'));
  assert.match(one, tile(1, 'your task'));
  assert.match(await headerFor([status('a', 0)]), tile(0, 'open issues'));
});

test('header pills are only health counts now', async () => {
  const html = await pageFor([status('a', 3)]);
  const start = html.indexOf('class="overview"');
  const pills = html.slice(start, html.indexOf('</p>', start));
  assert.match(pills, /1 fine/, 'health pill still there');
  assert.doesNotMatch(pills, /open issue/);
});
