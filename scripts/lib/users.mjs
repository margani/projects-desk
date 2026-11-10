// Each project's user numbers: visits, installs and the like, counted
// by the project itself in its own D1 database and read here once a day with
// the laptop's `read` token. Collected rather than written by hand in the
// status file, so no project session has to keep it current and the status
// schema does not change. Config: users.config.json. The page imports this
// file, so the database client comes from the caller: d1.mjs reads the
// installation's config and cannot load inside the Worker.
import { escapeHtml as e } from './render.mjs';

export const MAX_METRICS = 5;
const MAX_LABEL = 32;
const ID = /^[0-9a-f-]{32,36}$/;

/** users.config.json → a list of problems; empty when it can be used. */
export function checkConfig(config) {
  const problems = [];
  const projects = config?.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return ['no "projects" object'];
  for (const [name, p] of Object.entries(projects)) {
    if (!ID.test(p?.d1?.account ?? '') || !ID.test(p?.d1?.database ?? '')) problems.push(`${name}: d1.account and d1.database must be ids`);
    if (!Array.isArray(p?.metrics) || !p.metrics.length || p.metrics.length > MAX_METRICS) { problems.push(`${name}: 1 to ${MAX_METRICS} metrics`); continue; }
    p.metrics.forEach((m, i) => {
      if (typeof m?.label !== 'string' || !m.label.trim() || m.label.length > MAX_LABEL) problems.push(`${name}: metrics[${i}].label must be 1 to ${MAX_LABEL} characters`);
      // The read token cannot write anyway; this keeps a typo from becoming a
      // write if the config is ever run with another token.
      if (typeof m?.sql !== 'string' || !/^\s*(select|with)\b/i.test(m.sql)) problems.push(`${name}: metrics[${i}].sql must be a SELECT`);
    });
  }
  return problems;
}

/** One project's counts in one batch; each statement returns one row with a number `n`. */
async function readProject(name, p, query, timeout) {
  // The D1 API answers an array with one entry per statement, batch or not.
  const results = await query(p.metrics.map((m) => ({ sql: m.sql })), { target: p.d1, timeout });
  return p.metrics.map((m, i) => {
    // A query without a column `n` is a broken config, never a zero.
    const row = results?.[i]?.results?.[0];
    if (!row || !('n' in row)) throw new Error(`"${m.label}": no row with a column n`);
    const n = row.n ?? 0;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`"${m.label}": n is ${JSON.stringify(n)}, not a number`);
    return { label: m.label, n };
  });
}

/**
 * Every project in the config, read in parallel; one failing project never
 * holds up the others. → { generated_at, projects: [{ project, metrics, read_at, problem }] }
 */
export async function collectUsers(config, { query, now = Date.now(), timeout = 30_000 } = {}) {
  const at = new Date(now).toISOString();
  const names = Object.keys(config.projects).sort();
  const settled = await Promise.allSettled(names.map((name) => readProject(name, config.projects[name], query, timeout)));
  return {
    generated_at: at,
    projects: settled.map((s, i) => (s.status === 'fulfilled'
      ? { project: names[i], metrics: s.value, read_at: at, problem: null }
      : { project: names[i], metrics: null, read_at: null, problem: s.reason?.message ?? String(s.reason) })),
  };
}

/** A project that failed today keeps yesterday's numbers and their read_at, with the problem. */
export function carryUsers(fresh, previous) {
  const before = new Map((previous?.projects ?? []).filter((p) => p.metrics).map((p) => [p.project, p]));
  return {
    ...fresh,
    projects: fresh.projects.map((p) => (p.metrics || !before.has(p.project) ? p : { ...p, metrics: before.get(p.project).metrics, read_at: before.get(p.project).read_at })),
  };
}

/** usage/users.json: an object, or why it cannot be shown. */
export function checkUsers(value) {
  if (!Array.isArray(value?.projects) || typeof value.generated_at !== 'string') return 'no projects or generated_at';
  return null;
}

const fmt = (n) => n.toLocaleString('en-GB');
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * The small line for one project: "11 visits yesterday · 26 last 7 days".
 * Numbers from an earlier day (today's read failed) say so; a project whose
 * numbers were never read shows the problem on its page only.
 */
export function renderUsersLine(users, project, { page = false } = {}) {
  const u = users?.projects?.find((p) => p.project === project);
  if (!u) return '';
  if (!u.metrics) return page ? `<p class="users-line users-problem">User numbers could not be read: ${e(u.problem)}</p>` : '';
  // Each count stays whole: with five on a phone the line broke as "12,345 app / opens".
  const text = u.metrics.map((m) => `<span class="users-n"><b>${fmt(m.n)}</b> ${e(m.label)}</span>`).join(' · ');
  const old = u.problem ? ` <span class="users-old">· from ${e(day(u.read_at))}</span>` : '';
  const title = u.problem ? `Read ${day(u.read_at)}; today: ${u.problem}` : `Read ${day(u.read_at)}`;
  return page
    ? `<p class="users-line" title="${e(title)}">${text}${old}</p>`
    : `<span class="users-line" title="${e(title)}">${text}${old}</span>`;
}
