// Schema v2: each project lists its own extra links as [{label, url}].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION, loadStatus, validateStatus } from '../scripts/lib/schema.mjs';
import { build } from '../scripts/build.mjs';

const v1 = () => ({
  schema_version: 1,
  project: 'demo',
  repo_url: 'https://github.com/o/demo',
  urls: { sandbox: null, production: 'https://demo.example.com' },
  version: { sandbox: null, production: '1.0.0' },
  pending_release: { merged_prs: null, release_pr_url: null },
  open_issues: 2,
  owner_tasks: [],
  next_steps: [],
  health: 'ok',
  health_reason: null,
  last_session: '2026-10-06T21:30:00+01:00',
  summary: null,
});

const v2 = () => ({
  ...v1(),
  schema_version: 2,
  links: [
    { label: 'Worker', url: 'https://dash.cloudflare.com/abc/workers/services/view/demo/production' },
    { label: 'F-Droid', url: 'https://f-droid.org/packages/org.example.demo/' },
  ],
});

test('v2 with links is valid', () => {
  assert.deepEqual(validateStatus(v2(), 'demo'), []);
  assert.deepEqual(validateStatus({ ...v2(), links: [] }, 'demo'), []);
});

test('v2 requires links and checks each entry', () => {
  const missing = v2(); delete missing.links;
  assert.ok(validateStatus(missing, 'demo').includes('Missing field "links".'));

  const p = validateStatus({ ...v2(), links: [
    { label: '', url: 'https://example.com' },
    { label: 'Bad', url: 'javascript:alert(1)' },
    { label: 'Extra', url: 'https://example.com', icon: 'x' },
    { url: 'https://example.com' },
  ] }, 'demo');
  assert.ok(p.some((x) => x.includes('"links[0].label" must be a non-empty string')), p.join('\n'));
  assert.ok(p.some((x) => x.includes('"links[1].url" must be an http(s) URL')), p.join('\n'));
  assert.ok(p.some((x) => x.includes('Unknown field "links[2].icon"')), p.join('\n'));
  assert.ok(p.some((x) => x.includes('Missing field "links[3].label"')), p.join('\n'));

  const tooMany = Array.from({ length: 11 }, (_, i) => ({ label: `L${i}`, url: `https://example.com/${i}` }));
  assert.ok(validateStatus({ ...v2(), links: tooMany }, 'demo').some((x) => x.includes('maximum is 10')));
  assert.ok(validateStatus({ ...v2(), links: null }, 'demo').some((x) => x.includes('"links" must be an array')));
});

test('v1 files still load while projects migrate, marked outdated', () => {
  const r = loadStatus('demo', JSON.stringify(v1()));
  assert.equal(r.ok, true, r.problems?.join('; '));
  assert.equal(r.outdated, true);
  // Since v3, v2 is outdated too; v3 being current is checked in closed.test.mjs.
  assert.equal(loadStatus('demo', JSON.stringify(v2())).outdated, true);
  // v1 never had links: a v1 file that carries it is still an error.
  assert.ok(validateStatus({ ...v1(), links: [] }, 'demo').includes('Unknown field "links".'));
});

test('a newer schema than the dashboard knows is reported', () => {
  assert.match(validateStatus({ ...v2(), schema_version: CURRENT_SCHEMA_VERSION + 1 }, 'demo')[0], new RegExp(`only understands ${CURRENT_SCHEMA_VERSION}`));
});

test('links render as buttons; v1 rows say they need migrating', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-links-'));
  await mkdir(path.join(dir, 'status'));
  await writeFile(path.join(dir, 'status/demo.json'), JSON.stringify({
    ...v2(),
    links: [{ label: 'F-Droid <beta>', url: 'https://f-droid.org/packages/org.example.demo/?a=1&b=2' }],
  }));
  await writeFile(path.join(dir, 'status/old.json'), JSON.stringify({ ...v1(), project: 'old' }));
  const { entries } = await build({ statusDir: path.join(dir, 'status'), outDir: path.join(dir, 'dist'), log: () => {} });
  assert.equal(entries.length, 2);
  const html = await readFile(path.join(dir, 'dist/index.html'), 'utf8');
  assert.ok(html.includes('href="https://f-droid.org/packages/org.example.demo/?a=1&amp;b=2"'), 'link href escaped');
  assert.ok(html.includes('>F-Droid &lt;beta&gt;</a>'), 'label escaped');
  assert.ok(!html.includes('<beta>'));
  const old = html.slice(html.indexOf('id="project-old"'));
  assert.ok(old.includes('schema v1'), 'v1 row mentions its schema');
  assert.ok(!html.slice(html.indexOf('id="project-demo"'), html.indexOf('id="project-old"')).includes('schema v1'));
});
