import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { summarise, collectAccount } from '../scripts/lib/github-usage.mjs';
import { renderUsage, renderUsageAlert, level } from '../scripts/lib/usage-render.mjs';
import { build } from '../scripts/build.mjs';

// The shape GitHub's billing usage summary returned for acme-org on 2026-10-18.
const items = [
  { product: 'Actions', sku: 'actions_linux', unitType: 'minutes', grossQuantity: 1489, netAmount: 0 },
  { product: 'Actions', sku: 'actions_macos', unitType: 'minutes', grossQuantity: 36, netAmount: 0 },
  { product: 'Actions', sku: 'actions_storage', unitType: 'gigabyte-hours', grossQuantity: 36, netAmount: 0 },
  { product: 'Actions', sku: 'actions_windows', unitType: 'minutes', grossQuantity: 437, netAmount: 1.25 },
];
// 18 Oct 00:00 UTC: 17 days (408 hours) into a 31-day month.
const now = Date.parse('2026-10-18T00:00:00Z');

test('usage: minutes per OS, average storage, billed amount and plan quota', () => {
  const s = summarise(items, { plan: 'team', now });
  assert.deepEqual(s.minutes, { linux: 1489, windows: 437, macos: 36, other: 0, total: 1962, public: 0, counted: 2589, included: 3000 });
  assert.equal(s.storage.gb, Math.round((36 / 408) * 1000) / 1000);
  assert.equal(s.storage.included_gb, 2);
  assert.equal(s.billed_usd, 1.25);
  const unknown = summarise([], { plan: 'someday', now });
  assert.equal(unknown.minutes.included, null);
  assert.equal(unknown.minutes.total, 0);
});

test('usage: a gh scope error becomes a one-line problem, not a crash', async () => {
  const api = async () => {
    const err = new Error('gh failed');
    err.stderr = 'gh: This API operation needs the "user" scope. To request it, run:  gh auth refresh -h github.com -s user';
    throw err;
  };
  const a = await collectAccount({ login: 'someone', kind: 'user' }, { now, api });
  assert.equal(a.minutes, null);
  assert.match(a.problem, /needs the "user" scope/);
  const ok = await collectAccount({ login: 'Org', kind: 'org' }, { now, api: async ([p]) => (p.startsWith('orgs/') ? { plan: { name: 'free' } } : { usageItems: items }) });
  assert.equal(ok.plan, 'free');
  assert.equal(ok.minutes.included, 2000);
  assert.equal(ok.problem, null);
});

const account = (login, minutes, extra = {}) => ({
  login, kind: 'org', plan: 'free', problem: null, billed_usd: 0,
  minutes: { linux: minutes, windows: 0, macos: 0, other: 0, total: minutes, included: 2000 },
  storage: { gb: 0.01, included_gb: 0.5 },
  ...extra,
});
const usage = (accounts) => ({ generated_at: '2026-10-18T00:00:00Z', period: '2026-10', accounts });

test('usage: levels, flags and the Overview line only when something is close', () => {
  assert.equal(level(1000, 2000), 'ok');
  assert.equal(level(1600, 2000), 'near');
  assert.equal(level(2000, 2000), 'over');
  assert.equal(level(5, null), null);

  // 400 minutes after 17 of 31 days is on pace for ~730: nothing to say.
  const calm = usage([account('Calm', 400)]);
  assert.equal(renderUsageAlert(calm, now), '');
  const html = renderUsage(calm, now);
  assert.ok(html.includes('GitHub usage <span class="muted">· October'));
  assert.ok(html.includes('400 of 2,000'));
  assert.ok(html.includes('Nothing billed this month'));
  assert.ok(!html.includes('meter-flag'));

  // 1,200 after 17 days is on pace for ~2,190 of 2,000.
  const pacing = usage([account('Pacing', 1200)]);
  assert.match(renderUsageAlert(pacing, now), /Pacing: on pace for 2,188 of 2,000 Actions minutes/);
  assert.ok(renderUsage(pacing, now).includes('On pace to pass the plan'));

  const over = usage([account('Over', 2100, { billed_usd: 0.6 }), { login: 'me', kind: 'user', problem: 'needs scope', plan: null, minutes: null, storage: null, billed_usd: null }]);
  const alert = renderUsageAlert(over, now);
  assert.match(alert, /Over: 2,100 of 2,000 Actions minutes/);
  assert.match(alert, /Over: \$0\.60 billed/);
  assert.ok(!alert.includes('me:'), 'an unreadable account is shown on Builds, not nagged about');
  const page = renderUsage(over, now);
  assert.ok(page.includes('data-level="over"'));
  assert.ok(page.includes('Over the plan'));
  assert.ok(page.includes('$0.60 this month'));
  assert.ok(page.includes('needs scope'));
});

