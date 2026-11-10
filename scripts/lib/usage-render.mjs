// GitHub plan usage (usage/github.json) on the Builds view, and a line on the
// Overview only when an account is near or over what its plan includes.
import { escapeHtml as e, relativeTime } from './render.mjs';

const NEAR = 0.8;
const fmt = (n) => n.toLocaleString('en-GB');

/** Share of the month gone at `now`, for the "on pace for" projection. */
/** Minutes used of the quota; older files only have raw `total`. */
const used = (m) => m.counted ?? m.total;

function monthElapsed(now) {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return (now - start) / (end - start);
}

/** 'over' | 'near' | 'ok' for used against included; null when unknown. */
export function level(used, included) {
  if (!included) return null;
  if (used >= included) return 'over';
  return used / included >= NEAR ? 'near' : 'ok';
}

const LABEL = { over: 'Over the plan', near: 'Near the limit', pace: 'On pace to pass the plan' };

/** Minutes projected to month end at this month's rate; null too early to tell. */
export function pace(used, now) {
  const share = monthElapsed(now);
  return share > 0.1 ? Math.round(used / share) : null;
}

function meter(name, used, included, text, sub, { paceOver = false } = {}) {
  let lv = level(used, included);
  if (lv === 'ok' && paceOver) lv = 'pace';
  const pct = included ? Math.min(100, (used / included) * 100) : 0;
  return `
      <div class="meter" data-level="${lv ?? 'unknown'}">
        <div class="meter-head"><span class="meter-name">${name}</span><span class="meter-value">${text}</span></div>
        <span class="meter-track" role="img" aria-label="${e(`${name}: ${text}`)}"><span class="meter-fill" style="width:${pct.toFixed(1)}%"></span></span>
        ${sub || LABEL[lv] ? `<p class="meter-sub">${LABEL[lv] ? `<span class="meter-flag">${LABEL[lv]}</span>` : ''}${sub}</p>` : ''}
      </div>`;
}

/** Which dashboard project a repository belongs to, from each status file's repo_url. */
function projectsByRepo(sorted) {
  const map = new Map();
  for (const x of sorted ?? []) {
    const m = x.ok && x.data.repo_url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/i);
    if (m) map.set(`${m[1]}/${m[2]}`.toLowerCase(), x.data.project);
  }
  return map;
}

/**
 * Minutes per repository this month, biggest first; bars share one scale.
 * Always open, with its count like Storage's buckets: it used to start
 * closed above six repositories, and with the disclosure marker hidden the
 * closed list looked like a heading with nothing under it.
 */
function renderRepos(a, projects) {
  if (!a.repos?.length) return '';
  const max = a.repos[0].minutes;
  const rows = a.repos.map((r) => {
    const project = projects.get(`${a.login}/${r.name}`.toLowerCase());
    const name = project ? `<a href="#/p/${e(project)}">${e(r.name)}</a>` : e(r.name);
    const share = a.minutes.total ? Math.round((r.minutes / a.minutes.total) * 100) : 0;
    return `
          <li${r.public ? ' class="repo-public"' : ''}><span class="repo-name">${name}${r.public ? ' <span class="repo-free">public</span>' : ''}</span><span class="repo-bar"><span style="width:${((r.minutes / max) * 100).toFixed(1)}%"></span></span><span class="repo-min" title="${share}% of this account's minutes">${fmt(r.minutes)}</span></li>`;
  }).join('');
  return `
      <details class="repo-usage" open>
        <summary>Minutes by repository · ${a.repos.length}</summary>
        <ul>${rows}
        </ul>
      </details>`;
}

