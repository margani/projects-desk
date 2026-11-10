import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weekStart, weekKeys, dayKeys, parseNumstat, bucketCommits, addClosedIssues, githubBuilds,
  cloudflareBuilds, mergeBuilds, stripJsonc, workersFromConfig, githubSlug,
} from '../scripts/lib/activity.mjs';
import { CURRENT_SCHEMA_VERSION, loadStatus, validateStatus } from '../scripts/lib/schema.mjs';
import { renderPage } from '../scripts/lib/render.mjs';
import { compact, duration, median, weeklyBuckets } from '../scripts/lib/activity-render.mjs';
import { applyActivity } from '../scripts/lib/collect.mjs';

test('weeks start on Monday in UTC and run oldest first', () => {
  assert.equal(weekStart('2026-10-12T09:00:00+01:00'), '2026-10-12'); // a Monday
  assert.equal(weekStart('2026-10-11T23:30:00Z'), '2026-10-05'); // Sunday belongs to the week before
  const keys = weekKeys('2026-10-14T10:00:00Z', 3);
  assert.deepEqual(keys, ['2026-09-28', '2026-10-05', '2026-10-12']);
  const days = dayKeys('2026-10-14T10:00:00Z', 2);
  assert.equal(days[0], '2026-10-05', 'starts on the Monday of the first whole week');
  assert.equal(days.at(-1), '2026-10-14', 'ends today');
  assert.equal(days.length, 10);
});

const LOG = [
  '\x1eaaa\x1f2026-10-12T10:00:00+01:00', '', '10\t2\tsrc/app.js', '-\t-\timg/logo.png', '5\t0\tsrc/{old => new}/x.js', '',
  '\x1ebbb\x1f2026-10-13T10:00:00Z', '', '900\t800\tpackage-lock.json', '',
  '\x1eccc\x1f2026-10-06T10:00:00Z', '', '3\t1\tREADME.md', '',
  '\x1eaaa\x1f2026-10-12T10:00:00+01:00', '', '10\t2\tsrc/app.js', '',
].join('\n');

test('numstat: renames resolve to the new path, binaries add no lines', () => {
  const [c] = parseNumstat(LOG);
  assert.equal(c.hash, 'aaa');
  assert.deepEqual(c.files.map((f) => f.path), ['src/app.js', 'img/logo.png', 'src/new/x.js']);
  assert.equal(c.files[1].added, null);
});

test('daily buckets skip lockfile-only commits, dedupe hashes and count closed issues', () => {
  const days = dayKeys('2026-10-14T10:00:00Z', 2);
  const b = bucketCommits(parseNumstat(LOG), days);
  assert.equal(b.length, days.length, 'one bucket per day');
  const at = (d) => b.find((x) => x.date === d);
  // 10:00+01:00 is 09:00 UTC, the same day.
  assert.deepEqual(at('2026-10-12'), { date: '2026-10-12', commits: 1, issues_closed: 0, lines_added: 15, lines_deleted: 2 });
  assert.deepEqual(at('2026-10-06'), { date: '2026-10-06', commits: 1, issues_closed: 0, lines_added: 3, lines_deleted: 1 });
  assert.equal(at('2026-10-13').commits, 0, 'the lockfile-only commit is not work');
  assert.equal(bucketCommits(parseNumstat(LOG), days, ['**/*.md']).find((x) => x.date === '2026-10-06').commits, 0, 'extra excludes apply');
  addClosedIssues(b, ['2026-10-13T08:00:00Z', '2026-10-13T20:00:00Z', '2026-01-01T00:00:00Z']);
  assert.equal(at('2026-10-13').issues_closed, 2);
  assert.equal(b.reduce((n, x) => n + x.issues_closed, 0), 2, 'an issue closed before the range is ignored');
});