test('usage: the build shows it on Builds and survives a missing or broken file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-usage-'));
  await mkdir(path.join(dir, 'status'));
  const file = path.join(dir, 'github.json');
  const run = async (name) => {
    await build({ statusDir: path.join(dir, 'status'), usageFile: file, outDir: path.join(dir, name), log: () => {} });
    return readFile(path.join(dir, name, 'index.html'), 'utf8');
  };
  assert.ok(!(await run('missing')).includes('class="panel usage"'));
  await writeFile(file, '{ nope');
  assert.ok(!(await run('broken')).includes('class="panel usage"'));
  await writeFile(file, JSON.stringify(usage([account('Over', 2100)])));
  const html = await run('ok');
  const builds = html.slice(html.indexOf('data-view="builds"'));
  assert.ok(builds.includes('class="panel usage"'), 'usage sits in the Builds view');
  const overview = html.slice(html.indexOf('data-view="overview"'), html.indexOf('data-view="activity"'));
  assert.ok(overview.includes('class="usage-alert" href="#/builds"'));
});

// The detailed report's shape (what the collector now reads), as GitHub
// returned it for acme-org on 2026-10-18: one item per day, SKU and repository.
const detailed = [
  { date: '2026-10-01T00:00:00Z', product: 'actions', sku: 'Actions Linux', unitType: 'Minutes', quantity: 700, netAmount: 0, repositoryName: 'nova-internal' },
  { date: '2026-10-02T00:00:00Z', product: 'actions', sku: 'Actions Linux', unitType: 'Minutes', quantity: 480, netAmount: 0, repositoryName: 'nova-internal' },
  { date: '2026-10-02T00:00:00Z', product: 'actions', sku: 'Actions Windows', unitType: 'Minutes', quantity: 400, netAmount: 0, repositoryName: 'ops' },
  { date: '2026-10-03T00:00:00Z', product: 'actions', sku: 'Actions macOS 3-core', unitType: 'Minutes', quantity: 36, netAmount: 0, repositoryName: 'quill' },
  { date: '2026-10-03T00:00:00Z', product: 'actions', sku: 'Actions storage', unitType: 'GigabyteHours', quantity: 36, netAmount: 0, repositoryName: 'pixelworks' },
];

test('usage: the detailed report gives minutes per repository, biggest first', () => {
  const s = summarise(detailed, { plan: 'team', now });
  assert.deepEqual(s.minutes, { linux: 1180, windows: 400, macos: 36, other: 0, total: 1616, public: 0, counted: 2219, included: 3000 });
  assert.deepEqual(s.repos, [{ name: 'nova-internal', minutes: 1180, public: false }, { name: 'ops', minutes: 400, public: false }, { name: 'quill', minutes: 36, public: false }]);
  assert.equal(s.storage.gb, Math.round((36 / 408) * 1000) / 1000, 'storage is not counted as minutes');
  assert.equal(s.repos.reduce((n, r) => n + r.minutes, 0), s.minutes.total);
});

test('usage: each repository links to its project page when a status file names it', () => {
  const a = { ...account('beta-org', 1000), repos: [{ name: 'orion', minutes: 990 }, { name: 'stray', minutes: 10 }] };
  const sorted = [{ ok: true, data: { project: 'orion', repo_url: 'https://github.com/Beta-Org/orion' } }];
  const html = renderUsage(usage([a]), now, sorted);
  assert.ok(html.includes('Minutes by repository'));
  assert.match(html, /<a href="#\/p\/orion">orion<\/a>/, 'owner case differs between status file and GitHub');
  assert.match(html, /<span class="repo-name">stray<\/span>/, 'a repository without a status file is plain text');
  assert.ok(html.includes('>990<') && html.includes('>10<'));
  assert.ok(!renderUsage(usage([account('NoRepos', 5)]), now).includes('Minutes by repository'));
});