function renderAccount(a, now, projects) {
  const head = `<h3>${e(a.login)} ${a.plan ? `<span class="muted">· ${e(a.plan[0].toUpperCase() + a.plan.slice(1))}</span>` : ''}</h3>`;
  if (a.problem) return `
    <div class="usage-account">${head}<p class="usage-problem">${e(a.problem)}</p></div>`;
  const m = a.minutes;
  const s = a.storage;
  const split = [['Linux', m.linux], ['Windows', m.windows], ['macOS', m.macos], ['Other', m.other]]
    .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ');
  const projected = m.included ? pace(used(m), now) : null;
  const paceOver = projected !== null && projected > m.included;
  const paceText = paceOver ? ` · on pace for ${fmt(projected)} by month end` : '';
  const freeText = m.public ? ` · ${fmt(m.public)} more free in public repos` : '';
  const rawText = m.counted != null && m.counted !== m.total ? ` · ${fmt(m.total)} raw minutes` : '';
  const gb = (n) => (n < 1 ? `${fmt(Math.round(n * 1024))} MB` : `${n.toFixed(2)} GB`);
  return `
    <div class="usage-account">
      ${head}
      ${meter('Actions minutes', used(m), m.included, `${fmt(used(m))}${m.included ? ` of ${fmt(m.included)}` : ''}`, `${split || 'No private runs'}${rawText}${freeText}${paceText}`, { paceOver })}
      ${renderRepos(a, projects)}
      ${meter('Storage', s.gb, s.included_gb, `${gb(s.gb)}${s.included_gb ? ` of ${gb(s.included_gb)}` : ''}`, 'Average held this month (artifacts, caches, packages)')}
      <p class="usage-billed${a.billed_usd > 0 ? ' usage-billed-due' : ''}">${a.billed_usd > 0 ? `<span class="meter-flag">Billed</span>$${a.billed_usd.toFixed(2)} this month` : 'Nothing billed this month'}</p>
    </div>`;
}

/** @param sorted status entries, to link a repository to its project page */
export function renderUsage(usage, now, sorted = []) {
  if (!usage?.accounts?.length) return '';
  const projects = projectsByRepo(sorted);
  const month = new Date(`${usage.period}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return `
  <section class="panel usage" aria-labelledby="usage-heading">
    <h2 id="usage-heading">GitHub usage <span class="muted">· ${e(month)}</span></h2>
    <div class="usage-grid">${usage.accounts.map((a) => renderAccount(a, now, projects)).join('')}
    </div>
    <p class="viz-foot"><span>Only private repositories count against the plan; public ones run free. Windows and macOS minutes count at their price in Linux minutes (about ×1.7 and ×10). The billed amount is what GitHub charged.</span><span>Read <time datetime="${e(usage.generated_at)}" data-rel title="${e(usage.generated_at)}">${e(relativeTime(usage.generated_at, now))}</time></span></p>
  </section>`;
}

/** Overview line: only accounts near, over or on pace to pass a limit, or billed. */
export function renderUsageAlert(usage, now) {
  const hits = (usage?.accounts ?? []).flatMap((a) => {
    if (a.problem) return [];
    const out = [];
    const lm = level(used(a.minutes), a.minutes.included);
    const ls = level(a.storage.gb, a.storage.included_gb);
    const projected = a.minutes.included ? pace(used(a.minutes), now) : null;
    if (lm === 'over' || lm === 'near') out.push(`${a.login}: ${fmt(used(a.minutes))} of ${fmt(a.minutes.included)} Actions minutes`);
    else if (projected !== null && projected > a.minutes.included) out.push(`${a.login}: on pace for ${fmt(projected)} of ${fmt(a.minutes.included)} Actions minutes`);
    if (ls === 'over') out.push(`${a.login}: storage over the plan`);
    else if (ls === 'near') out.push(`${a.login}: storage near the plan`);
    if (a.billed_usd > 0) out.push(`${a.login}: $${a.billed_usd.toFixed(2)} billed`);
    return out;
  });
  if (!hits.length) return '';
  return `
    <a class="usage-alert" href="#/builds"><span class="meter-flag">GitHub limits</span>${hits.map(e).join(' · ')}</a>`;
}
