// Renders validated status entries into a single self-contained HTML page.
import { CURRENT_SCHEMA_VERSION } from './schema.mjs';

import { renderActivity, renderBuildsView, renderKpis, renderProjectActivity, renderProjectBuilds } from './activity-render.mjs';
import { renderUsage, renderUsageAlert } from './usage-render.mjs';
import { renderStorage, renderStorageAlert } from './storage-render.mjs';
import { renderClaude, renderClaudeAlert } from './claude-render.mjs';
import { renderDesktop } from './desktop-render.mjs';
import { renderUsersLine } from './users.mjs';

const HEALTH_ORDER = { blocked: 0, attention: 1, ok: 2 };
const HEALTH_LABEL = { ok: 'OK', attention: 'Attention', blocked: 'Blocked' };
export const STALE_DAYS = 14;

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
const e = escapeHtml;

/** blocked → attention → ok, then most recent session first. Invalid files go first. */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? 1 : -1;
    if (!a.ok) return a.name.localeCompare(b.name);
    const h = HEALTH_ORDER[a.data.health] - HEALTH_ORDER[b.data.health];
    if (h !== 0) return h;
    const t = Date.parse(b.data.last_session) - Date.parse(a.data.last_session);
    return t !== 0 ? t : a.name.localeCompare(b.name);
  });
}