test('builds from GitHub and Cloudflare: completed only, durations, outcomes, newest first', () => {
  const gh = githubBuilds([
    { workflowName: 'Deploy', status: 'completed', conclusion: 'success', startedAt: '2026-10-12T10:00:00Z', updatedAt: '2026-10-12T10:01:30Z' },
    { workflowName: 'CI', status: 'in_progress', conclusion: '', startedAt: '2026-10-12T11:00:00Z', updatedAt: '2026-10-12T11:00:10Z' },
    { workflowName: 'Old', status: 'completed', conclusion: 'failure', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z' },
  ], '2026-07-27T00:00:00Z');
  assert.deepEqual(gh, [{ system: 'github', name: 'Deploy', started_at: '2026-10-12T10:00:00Z', duration_s: 90, conclusion: 'success' }]);
  const cf = cloudflareBuilds([
    { status: 'stopped', build_outcome: 'fail', running_on: '2026-10-13T09:00:00.000Z', stopped_on: '2026-10-13T09:02:00.000Z' },
    { status: 'running', build_outcome: null, running_on: '2026-10-13T10:00:00.000Z', stopped_on: null },
  ], 'atlas', '2026-07-27T00:00:00Z');
  assert.deepEqual(cf, [{ system: 'cloudflare', name: 'atlas', started_at: '2026-10-13T09:00:00.000Z', duration_s: 120, conclusion: 'failure' }]);
  assert.deepEqual(mergeBuilds([gh, cf]).map((b) => b.system), ['cloudflare', 'github']);
});

test('wrangler configs: JSONC with URLs and trailing commas, env Workers, TOML', () => {
  const jsonc = `{
    // the Worker
    "name": "site", /* block */ "account_id": "abc",
    "vars": { "URL": "https://example.com/a//b" },
    "env": { "sandbox": {}, "staging": { "name": "site-stage", }, },
  }`;
  assert.equal(JSON.parse(stripJsonc(jsonc)).vars.URL, 'https://example.com/a//b');
  assert.deepEqual(workersFromConfig(jsonc, 'json'), { accountId: 'abc', workers: ['site', 'site-sandbox', 'site-stage'] });
  const toml = 'name = "app"\naccount_id = "xyz"\n\n[env.staging]\nname = "app-staging"\n\n[env.dev]\nroute = "x"\n';
  assert.deepEqual(workersFromConfig(toml, 'toml'), { accountId: 'xyz', workers: ['app', 'app-staging', 'app-dev'] });
  assert.equal(githubSlug('git@github.com:acme-org/atlas.git\n'), 'acme-org/atlas');
  assert.equal(githubSlug('https://github.com/acme-user/ledger'), 'acme-user/ledger');
});

const base = (name, activity) => ({
  schema_version: CURRENT_SCHEMA_VERSION, project: name, repo_url: null,
  urls: { sandbox: null, production: null }, version: { sandbox: null, production: null },
  pending_release: { merged_prs: null, release_pr_url: null }, open_issues: 0, closed_issues: 0,
  owner_tasks: [], next_steps: [], health: 'ok', health_reason: null,
  last_session: '2026-10-12T10:00:00+01:00', summary: null, links: [], activity,
});
const day = (date, commits, issues = 0, added = 0, deleted = 0) => ({ date, commits, issues_closed: issues, lines_added: added, lines_deleted: deleted });
const act = (commits) => ({
  generated_at: '2026-10-13T10:00:00Z',
  days: [day('2026-10-05', 0), day('2026-10-06', commits, 2, 1500, 20), day('2026-10-07', 0), day('2026-10-08', 0),
    day('2026-10-09', 0), day('2026-10-10', 0), day('2026-10-11', 0), day('2026-10-12', 1, 0, 5, 5), day('2026-10-13', 0)],
  builds: [{ system: 'cloudflare', name: 'w', started_at: '2026-10-12T09:00:00Z', duration_s: 95, conclusion: 'success' },
    { system: 'github', name: 'CI', started_at: '2026-10-11T09:00:00Z', duration_s: 30, conclusion: 'failure' }],
});

test('schema v5: daily activity validates, may be null, and catches bad days and builds', () => {
  assert.deepEqual(validateStatus(base('a', act(3)), 'a'), []);
  assert.deepEqual(validateStatus(base('a', null), 'a'), []);
  const bad = act(3);
  bad.days[0].date = '6 Oct';
  bad.builds[0].conclusion = 'green';
  bad.builds[1].duration_s = -1;
  bad.extra = 1;
  const problems = validateStatus(base('a', bad), 'a').join('\n');
  assert.match(problems, /activity\.days\[0\]\.date" must be a date/);
  assert.match(problems, /activity\.builds\[0\]\.conclusion/);
  assert.match(problems, /activity\.builds\[1\]\.duration_s/);
  assert.match(problems, /Unknown field "activity\.extra"/);
  const v3 = base('a', null); delete v3.activity; v3.schema_version = 3;
  const r = loadStatus('a', JSON.stringify(v3));
  assert.equal(r.ok, true);
  assert.equal(r.outdated, true);
});

const render = (entries) => renderPage(entries, { css: '', js: '', now: Date.parse('2026-10-13T12:00:00Z'), version: 'v' });

test('activity section: hidden until a project reports, then totals, pulse, builds and table', () => {
  const quiet = loadStatus('quiet', JSON.stringify(base('quiet', null)));
  assert.doesNotMatch(render([quiet]), /id="activity-heading"/);

  const html = render([loadStatus('a<b', JSON.stringify(base('a<b', act(3)))), loadStatus('c', JSON.stringify(base('c', act(7)))), quiet]);
  assert.match(html, /id="activity-heading"/);
  assert.match(html, /<span class="kpi-value">12<\/span>/, '3 + 1 + 7 + 1 commits');
  assert.match(html, /<span class="kpi-value">4<\/span>/, 'issues closed');
  // The tiles sit on top of Activity, not on the Overview.
  const overview = html.slice(html.indexOf('data-view="overview"'), html.indexOf('data-view="activity"'));
  const activity = html.slice(html.indexOf('data-view="activity"'), html.indexOf('data-view="builds"'));
  assert.doesNotMatch(overview, /kpi-heading/);
  assert.ok(activity.indexOf('id="kpi-heading"') >= 0 && activity.indexOf('id="kpi-heading"') < activity.indexOf('id="activity-heading"'));
  assert.doesNotMatch(activity, /href="#\/activity">Activity →/);
  assert.match(html, /Not reporting yet: quiet/);
  assert.match(html, /a&lt;b · week of 5 Oct/, 'cell tooltips escape the project name');
  assert.doesNotMatch(html, /a<b/);
  const cells = html.match(/class="cell" data-commits/g) ?? [];
  assert.ok(cells.length >= 4, `heatmap cells rendered (${cells.length})`);
  assert.match(html, /class="run run-cloudflare run-success"/);
  assert.match(html, /<th scope="row">All projects<\/th><td>12<\/td><td>4<\/td><td>\+3,010<\/td>/);
  assert.match(html, /Activity · 2 weeks/, 'project row has its own activity line');
});

test('number and duration formatting', () => {
  assert.deepEqual([compact(999), compact(1234), compact(12345), compact(2_500_000)], ['999', '1.2K', '12K', '2.5M']);
  assert.deepEqual([duration(42), duration(60), duration(95), duration(3725)], ['42s', '1m', '1m\u00a035s', '1h\u00a02m']);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([]), null);
});

const v4act = {
  generated_at: '2026-10-13T10:00:00Z',
  weeks: [{ week: '2026-10-05', commits: 4, issues_closed: 1, lines_added: 10, lines_deleted: 2 }],
  builds: [],
};

test('v4 files (weekly activity) still validate and render, with a sparkline instead of a calendar', () => {
  const v4 = { ...base('old', v4act), schema_version: 4 };
  assert.deepEqual(validateStatus(v4, 'old'), []);
  assert.match(validateStatus({ ...v4, activity: act(1) }, 'old').join('\n'), /Unknown field "activity\.days"/, 'v4 keeps its weekly shape');
  const html = render([loadStatus('old', JSON.stringify(v4))]);
  assert.match(html, /<span class="kpi-value">4<\/span>/);
  assert.doesNotMatch(html, /class="calendar"/);
  assert.match(html, /class="spark"/);
});

test('daily data: weekly overview sums days, the row gets a calendar, the tile names the busiest day', () => {
  const html = render([loadStatus('c', JSON.stringify(base('c', act(7))))]);
  assert.match(html, /class="calendar" style="--weeks:2"/);
  assert.match(html, /title="Tue 6 Oct\n7 commits · 2 issues closed\n\+1500 −20 lines"/);
  assert.match(html, /busiest Tue 6 Oct · 7/);
  assert.match(html, /active 2 of 9 days/);
  const weekly = weeklyBuckets(act(7));
  assert.equal(weekly.get('2026-10-05').commits, 7);
  assert.equal(weekly.get('2026-10-12').lines_added, 5);
});

test('applyActivity: v3 and v4 move to the current version, v1 and v2 are left to their session', () => {
  const a = act(1);
  const v3 = { schema_version: 3 };
  assert.equal(applyActivity(v3, a, CURRENT_SCHEMA_VERSION), true);
  assert.equal(v3.schema_version, CURRENT_SCHEMA_VERSION);
  assert.equal(v3.activity, a);
  const v2 = { schema_version: 2 };
  assert.equal(applyActivity(v2, a, CURRENT_SCHEMA_VERSION), false);
  assert.deepEqual(v2, { schema_version: 2 });
});

// A project busy 8 weeks ago and quiet since, and one busy only this week: the
// 12-week view ranks the old one first, the 4-week view the recent one.
const old = { generated_at: '2026-10-13T10:00:00Z', days: [day('2026-08-20', 30)], builds: [{ system: 'github', name: 'CI', started_at: '2026-08-20T09:00:00Z', duration_s: 40, conclusion: 'success' }] };
const recent = { generated_at: '2026-10-13T10:00:00Z', days: [day('2026-10-12', 5)], builds: [{ system: 'github', name: 'CI', started_at: '2026-10-12T09:00:00Z', duration_s: 50, conclusion: 'success' }] };

test('range switch: 4 weeks by day and 12 weeks by week, on Activity and Builds', () => {
  const html = render([loadStatus('old', JSON.stringify(base('old', old))), loadStatus('recent', JSON.stringify(base('recent', recent)))]);
  // The heading carries small per-range labels too; the charts come after it.
  const pane = (view, range) => {
    // The range heading, not the "Last 12 weeks" tiles above it on Activity.
    const from = view.slice(view.indexOf('</h2>', view.indexOf('class="range-head"')));
    const at = from.indexOf(`class="range-pane" data-range="${range}"`);
    assert.ok(at >= 0, `pane ${range}`);
    return from.slice(at, from.indexOf('class="range-pane"', at + 1) === -1 ? undefined : from.indexOf('class="range-pane"', at + 1));
  };
  const activity = html.slice(html.indexOf('data-view="activity"'), html.indexOf('data-view="builds"'));
  const builds = html.slice(html.indexOf('data-view="builds"'));
  for (const [v, name] of [[activity, 'activity'], [builds, 'builds']]) {
    assert.match(v, new RegExp(`name="range-${name}" value="4w"`));
    assert.match(v, new RegExp(`name="range-${name}" value="12w" checked`), '12 weeks stays the default');
  }

  const order = (p) => [...p.matchAll(/class="pulse-name" href="#\/p\/([^"]+)"/g)].map((m) => m[1]);
  const twelve = pane(activity, '12w');
  const four = pane(activity, '4w');
  assert.deepEqual(order(twelve), ['old', 'recent']);
  assert.deepEqual(order(four), ['recent', 'old'], 'August is outside 4 weeks');
  assert.match(twelve, /style="--weeks:12"/);
  assert.match(four, /style="--weeks:28"/, 'one cell per day');
  assert.match(four, /recent · Mon 12 Oct\n5 commits/);
  assert.match(activity, /4 weeks since 16 Sep, by day/);

  assert.match(pane(builds, '12w'), /href="#\/p\/old"/);
  assert.doesNotMatch(pane(builds, '4w'), /href="#\/p\/old"/, 'the August run is outside 4 weeks');
  assert.match(pane(builds, '4w'), /href="#\/p\/recent"/);
});
