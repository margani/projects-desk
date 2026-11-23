import test from 'node:test';
import assert from 'node:assert/strict';
import { repoSlug, readRepo, collectIssues, applyIssues, checkIssues } from '../scripts/lib/issues.mjs';
import { renderSite } from '../scripts/lib/site.mjs';

const status = (project, extra = {}) => JSON.stringify({
  schema_version: 5, project, repo_url: `https://github.com/acme/${project}`, health: 'ok', health_reason: 'fine',
  open_issues: 0, closed_issues: 1, owner_tasks: [], next_steps: [], urls: { production: null, sandbox: null },
  version: { production: null, sandbox: null }, pending_release: { merged_prs: 0, release_pr_url: null }, last_session: '2026-11-23T10:00:00+00:00', summary: 's', links: [], activity: null, ...extra,
});

const fakeGh = (counts) => async (args) => {
  if (args[0] === 'api') {
    const repo = args.find((a) => a.startsWith('n=')).slice(2);
    if (!counts[repo]) throw new Error('HTTP 404');
    return JSON.stringify({ data: { repository: { open: { totalCount: counts[repo].open }, closed: { totalCount: counts[repo].closed } } } });
  }
  const repo = args[args.indexOf('-R') + 1].split('/')[1];
  return JSON.stringify(counts[repo].mine ?? []);
};

test('repoSlug reads github https urls only', () => {
  assert.equal(repoSlug('https://github.com/acme/app'), 'acme/app');
  assert.equal(repoSlug('https://github.com/acme/app.git'), 'acme/app');
  assert.equal(repoSlug('https://example.com/acme/app'), null);
  assert.equal(repoSlug(null), null);
});

test('readRepo returns counts and the owner tasks', async () => {
  const gh = fakeGh({ app: { open: 3, closed: 25, mine: [{ title: 'Do it', url: 'https://github.com/acme/app/issues/9' }] } });
  assert.deepEqual(await readRepo('acme/app', { ghImpl: gh }), {
    open_issues: 3, closed_issues: 25, owner_tasks: [{ title: 'Do it', url: 'https://github.com/acme/app/issues/9' }],
  });
});

test('collectIssues skips a repo GitHub cannot answer for and says so', async () => {
  const entries = [{ ok: true, data: { project: 'app', repo_url: 'https://github.com/acme/app' } }, { ok: true, data: { project: 'gone', repo_url: 'https://github.com/acme/gone' } }, { ok: true, data: { project: 'norepo', repo_url: null } }];
  const out = await collectIssues(entries, { ghImpl: fakeGh({ app: { open: 1, closed: 2 } }), now: 0 });
  assert.deepEqual(Object.keys(out.projects), ['app']);
  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0], /^gone: /);
});

test('the page shows GitHub numbers over a stale status file, and keeps the file where GitHub is silent', async () => {
  const issues = { projects: { app: { open_issues: 7, closed_issues: 40, owner_tasks: [{ title: 'Approve release', url: 'https://github.com/acme/app/issues/5' }] } } };
  assert.equal(checkIssues(issues), null);
  const rows = [{ name: 'app', text: status('app', { open_issues: 0, closed_issues: 17 }) }, { name: 'other', text: status('other', { open_issues: 4 }) }];
  const { entries, html } = await renderSite({ statusRows: rows, issues, css: '', js: '', now: 0 });
  const app = entries.find((e) => e.name === 'app').data;
  assert.equal(app.open_issues, 7);
  assert.equal(app.closed_issues, 40);
  assert.equal(app.owner_tasks[0].title, 'Approve release');
  assert.equal(entries.find((e) => e.name === 'other').data.open_issues, 4);
  assert.match(html, /Approve release/);
});

test('applyIssues leaves a broken status entry alone and tolerates no data', () => {
  const bad = [{ ok: false, name: 'x', problems: ['bad'] }];
  assert.equal(applyIssues(bad, { projects: { x: { open_issues: 1 } } }), bad);
  assert.equal(applyIssues(bad, null), bad);
  assert.match(checkIssues({}), /no projects/);
});