const DIVISIONS = [
  [60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'],
  [4.34524, 'week'], [12, 'month'], [Number.POSITIVE_INFINITY, 'year'],
];

/** Same algorithm as the client script, so the server-rendered text matches. */
export function relativeTime(iso, now) {
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  let amount = (Date.parse(iso) - now) / 1000;
  for (const [size, unit] of DIVISIONS) {
    if (Math.abs(amount) < size) return rtf.format(Math.round(amount), unit);
    amount /= size;
  }
  return iso;
}

export function isStale(iso, now) {
  return now - Date.parse(iso) > STALE_DAYS * 24 * 60 * 60 * 1000;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "#304" from a GitHub issue/PR URL, or null. */
function issueRef(url) {
  const m = /\/(?:issues|pull)\/(\d+)\/?$/.exec(url);
  return m ? `#${m[1]}` : null;
}

/**
 * Escapes text and links every `#N` / `owner/repo#N` to GitHub, against the
 * project's repo_url. GitHub redirects /issues/N to /pull/N for a PR, so one
 * URL shape covers both. Works on the raw text, so `&#39;` from escaping is
 * never mistaken for issue 39.
 */
export function linkRefs(text, repoUrl) {
  const repo = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(repoUrl ?? '')?.[0];
  const re = /(?<![\w&/#])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;
  let out = '';
  let last = 0;
  for (const m of String(text).matchAll(re)) {
    const base = m[1] ? `https://github.com/${m[1]}` : repo;
    if (!base) continue;
    out += e(text.slice(last, m.index)) + link(`${base}/issues/${m[2]}`, e(m[0]));
    last = m.index + m[0].length;
  }
  return out + e(String(text).slice(last));
}

function link(href, text, cls = '') {
  return `<a href="${e(href)}"${cls ? ` class="${cls}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function timeEl(iso, now) {
  return `<time datetime="${e(iso)}" data-rel title="${e(iso)}">${e(relativeTime(iso, now))}</time>`;
}


function dot(health) {
  return `<span class="dot dot-${e(health)}" aria-hidden="true"></span>`;
}

const chevron = '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

/** "Needs you": owner tasks grouped by project; the most urgent group starts open. */
function renderTasks(sorted) {
  const groups = sorted.filter((x) => x.ok && x.data.owner_tasks.length > 0);
  const total = groups.reduce((n, x) => n + x.data.owner_tasks.length, 0);
  const body = groups.length === 0
    ? '<p class="empty">Nothing assigned to you right now.</p>'
    : groups.map(({ data }, i) => `
    <details class="task-group"${i === 0 ? ' open' : ''}>
      <summary>${dot(data.health)}<span class="group-name">${e(data.project)}</span><span class="muted">${plural(data.owner_tasks.length, 'task')}</span>${chevron}</summary>
      <ul class="task-list">
        ${data.owner_tasks.map((t) => {
          const ref = issueRef(t.url);
          return `<li>${link(t.url, `<span class="task-title">${e(t.title)}</span>${ref ? `<span class="ref">${e(ref)}</span>` : ''}`)}</li>`;
        }).join('\n        ')}
      </ul>
    </details>`).join('');
  return `
  <section class="panel tasks" aria-labelledby="tasks-heading">
    <h2 id="tasks-heading">Needs you <span class="muted">· ${plural(total, 'task')}</span></h2>
    ${body}
  </section>`;
}

/** "2.1.0 → 2.0.3" when sandbox is ahead, else the one known version. */
function versionShort(d) {
  const { sandbox, production } = d.version;
  if (sandbox !== null && production !== null && sandbox !== production) return `${sandbox} → ${production}`;
  return production ?? sandbox ?? '';
}

function renderRelease(d) {
  const { sandbox, production } = d.version;
  const { merged_prs: prs, release_pr_url: prUrl } = d.pending_release;
  const versions = [
    sandbox !== null && `Sandbox <b>${e(sandbox)}</b>`,
    production !== null && `Production <b>${e(production)}</b>`,
  ].filter(Boolean);
  const differ = sandbox !== null && production !== null && sandbox !== production;
  let pending = '';
  if (prs || prUrl || differ) {
    const parts = [prs ? `${plural(prs, 'merged PR')} waiting to release` : differ ? 'Sandbox and production differ' : 'Release pending'];
    parts.push(prUrl ? link(prUrl, 'Release PR →') : 'no release PR yet');
    pending = `<p class="pending">${parts.join(' · ')}</p>`;
  }
  if (!versions.length && !pending) return '';
  return `
        <div class="detail">
          <h4>Release</h4>
          ${versions.length ? `<p>${versions.join(' · ')}</p>` : ''}
          ${pending}
        </div>`;
}

/** A row in the Projects list; it opens the project's own page. */
function renderRow({ data: d }, now, users = null) {
  const stale = isStale(d.last_session, now);
  const version = versionShort(d);
  // Visits and installs, small, under the reason.
  const usersLine = renderUsersLine(users, d.project);
  return `
    <a class="row row-head${usersLine ? ' has-users' : ''}" href="#/p/${e(d.project)}" data-health="${e(d.health)}">
      ${dot(d.health)}
      <span class="row-name">${e(d.project)}</span>
      <span class="row-reason"><span class="sr-only">${HEALTH_LABEL[d.health]}: </span>${d.health_reason !== null ? e(d.health_reason) : `<span class="muted">${HEALTH_LABEL[d.health]}</span>`}</span>
      ${version ? `<span class="row-version">${e(version)}</span>` : ''}
      ${usersLine}
      <span class="row-time">${timeEl(d.last_session, now)}<span class="stale-badge" data-stale-for="${e(d.last_session)}"${stale ? '' : ' hidden'}>Stale</span></span>
      ${chevron}
    </a>`;
}

/** A project's own page: everything its status file says, plus its activity and builds. */
function renderProjectPage({ data: d, outdated }, now, users = null) {
  const links = [
    d.repo_url && link(d.repo_url, 'Repo', 'btn'),
    d.urls.sandbox && link(d.urls.sandbox, 'Sandbox', 'btn'),
    d.urls.production && link(d.urls.production, 'Production', 'btn'),
    // Schema v2: the project's own extra links (Worker, F-Droid, …), in its order.
    ...(d.links ?? []).map((l) => link(l.url, e(l.label), 'btn')),
  ].filter(Boolean);
  const stale = isStale(d.last_session, now);

  return `
  <section class="view project-page" id="project-${e(d.project)}" data-view="p/${e(d.project)}" data-title="${e(d.project)}" aria-labelledby="h-${e(d.project)}" hidden>
    <a class="back" href="#/overview">← Overview</a>
    <header class="project-head" data-health="${e(d.health)}">
      <h2 id="h-${e(d.project)}" tabindex="-1">${dot(d.health)}${e(d.project)}</h2>
      <p class="project-reason"><span class="health-label">${HEALTH_LABEL[d.health]}</span>${d.health_reason !== null ? ` · ${linkRefs(d.health_reason, d.repo_url)}` : ''}</p>
      ${renderUsersLine(users, d.project, { page: true })}
      <p class="muted">Last session ${timeEl(d.last_session, now)}<span class="stale-badge" data-stale-for="${e(d.last_session)}"${stale ? '' : ' hidden'}>Stale</span></p>
      ${links.length ? `<nav class="links" aria-label="${e(d.project)} links">${links.join('')}</nav>` : ''}
      <details class="side-menu">
        <summary aria-label="Split view" title="Split view"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></summary>
        <div class="side-menu-list">
          <button type="button" data-side-act="pin" data-project="${e(d.project)}">Pin to left</button>
          <button type="button" data-side-act="swap" hidden>Swap sides</button>
          <button type="button" data-side-act="close" hidden>Close</button>
        </div>
      </details>
    </header>
    ${statTiles({
      open: d.open_issues,
      closed: Number.isInteger(d.closed_issues) ? d.closed_issues : null,
      tasks: d.owner_tasks.length,
    }, `${e(d.project)} totals`)}
    <div class="details-grid panel">
      <div class="details-col">
        ${d.owner_tasks.length ? `
        <div class="detail">
          <h4>Needs you</h4>
          <ul class="task-list">${d.owner_tasks.map((t) => {
            const ref = issueRef(t.url);
            return `<li>${link(t.url, `<span class="task-title">${e(t.title)}</span>${ref ? `<span class="ref">${e(ref)}</span>` : ''}`)}</li>`;
          }).join('')}</ul>
        </div>` : ''}
        ${renderRelease(d)}
        ${d.next_steps.length ? `
        <div class="detail">
          <h4>Next steps</h4>
          <ol>${d.next_steps.map((s) => `<li>${linkRefs(s, d.repo_url)}</li>`).join('')}</ol>
        </div>` : ''}
        ${d.summary !== null ? `
        <div class="detail">
          <h4>Last session</h4>
          <p>${linkRefs(d.summary, d.repo_url)}</p>
        </div>` : ''}
      </div>
      <div class="details-col">
        ${renderProjectActivity(d)}
        ${renderProjectBuilds(d)}
        ${outdated ? `<p class="outdated-note">Uses status schema v${e(d.schema_version)}; its next session migrates it to v${CURRENT_SCHEMA_VERSION}.</p>` : ''}
      </div>
    </div>
  </section>`;
}

function renderWarning({ name, problems }) {
  return `
    <details class="row row-warning" id="project-${e(name)}" data-health="invalid" open>
      <summary class="row-head">
        ${dot('invalid')}
        <span class="row-name">${e(name)}</span>
        <span class="row-reason">Invalid status file</span>
        ${chevron}
      </summary>
      <div class="row-body">
        <p class="warning-intro">status/${e(name)}.json could not be shown:</p>
        <ul class="problems">${problems.map((p) => `<li>${e(p)}</li>`).join('')}</ul>
      </div>
    </details>`;
}

/**
 * Totals across projects: open issues, closed issues (schema v3; projects still
 * on v1/v2 or reporting null are left out rather than counted as zero) and the
 * owner's tasks. "Needs you" lists the tasks; this row is the overall picture.
 */
function renderStats(sorted) {
  const valid = sorted.filter((x) => x.ok);
  const openKnown = valid.filter((x) => x.data.open_issues !== null);
  const closedKnown = valid.filter((x) => Number.isInteger(x.data.closed_issues));
  const sum = (list, key) => list.reduce((n, x) => n + x.data[key], 0);
  return statTiles({
    open: openKnown.length ? sum(openKnown, 'open_issues') : null,
    closed: closedKnown.length ? sum(closedKnown, 'closed_issues') : null,
    tasks: valid.reduce((n, x) => n + x.data.owner_tasks.length, 0),
  }, 'Totals');
}

/** The open / closed / tasks tiles; a null count (not reported) has no tile rather than a 0. */
function statTiles({ open, closed, tasks }, label) {
  const tile = (value, one, many) =>
    `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${value === 1 ? one : many}</span></div>`;
  const tiles = [];
  if (open !== null) tiles.push(tile(open, 'open issue', 'open issues'));
  if (closed !== null) tiles.push(tile(closed, 'closed issue', 'closed issues'));
  tiles.push(tile(tasks, 'your task', 'your tasks'));
  return `
  <section class="stats" aria-label="${label}">${tiles.join('')}</section>`;
}

function renderOverview(sorted) {
  const counts = { blocked: 0, attention: 0, ok: 0 };
  let invalid = 0;
  for (const x of sorted) x.ok ? counts[x.data.health]++ : invalid++;
  const pills = [];
  if (invalid) pills.push(`<span class="pill pill-invalid">${invalid} invalid</span>`);
  if (counts.blocked) pills.push(`<span class="pill pill-blocked">${counts.blocked} blocked</span>`);
  if (counts.attention) pills.push(`<span class="pill pill-attention">${counts.attention} need attention</span>`);
  if (counts.ok) pills.push(`<span class="pill pill-ok">${counts.ok} fine</span>`);
  return pills.join('');
}

const TABS = [
  // The Desktop is the first page; the Overview moved to #/overview.
  { view: 'desktop', href: '#/', label: 'Desktop', icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>' },
  { view: 'overview', href: '#/overview', label: 'Overview', icon: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>' },
  { view: 'activity', href: '#/activity', label: 'Activity', icon: '<path d="M3 12h4l3-8 4 16 3-8h4"/>' },
  { view: 'builds', href: '#/builds', label: 'Builds', icon: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>' },
  // Claude plan usage: a gauge, the limit filling toward its end.
  { view: 'claude', href: '#/claude', label: 'Claude', icon: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/><path d="M7 17h.01M17 17h.01"/>' },
  { view: 'storage', href: '#/storage', label: 'Storage', icon: '<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/>' },
];

function renderTabs(claude) {
  return `
<nav class="tabs" aria-label="Sections">
  ${TABS.filter((t) => t.view !== 'claude' || claude).map((t) => `<a href="${t.href}" data-tab="${t.view}"${t.view === 'desktop' ? ' aria-current="page"' : ''}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${t.icon}</svg><span>${t.label}</span></a>`).join('\n  ')}
</nav>`;
}

// One icon per choice; CSS shows the one matching data-current.
const themeIcons = [
  ['light', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
  ['dark', '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'],
].map(([k, d]) => `<svg data-icon="${k}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`).join('');

const installIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';

/**
 * @param {Array} entries results of loadStatus()
 * @param {{ css: string, js: string, now: number, version: string, usage?: object|null, storage?: object|null, updatedAt?: string|null }} opts
 *   usage: usage/github.json, storage: usage/storage.json, or null when not collected.
 *   updatedAt: when the newest data arrived (the Worker renders on every request).
 */
export function renderPage(entries, { css, js, now, version, usage = null, storage = null, apps = null, claude = null, users = null, updatedAt = null }) {
  const sorted = sortEntries(entries);
  const builtIso = updatedAt ?? new Date(now).toISOString();
  const invalid = sorted.filter((x) => !x.ok);
  const needsLook = sorted.filter((x) => x.ok && x.data.health !== 'ok');
  const fine = sorted.filter((x) => x.ok && x.data.health === 'ok');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f5f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121417" media="(prefers-color-scheme: dark)">
<meta name="dashboard-version" content="${e(version)}">
<title>Projects</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="1" width="6" height="6" rx="1.5" fill="#4f7c6b"/><rect x="9" y="1" width="6" height="6" rx="1.5" fill="#c9a24a"/><rect x="1" y="9" width="6" height="6" rx="1.5" fill="#c9a24a"/><rect x="9" y="9" width="6" height="6" rx="1.5" fill="#4f7c6b"/></svg>')}">
<!-- use-credentials: the site sits behind Cloudflare Access, and a manifest
     fetched without the Access cookie gets the login redirect instead. -->
<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Projects">
<script>try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${css}</style>
</head>
<body>
<div class="titlebar" aria-hidden="true"></div>
<header class="app-bar">
  <a class="brand" href="#/"><h1>Projects</h1></a>
  <span class="app-tools">
    <button type="button" class="theme-toggle" data-current="light" aria-label="Switch to dark theme" title="Switch to dark theme">${themeIcons}</button>
    <button type="button" class="install" aria-label="Install app" title="Install app" hidden>${installIcon}<span>Install</span></button>
  </span>
  <div class="install-hint" role="dialog" aria-label="Install on iPhone" hidden>
    <p>Tap <b>Share</b> <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 12v8h14v-8"/></svg>, then <b>Add to Home Screen</b>.</p>
    <button type="button" class="install-hint-close">OK</button>
  </div>
</header>
${renderTabs(claude)}
<div class="split">
<!-- Split view: client.js copies the pinned project here on wide screens. -->
<aside class="pinned" aria-label="Pinned project" hidden></aside>
<main class="page">
  ${renderDesktop(entries, apps)}
  <section class="view" data-view="overview" data-title="Overview" aria-label="Overview" hidden>
    <p class="overview">${renderOverview(sorted)}</p>
    ${renderClaudeAlert(claude, now)}
    ${renderUsageAlert(usage, now)}
    ${renderStorageAlert(storage)}
    ${renderStats(sorted)}
    ${renderTasks(sorted)}
    <!-- The project list was its own tab; merged here so the
         phone's tab bar had room for Claude. -->
    ${invalid.length ? `
    <div class="rows">
      <h2 class="section-label section-label-invalid">Status files that need fixing</h2>
      ${invalid.map(renderWarning).join('')}
    </div>` : ''}
    <div class="rows">
      <h2 id="projects-heading" class="section-label">Need a look · ${needsLook.length}</h2>
      ${needsLook.map((x) => renderRow(x, now, users)).join('') || '<p class="empty">Nothing needs a look.</p>'}
    </div>
    ${fine.length ? `
    <div class="rows">
      <h2 class="section-label">All fine · ${fine.length}</h2>
      ${fine.map((x) => renderRow(x, now, users)).join('')}
    </div>` : ''}
    ${sorted.length ? '' : '<p class="empty">No status files found in status/.</p>'}
  </section>
  <section class="view" data-view="activity" data-title="Activity" hidden>
    ${renderKpis(sorted)}
    ${renderActivity(sorted)}
  </section>
  <section class="view" data-view="builds" data-title="Builds" hidden>
    ${renderUsage(usage, now, sorted)}
    ${renderBuildsView(sorted)}
  </section>
  ${claude ? `<section class="view" data-view="claude" data-title="Claude" hidden>
    ${renderClaude(claude, now, sorted) || '<h2 class="section-label" tabindex="-1">Claude</h2>\n    <p class="empty">No Claude usage yet: the usage timer writes usage/claude.json.</p>'}
  </section>` : ''}
  <section class="view" data-view="storage" data-title="Storage" hidden>
    ${renderStorage(storage, now) || '<h2 class="section-label" tabindex="-1">Storage</h2>\n    <p class="empty">No storage numbers yet: the publish watcher writes usage/storage.json.</p>'}
  </section>
  ${sorted.filter((x) => x.ok).map((x) => renderProjectPage(x, now, users)).join('')}
  <footer class="page-foot">
    <p>Last update <time datetime="${builtIso}" data-rel title="${builtIso}">${e(relativeTime(builtIso, now))}</time>
    · <time datetime="${builtIso}" data-abs>${builtIso.replace('T', ' ').slice(0, 16)} UTC</time></p>
  </footer>
</main>
</div>
<div class="update-toast" role="status" aria-live="polite" hidden>
  <span class="update-text">A new version of this page is available.</span>
  <span class="update-actions">
    <button type="button" class="update-later">Later</button>
    <button type="button" class="update-now">Update</button>
  </span>
</div>
<script>${js}</script>
</body>
</html>
`;
}
