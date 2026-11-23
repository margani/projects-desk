// Issue counts and owner tasks, read from GitHub for every project with a repo.
// A status file is written by that project's own session, so a project with no
// session open kept its old counts: on 2026-11-23 three of them were wrong (one
// by 23 issues) and the page showed them as current. GitHub is the source, so
// the collector reads it and the page lays it over the file. The file is never
// rewritten here: a session may be writing it at the same moment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { settleLimited } from './apps.mjs';

const run = promisify(execFile);

const COUNTS = 'query($o:String!,$n:String!){repository(owner:$o,name:$n){open:issues(states:OPEN){totalCount} closed:issues(states:CLOSED){totalCount}}}';

/** "owner/name" from an https GitHub URL; null for anything else. */
export function repoSlug(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}` : null;
}

const gh = async (args) => (await run('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;

/** Counts and the owner's open issues for one repo; throws when GitHub cannot answer. */
export async function readRepo(slug, { ghImpl = gh } = {}) {
  const [owner, name] = slug.split('/');
  const counts = JSON.parse(await ghImpl(['api', 'graphql', '-f', `query=${COUNTS}`, '-f', `o=${owner}`, '-f', `n=${name}`])).data?.repository;
  const open = counts?.open?.totalCount;
  const closed = counts?.closed?.totalCount;
  if (!Number.isInteger(open) || !Number.isInteger(closed)) throw new Error('no issue counts in the answer');
  const mine = JSON.parse(await ghImpl(['issue', 'list', '-R', slug, '--state', 'open', '--assignee', '@me', '--limit', '100', '--json', 'title,url']));
  if (!Array.isArray(mine)) throw new Error('no issue list in the answer');
  return { open_issues: open, closed_issues: closed, owner_tasks: mine.map(({ title, url }) => ({ title, url })) };
}

/**
 * usage/issues.json: { generated_at, projects: { <project>: {...}|null }, problems }.
 * A project GitHub could not answer for is simply absent, so the page keeps the
 * file's numbers for it.
 */
export async function collectIssues(entries, { ghImpl, now = Date.now(), limit = 4 } = {}) {
  const todo = entries.filter((x) => x.ok && repoSlug(x.data.repo_url)).map((x) => ({ project: x.data.project, slug: repoSlug(x.data.repo_url) }));
  const settled = await settleLimited(todo, (t) => readRepo(t.slug, { ghImpl }), limit);
  const projects = {};
  const problems = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') projects[todo[i].project] = s.value;
    else problems.push(`${todo[i].project}: ${String(s.reason?.message ?? s.reason).split('\n')[0].slice(0, 120)}`);
  });
  return { generated_at: new Date(now).toISOString(), projects, problems };
}

/** usage/issues.json: an object, or why it cannot be used. */
export function checkIssues(value) {
  if (value === null || typeof value !== 'object' || value.projects === null || typeof value.projects !== 'object') return 'no projects';
  return null;
}

/** Lays GitHub's numbers over the status entries (mutates entry.data of valid ones). */
export function applyIssues(entries, issues) {
  if (!issues?.projects) return entries;
  for (const x of entries) {
    const g = x.ok ? issues.projects[x.data.project] : null;
    if (!g) continue;
    x.data.open_issues = g.open_issues;
    x.data.closed_issues = g.closed_issues;
    x.data.owner_tasks = g.owner_tasks;
  }
  return entries;
}
