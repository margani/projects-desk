import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION, loadStatus, validateStatus } from '../scripts/lib/schema.mjs';
import { linkRefs, relativeTime, sortEntries } from '../scripts/lib/render.mjs';
import { build } from '../scripts/build.mjs';
import { checkStatusDir } from '../scripts/check-status.mjs';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const valid = () => ({
  schema_version: 1,
  project: 'demo',
  repo_url: 'https://github.com/o/demo',
  urls: { sandbox: null, production: 'https://demo.example.com' },
  version: { sandbox: null, production: '1.0.0' },
  pending_release: { merged_prs: null, release_pr_url: null },
  open_issues: 2,
  owner_tasks: [{ title: 'Do <b>it</b>', url: 'https://github.com/o/demo/issues/4' }],
  next_steps: ['Ship it'],
  health: 'ok',
  health_reason: null,
  last_session: '2026-10-06T21:30:00+01:00',
  summary: 'Did things.',
});

test('an invalid status file is reported, not a failure', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-check-'));
  await writeFile(path.join(dir, 'demo.json'), JSON.stringify(valid()));
  await writeFile(path.join(dir, 'busy.json'), JSON.stringify({ ...valid(), project: 'busy', next_steps: Array.from({ length: 11 }, (_, i) => `step ${i + 1}`) }));
  const { checked, invalid } = await checkStatusDir(dir);
  assert.equal(checked, 2);
  assert.deepEqual(invalid.map((x) => x.file), ['busy.json']);
  assert.match(invalid[0].problems[0], /maximum is 10/);
  const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../scripts/check-status.mjs'), dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /::warning file=status\/busy\.json::/);
  assert.match(run.stdout, /Checked 2 status files, 1 invalid\./);
});

test('valid object passes', () => assert.deepEqual(validateStatus(valid(), 'demo'), []));

// Since each project has its own page, it may list up to 10 next steps.
test('next_steps allows 10 items and refuses 11', () => {
  const steps = (n) => Array.from({ length: n }, (_, i) => `step ${i + 1}`);
  assert.deepEqual(validateStatus({ ...valid(), next_steps: steps(10) }, 'demo'), []);
  assert.deepEqual(validateStatus({ ...valid(), next_steps: steps(11) }, 'demo'),
    ['"next_steps" has 11 items; the maximum is 10.']);
});

test('unparseable JSON is reported, not thrown', () => {
  const r = loadStatus('demo', '{ "schema_version": 1, ');
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /Not valid JSON/);
});

test('unversioned and old schema are reported as needing migration', () => {
  const v0 = valid(); delete v0.schema_version;
  assert.match(validateStatus(v0, 'demo')[0], /unversioned \(v0\)/);
  assert.match(validateStatus({ ...valid(), schema_version: 0 }, 'demo')[0], /Old schema/);
  assert.match(validateStatus({ ...valid(), schema_version: CURRENT_SCHEMA_VERSION + 1 }, 'demo')[0], new RegExp(`only understands ${CURRENT_SCHEMA_VERSION}`));
});

test('field-level problems are specific', () => {
  const d = valid();
  d.health = 'blocked';
  d.owner_tasks = [{ title: 'x', url: 'javascript:alert(1)' }];
  d.next_steps = Array.from({ length: 11 }, (_, i) => `step ${i + 1}`);
  d.extra = 1;
  delete d.summary;
  d.project = 'other';
  const p = validateStatus(d, 'demo');
  assert.ok(p.some((x) => x.includes('"health_reason" is required when health is "blocked"')));
  assert.ok(p.some((x) => x.includes('"owner_tasks[0].url" must be an http(s) URL')));
  assert.ok(p.some((x) => x.includes('maximum is 10')));
  assert.ok(p.some((x) => x.includes('Unknown field "extra"')));
  assert.ok(p.some((x) => x.includes('Missing field "summary"')));
  assert.ok(p.some((x) => x.includes('file is named "demo.json"')));
});

test('sort: invalid, blocked, attention, ok; recent first within health', () => {
  const mk = (name, health, last) => ({ name, ok: true, data: { ...valid(), project: name, health, last_session: last } });
  const sorted = sortEntries([
    mk('a', 'ok', '2026-10-01T00:00:00Z'),
    mk('b', 'attention', '2026-09-01T00:00:00Z'),
    mk('c', 'attention', '2026-10-01T00:00:00Z'),
    { name: 'z', ok: false, problems: ['x'] },
    mk('d', 'blocked', '2026-01-01T00:00:00Z'),
  ]).map((x) => x.name);
  assert.deepEqual(sorted, ['z', 'd', 'c', 'b', 'a']);
});