test('usage: public repositories run free and do not count against the plan', async () => {
  const visibility = new Map([['ops', 'public'], ['nova-internal', 'private']]);
  const s = summarise(detailed, { plan: 'team', now, visibility });
  assert.equal(s.minutes.total, 1180 + 36, 'ops (public) is left out; quill (unknown) still counts');
  assert.equal(s.minutes.public, 400);
  assert.equal(s.minutes.windows, 0, 'the Windows minutes were all in the public repo');
  assert.deepEqual(s.repos.map((r) => [r.name, r.public]), [['nova-internal', false], ['ops', true], ['quill', false]]);

  // The collector asks each repository's visibility; one it cannot read stays counted.
  const api = async ([p]) => {
    if (p === 'orgs/Org') return { plan: { name: 'team' } };
    if (p.includes('/settings/billing/usage')) return { usageItems: detailed };
    if (p === 'repos/Org/ops') return { visibility: 'public' };
    if (p === 'repos/Org/quill') throw new Error('HTTP 404');
    return { visibility: 'private' };
  };
  const a = await collectAccount({ login: 'Org', kind: 'org' }, { now, api });
  assert.equal(a.minutes.total, 1216);
  assert.equal(a.minutes.public, 400);

  const html = renderUsage(usage([a]), now);
  assert.ok(html.includes('1,552 of 3,000'), "quill's 36 macOS minutes count as 372");
  assert.ok(html.includes('400 more free in public repos'));
  assert.match(html, /<li class="repo-public"><span class="repo-name">ops <span class="repo-free">public<\/span>/);
});

// acme-org's private minutes on 2026-10-20, with the prices the detailed report
// carries. GitHub emailed that day that 90% (2,700 of 3,000) was used, while
// the meter, adding raw minutes, said 1,977.
const weighted = [
  { product: 'actions', sku: 'Actions Linux', unitType: 'Minutes', quantity: 1805, pricePerUnit: 0.006, netAmount: 0, repositoryName: 'nova-internal' },
  { product: 'actions', sku: 'Actions Windows', unitType: 'Minutes', quantity: 93, pricePerUnit: 0.01, netAmount: 0, repositoryName: 'quill' },
  { product: 'actions', sku: 'Actions macOS 3-core', unitType: 'Minutes', quantity: 79, pricePerUnit: 0.062, netAmount: 0, repositoryName: 'quill' },
  { product: 'actions', sku: 'Actions Windows', unitType: 'Minutes', quantity: 429, pricePerUnit: 0.01, netAmount: 0, repositoryName: 'ops' },
];

test('usage: Windows and macOS minutes count at their price in Linux minutes', () => {
  const visibility = new Map([['ops', 'public']]);
  const s = summarise(weighted, { plan: 'team', now: Date.parse('2026-10-20T10:00:00Z'), visibility });
  assert.equal(s.minutes.total, 1977, 'raw private minutes');
  assert.equal(s.minutes.counted, 2776, '1,805 + 93 × 0.010/0.006 + 79 × 0.062/0.006');
  assert.ok(s.minutes.counted / s.minutes.included >= 0.9, 'past the 90% GitHub emailed about');

  // Without a price (the summary shape) the documented rates apply.
  const bare = summarise([{ product: 'Actions', sku: 'actions_macos', unitType: 'minutes', grossQuantity: 6 }], { plan: 'team', now });
  assert.equal(bare.minutes.counted, 62);

  const html = renderUsage(usage([{ login: 'acme-org', kind: 'org', ...s }]), Date.parse('2026-10-20T10:00:00Z'));
  assert.ok(html.includes('2,776 of 3,000'), 'the meter shows the counted figure');
  assert.match(html, /data-level="near"/);
  assert.ok(html.includes('1,977 raw minutes'));
  assert.match(renderUsageAlert(usage([{ login: 'acme-org', kind: 'org', ...s }]), Date.parse('2026-10-20T10:00:00Z')), /acme-org: 2,776 of 3,000 Actions minutes/);
});

test('usage: Minutes by repository is open for an account with many repositories', () => {
  const repos = Array.from({ length: 8 }, (_, i) => ({ name: `repo${i}`, minutes: 80 - i * 10, public: i > 0 }));
  const html = renderUsage(usage([{ ...account('acme-user', 95), repos }]), now, []);
  assert.match(html, /<details class="repo-usage" open>\s*<summary>Minutes by repository · 8<\/summary>/);
  assert.equal((html.match(/<li/g) ?? []).length, 8);
});