test('relative time', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.equal(relativeTime('2026-10-06T12:00:00Z', now), '2 days ago');
  assert.equal(relativeTime('2026-10-08T11:59:30Z', now), '30 seconds ago');
});

test('build survives broken files, escapes HTML, hides nulls', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-'));
  // Only the files written here: the real status folder is other sessions'
  // data and must not decide whether this test passes.
  const status = path.join(dir, 'status');
  await mkdir(status);
  await writeFile(path.join(status, 'demo.json'), JSON.stringify(valid()));
  await writeFile(path.join(status, 'broken.json'), '{ nope');
  await writeFile(path.join(status, 'legacy.json'), JSON.stringify({ project: 'legacy', version: '1.0' }));
  const { entries } = await build({ statusDir: status, outDir: path.join(dir, 'dist'), log: () => {} });
  assert.equal(entries.filter((x) => !x.ok).length, 2);
  const html = await readFile(path.join(dir, 'dist/index.html'), 'utf8');
  assert.ok(html.includes('Do &lt;b&gt;it&lt;/b&gt;'));
  assert.ok(!html.includes('<b>it</b>'));
  assert.ok(!/>\s*null\s*</.test(html), 'no literal null rendered');
  assert.ok(html.includes('status/broken.json could not be shown'));
  assert.ok(html.includes('unversioned (v0)'));
  assert.ok(html.includes('id="project-demo"'), 'new file picked up without code change');
  // One theme button in the app bar, Light and Dark only.
  const bar = html.slice(html.indexOf('<header class="app-bar">'), html.indexOf('</header>'));
  assert.ok(bar.includes('class="theme-toggle"'), 'theme button sits in the app bar');
  const icons = [...bar.matchAll(/data-icon="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(icons, ['light', 'dark']);
});

test('version id: in the page and version.json, stable on rebuild, changes with content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-ver-'));
  const status = path.join(dir, 'status');
  const out = path.join(dir, 'dist');
  await cp(path.resolve(import.meta.dirname, '../status'), status, { recursive: true });
  const first = await build({ statusDir: status, outDir: out, now: Date.parse('2026-10-07T08:00:00Z'), log: () => {} });
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  const file = JSON.parse(await readFile(path.join(out, 'version.json'), 'utf8'));
  assert.match(first.version, /^[0-9a-f]{16}$/);
  assert.equal(file.version, first.version);
  assert.ok(html.includes(`<meta name="dashboard-version" content="${first.version}">`));

  const again = await build({ statusDir: status, outDir: out, now: Date.parse('2026-10-08T08:00:00Z'), log: () => {} });
  assert.equal(again.version, first.version, 'same content at a later time keeps the id');

  await writeFile(path.join(status, 'demo.json'), JSON.stringify(valid()));
  const changed = await build({ statusDir: status, outDir: out, log: () => {} });
  assert.notEqual(changed.version, first.version, 'new status content changes the id');
});

test('linkRefs: #N and owner/repo#N become GitHub links, everything else is escaped', () => {
  const repo = 'https://github.com/acme-org/nova-internal';
  assert.equal(
    linkRefs('Fix (#485) & <b>, see acme-org/ops#79', repo),
    'Fix (<a href="https://github.com/acme-org/nova-internal/issues/485" target="_blank" rel="noopener noreferrer">#485</a>) &amp; &lt;b&gt;, see '
      + '<a href="https://github.com/acme-org/ops/issues/79" target="_blank" rel="noopener noreferrer">acme-org/ops#79</a>',
  );
  const range = linkRefs('PRs #1-#5', repo);
  assert.equal((range.match(/<a /g) ?? []).length, 2);
  assert.match(range, /issues\/1"/);
  assert.match(range, /issues\/5"/);
  // An apostrophe escapes to &#39; and must not turn into issue 39; no repo means no link.
  assert.equal(linkRefs("owner's #7", null), 'owner&#39;s #7');
  assert.equal(linkRefs('color #fff, a1#2, ##3', repo), 'color #fff, a1#2, ##3');
});
