// Activity charts (schema v4 "activity"): totals with sparklines, a weekly
// heatmap per project with a metric switch, and a build-time strip per project.
// Plain HTML and CSS only, so the marks stay crisp at phone width and every
// value is also in the table view.
import { escapeHtml as e } from './render.mjs';
import { weekKeys, weekStart, dayOf, DEFAULT_WEEKS } from './activity.mjs';

const METRICS = [
  { key: 'commits', label: 'Commits', one: 'commit', many: 'commits', value: (b) => b.commits },
  { key: 'issues', label: 'Issues closed', one: 'issue closed', many: 'issues closed', value: (b) => b.issues_closed },
  { key: 'lines', label: 'Lines changed', one: 'line changed', many: 'lines changed', value: (b) => b.lines_added + b.lines_deleted },
];
/**
 * The ranges Activity and Builds can show. 12 weeks by week was the only view,
 * so a busy August kept a quiet project on top and this week was one cell.
 */
export const RANGES = [
  { key: '4w', label: '4 weeks', unit: 'day', count: 28 },
  { key: '12w', label: '12 weeks', unit: 'week', count: DEFAULT_WEEKS },
];
const DEFAULT_RANGE = RANGES[1];

const SYSTEM_LABEL = { github: 'GitHub Actions', cloudflare: 'Cloudflare' };
const LEVELS = 5;

export function compact(n) {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function duration(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  // A no-break space keeps "1m 56s" on one line in wrapped text.
  if (m < 60) return r ? `${m}m\u00a0${r}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h\u00a0${m % 60}m` : `${m / 60}h`;
}

export function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dayLabel = (iso) => `${WEEKDAYS[(new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7]} ${shortDate(iso)}`;

/**
 * Weekly buckets from schema v5 daily "days", or v4 "weeks" as they are.
 * @returns {Map<string, {commits:number, issues_closed:number, lines_added:number, lines_deleted:number}>}
 */
export function weeklyBuckets(activity) {
  if (activity.weeks) return new Map(activity.weeks.map((w) => [w.week, w]));
  const byWeek = new Map();
  for (const d of activity.days) {
    const key = weekStart(`${d.date}T00:00:00Z`);
    const w = byWeek.get(key) ?? { week: key, commits: 0, issues_closed: 0, lines_added: 0, lines_deleted: 0 };
    w.commits += d.commits; w.issues_closed += d.issues_closed;
    w.lines_added += d.lines_added; w.lines_deleted += d.lines_deleted;
    byWeek.set(key, w);
  }
  return byWeek;
}

/** The `count` days ending with the day of `now`, oldest first. */
function lastDays(now, count) {
  const end = new Date(`${dayOf(now)}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (count - 1 - i));
    return dayOf(d);
  });
}

/**
 * Lines the projects up on one axis of `range` (weeks, or days). The axis
 * ends at the newest `generated_at`, not at build time, so the page (and its
 * version hash) only changes when the data does. `weeks` holds the slot keys
 * in either unit. A v4 file has no days, so its daily cells show "no data".
 */
export function activityModel(sorted, range = DEFAULT_RANGE) {
  const reporting = sorted.filter((x) => x.ok && x.data.activity);
  if (!reporting.length) return null;
  const latest = reporting.map((x) => x.data.activity.generated_at).sort().at(-1);
  const daily = range.unit === 'day';
  const weeks = daily ? lastDays(latest, range.count) : weekKeys(latest, range.count);
  const since = `${weeks[0]}T00:00:00Z`;
  const projects = reporting.map(({ data }) => {
    const bySlot = daily ? new Map((data.activity.days ?? []).map((d) => [d.date, d])) : weeklyBuckets(data.activity);
    const cells = weeks.map((w) => bySlot.get(w) ?? null);
    const builds = data.activity.builds.filter((b) => b.started_at >= since);
    const total = (fn) => cells.reduce((n, c) => n + (c ? fn(c) : 0), 0);
    return {
      name: data.project, cells, builds, days: data.activity.days ?? null,
      totals: {
        commits: total((c) => c.commits),
        issues: total((c) => c.issues_closed),
        lines: total((c) => c.lines_added + c.lines_deleted),
        added: total((c) => c.lines_added),
        deleted: total((c) => c.lines_deleted),
      },
    };
  });
  const silent = sorted.filter((x) => x.ok && !x.data.activity).map((x) => x.data.project);
  return { weeks, projects, silent, range };
}

/** 0 for nothing, else 1..5 on a square-root scale, so one huge week does not wash out the rest. */
function level(v, max) {
  if (!v || !max) return 0;
  return Math.min(LEVELS, 1 + Math.floor((LEVELS - 1) * Math.sqrt(v / max) + 1e-9));
}

function spark(values, label) {
  const max = Math.max(...values, 0);
  const bars = values.map((v, i) => {
    const h = max ? Math.max(v ? 8 : 0, Math.round((v / max) * 100)) : 0;
    return `<span class="spark-bar${i === values.length - 1 ? ' spark-now' : ''}" style="height:${h}%"></span>`;
  }).join('');
  return `<span class="spark" role="img" aria-label="${e(label)}">${bars}</span>`;
}

function renderTiles(model) {
  const weekly = (fn) => model.weeks.map((_, i) => model.projects.reduce((n, p) => n + (p.cells[i] ? fn(p.cells[i]) : 0), 0));
  const sum = (k) => model.projects.reduce((n, p) => n + p.totals[k], 0);
  const builds = model.projects.flatMap((p) => p.builds);
  const ok = builds.filter((b) => b.conclusion === 'success').length;
  const finished = builds.filter((b) => b.conclusion !== 'cancelled').length;
  const weeklyMedian = model.weeks.map((w, i) => {
    const end = model.weeks[i + 1] ?? '9999';
    return median(builds.filter((b) => b.started_at >= w && b.started_at < end).map((b) => b.duration_s)) ?? 0;
  });
  const tile = (label, value, sub, sparkValues, sparkLabel) => `
    <div class="kpi">
      <span class="kpi-label">${label}</span>
      <span class="kpi-value">${value}</span>
      <span class="kpi-sub">${sub}</span>
      ${spark(sparkValues, sparkLabel)}
    </div>`;
  const m = median(builds.map((b) => b.duration_s));
  // Daily data (v5) lets the commits tile name the busiest day across all projects.
  const perDay = new Map();
  for (const p of model.projects) for (const d of p.days ?? []) perDay.set(d.date, (perDay.get(d.date) ?? 0) + d.commits);
  const busiest = [...perDay].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const commitSub = busiest?.[1] ? `busiest ${dayLabel(busiest[0])} · ${busiest[1]}` : `${model.projects.length} projects`;
  return `
    <div class="kpis">
      ${tile('Commits', compact(sum('commits')), commitSub, weekly((c) => c.commits), 'Commits per week')}
      ${tile('Issues closed', compact(sum('issues')), 'across all repos', weekly((c) => c.issues_closed), 'Issues closed per week')}
      ${tile('Lines changed', compact(sum('lines')), `<span class="plus">+${compact(sum('added'))}</span> <span class="minus">−${compact(sum('deleted'))}</span>`, weekly((c) => c.lines_added + c.lines_deleted), 'Lines changed per week')}
      ${tile('Median build', m === null ? '—' : duration(m), builds.length ? `${builds.length} runs · ${finished ? Math.round((ok / finished) * 100) : 0}% green` : 'no runs', weeklyMedian, 'Median build time per week')}
    </div>`;
}

/** One range's heatmap; the metric switch above it is shared by every range. */
function renderPulseGrid(model) {
  const daily = model.range.unit === 'day';
  const slotTip = (key) => (daily ? dayLabel(key) : `week of ${shortDate(key)}`);
  const max = Object.fromEntries(METRICS.map((m) => [m.key, Math.max(0, ...model.projects.flatMap((p) => p.cells.map((c) => (c ? m.value(c) : 0))))]));
  const rows = [...model.projects].sort((a, b) => b.totals.commits - a.totals.commits || a.name.localeCompare(b.name));
  const labelAt = new Set([0, Math.floor(model.weeks.length / 2), model.weeks.length - 1]);
  const head = model.weeks.map((w, i) => `<span class="pulse-week">${labelAt.has(i) ? e(shortDate(w)) : ''}</span>`).join('');
  const body = rows.map((p) => {
    const cells = p.cells.map((c, i) => {
      if (!c) return `<span class="cell cell-none" title="${e(`${p.name} · ${slotTip(model.weeks[i])} · no data`)}"></span>`;
      const lv = METRICS.map((m) => `data-${m.key}="${level(m.value(c), max[m.key])}"`).join(' ');
      const tip = `${p.name} · ${slotTip(model.weeks[i])}\n${c.commits} commits · ${c.issues_closed} issues closed\n+${c.lines_added} −${c.lines_deleted} lines`;
      return `<span class="cell" ${lv} title="${e(tip)}"></span>`;
    }).join('');
    const totals = METRICS.map((m) => `<span class="pulse-total" data-metric="${m.key}">${compact(p.totals[m.key])}</span>`).join('');
    return `<a class="pulse-name" href="#/p/${e(p.name)}">${e(p.name)}</a><span class="pulse-cells">${cells}</span>${totals}`;
  }).join('\n');
  const legend = Array.from({ length: LEVELS + 1 }, (_, i) => `<span class="cell" data-commits="${i}" data-issues="${i}" data-lines="${i}"></span>`).join('');
  return `
      <div class="pulse-grid${daily ? ' pulse-daily' : ''}" style="--weeks:${model.weeks.length}">
        <span></span><span class="pulse-cells pulse-head">${head}</span><span></span>
        ${body}
      </div>
      <p class="viz-foot"><span class="scale">Less ${legend} More</span>${model.silent.length ? `<span class="muted">Not reporting yet: ${model.silent.map(e).join(', ')}</span>` : ''}</p>`;
}

/**
 * Every range is rendered and CSS shows the checked one, like the metric
 * switch: no data is fetched or rebuilt in the page. Each view has its own
 * radio name, since one name would make a single group across both views and
 * leave the other view with nothing checked; client.js keeps them in step.
 */
function rangeSwitch(view) {
  return `
      <div class="seg range-seg" role="radiogroup" aria-label="Range">
        ${RANGES.map((r) => `<label><input type="radio" name="range-${view}" value="${r.key}"${r === DEFAULT_RANGE ? ' checked' : ''}><span>${r.label}</span></label>`).join('')}
      </div>`;
}

const panes = (models, fn, tag = 'div') => models.map((m) => `<${tag} class="range-pane" data-range="${m.range.key}">${fn(m)}</${tag}>`).join('');

function renderPulse(models) {
  return `
    <div class="viz pulse">
      <div class="viz-head">
        <h3>Pulse</h3>
        <div class="seg" role="radiogroup" aria-label="Metric">
          ${METRICS.map((m, i) => `<label><input type="radio" name="pulse-metric" value="${m.key}"${i === 0 ? ' checked' : ''}><span>${m.label}</span></label>`).join('')}
        </div>
      </div>
      ${panes(models, renderPulseGrid)}
    </div>`;
}

/** Square-root scale with readable ticks: short builds stay apart, long ones still fit. */
function timeScale(maxS) {
  const ticks = [30, 60, 120, 300, 600, 1200, 1800, 3600];
  const top = ticks.find((t) => t >= maxS) ?? maxS;
  const x = (s) => Math.min(100, (Math.sqrt(s) / Math.sqrt(top)) * 100);
  return { x, ticks: [0, ...ticks.filter((t) => t <= top)] };
}

function renderBuilds(model) {
  const rows = model.projects.filter((p) => p.builds.length)
    .map((p) => ({ ...p, med: median(p.builds.map((b) => b.duration_s)) }))
    .sort((a, b) => b.med - a.med);
  if (!rows.length) return `<p class="empty">No build runs in the last ${e(model.range.label)}.</p>`;
  const { x, ticks } = timeScale(Math.max(...rows.flatMap((p) => p.builds.map((b) => b.duration_s))));
  // 30s, 2m and 20m crowd their neighbours at phone width, so they are minor.
  const minor = new Set([30, 120, 1200]);
  const axis = ticks.map((t) => `<span class="tick${minor.has(t) ? ' tick-minor' : ''}" style="left:${x(t).toFixed(2)}%">${t ? duration(t) : '0'}</span>`).join('');
  const body = rows.map((p) => {
    const dots = p.builds.map((b) => {
      const tip = `${p.name} · ${SYSTEM_LABEL[b.system]} · ${b.name}\n${duration(b.duration_s)} · ${b.conclusion} · ${shortDate(b.started_at)}`;
      return `<span class="run run-${e(b.system)} run-${e(b.conclusion)}" style="left:${x(b.duration_s).toFixed(2)}%" title="${e(tip)}"></span>`;
    }).join('');
    return `<a class="strip-name" href="#/p/${e(p.name)}">${e(p.name)}</a>
      <span class="strip-track">${dots}<span class="median" style="left:${x(p.med).toFixed(2)}%" title="${e(`median ${duration(p.med)}`)}"></span></span>
      <span class="strip-med">${duration(p.med)}</span>`;
  }).join('\n');
  return `
    <div class="viz strip">
      <div class="viz-head">
        <h3>Time per run</h3>
        <p class="strip-legend">
          <span><span class="run run-github key"></span>GitHub</span>
          <span><span class="run run-cloudflare key"></span>Cloudflare</span>
          <span><span class="run run-success key"></span>passed</span>
          <span><span class="run run-failure key"></span>failed</span>
          <span><span class="run run-cancelled key"></span>cancelled</span>
          <span><span class="median key"></span>median</span>
        </p>
      </div>
      <div class="strip-grid">
        ${body}
        <span></span><span class="strip-axis">${axis}</span><span class="strip-med muted">median</span>
      </div>
    </div>`;
}

function renderTable(model) {
  const row = (name, t, builds) => {
    const med = median(builds.map((b) => b.duration_s));
    const fin = builds.filter((b) => b.conclusion !== 'cancelled');
    const green = fin.length ? `${Math.round((builds.filter((b) => b.conclusion === 'success').length / fin.length) * 100)}%` : '—';
    const n = (v) => v.toLocaleString('en-GB');
    return `<tr><th scope="row">${name}</th><td>${n(t.commits)}</td><td>${n(t.issues)}</td><td>+${n(t.added)}</td><td>−${n(t.deleted)}</td><td>${builds.length}</td><td>${med === null ? '—' : duration(med)}</td><td>${green}</td></tr>`;
  };
  const all = model.projects.reduce((t, p) => {
    for (const k of Object.keys(p.totals)) t[k] = (t[k] ?? 0) + p.totals[k];
    return t;
  }, {});
  return `
    <details class="viz-table">
      <summary>All numbers</summary>
      <div class="table-wrap">
        <table>
          <thead><tr><th scope="col">Project</th><th scope="col">Commits</th><th scope="col">Issues closed</th><th scope="col">Lines added</th><th scope="col">Lines deleted</th><th scope="col">Builds</th><th scope="col">Median build</th><th scope="col">Passed</th></tr></thead>
          <tbody>${model.projects.map((p) => row(e(p.name), p.totals, p.builds)).join('')}</tbody>
          <tfoot>${row('All projects', all, model.projects.flatMap((p) => p.builds))}</tfoot>
        </table>
      </div>
    </details>`;
}

/** The four totals with weekly sparklines, on top of Activity. */
export function renderKpis(sorted) {
  const model = activityModel(sorted);
  if (!model) return '';
  return `
  <section class="panel activity" aria-labelledby="kpi-heading">
    <h2 id="kpi-heading">Last ${model.weeks.length} weeks</h2>
    ${renderTiles(model)}
  </section>`;
}

const modelsFor = (sorted) => RANGES.map((r) => activityModel(sorted, r));

/** The Activity view: the pulse per project, and every number as a table, per range. */
export function renderActivity(sorted) {
  const models = modelsFor(sorted);
  if (!models[0]) return '<p class="empty">No project reports activity yet.</p>';
  const since = (m) => `· ${m.range.label} since ${e(shortDate(m.weeks[0]))}${m.range.unit === 'day' ? ', by day' : ''}`;
  return `
  <section class="panel activity" aria-labelledby="activity-heading">
    <div class="range-head">
      <h2 id="activity-heading" tabindex="-1">Activity <span class="muted">${panes(models, since, 'span')}</span></h2>${rangeSwitch('activity')}
    </div>
    ${renderPulse(models)}
    ${panes(models, renderTable)}
  </section>`;
}

/** The Builds view: every run per project on one time axis, per range. */
export function renderBuildsView(sorted) {
  const models = modelsFor(sorted);
  if (!models[0] || !models.some((m) => m.projects.some((p) => p.builds.length))) return '<p class="empty">No build runs reported yet.</p>';
  return `
  <section class="panel activity" aria-labelledby="builds-heading">
    <div class="range-head">
      <h2 id="builds-heading" tabindex="-1">Builds &amp; deploys <span class="muted">${panes(models, (m) => `· last ${e(m.range.label)}`, 'span')}</span></h2>${rangeSwitch('builds')}
    </div>
    ${panes(models, renderBuilds)}
  </section>`;
}

/**
 * A project's own calendar: one column per week, Monday at the top, each day
 * shaded by commits relative to the project's own busiest day. Days after the
 * data was collected are left blank.
 */
function calendar(days, generatedAt) {
  const byDay = new Map(days.map((d) => [d.date, d]));
  const last = generatedAt.slice(0, 10);
  const weeks = [...new Set(days.map((d) => weekStart(`${d.date}T00:00:00Z`)))].sort();
  const max = Math.max(0, ...days.map((d) => d.commits));
  const cells = [];
  for (let row = 0; row < 7; row++) {
    for (const w of weeks) {
      const date = new Date(`${w}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + row);
      const iso = date.toISOString().slice(0, 10);
      const d = byDay.get(iso);
      if (!d || iso > last) { cells.push('<span class="day day-none"></span>'); continue; }
      const tip = `${dayLabel(iso)}\n${d.commits} commits · ${d.issues_closed} issues closed\n+${d.lines_added} −${d.lines_deleted} lines`;
      cells.push(`<span class="day" data-commits="${level(d.commits, max)}" title="${e(tip)}"></span>`);
    }
  }
  return `<span class="calendar" style="--weeks:${weeks.length}" role="img" aria-label="Commits per day">${cells.join('')}</span>`;
}

/** A project's own row: totals, and its daily calendar (v5) or weekly sparkline (v4). */
export function renderProjectActivity(d) {
  const a = d.activity;
  if (!a) return '';
  const series = a.days ?? a.weeks;
  const t = (fn) => series.reduce((n, w) => n + fn(w), 0);
  const med = median(a.builds.map((b) => b.duration_s));
  const active = a.days ? a.days.filter((x) => x.commits > 0).length : null;
  const parts = [
    `${compact(t((w) => w.commits))} commits`,
    active !== null ? `active ${active} of ${a.days.length} days` : null,
    `${compact(t((w) => w.issues_closed))} issues closed`,
    `<span class="plus">+${compact(t((w) => w.lines_added))}</span> <span class="minus">−${compact(t((w) => w.lines_deleted))}</span> lines`,
    a.builds.length ? `${a.builds.length} builds, median ${duration(med)}` : null,
  ].filter(Boolean);
  const visual = a.days ? calendar(a.days, a.generated_at) : spark(a.weeks.map((w) => w.commits), 'Commits per week');
  const span = `${a.days ? new Set(a.days.map((x) => weekStart(`${x.date}T00:00:00Z`))).size : a.weeks.length} weeks`;
  return `
            <div class="detail">
              <h4>Activity · ${span}</h4>
              <div class="activity-line${a.days ? ' has-calendar' : ''}">${visual}<span>${parts.join(' · ')}</span></div>
            </div>`;
}

/** A project's own runs on a time axis, with pass rate and median. */
export function renderProjectBuilds(d) {
  const builds = d.activity?.builds ?? [];
  if (!builds.length) return '';
  const med = median(builds.map((b) => b.duration_s));
  const { x, ticks } = timeScale(Math.max(...builds.map((b) => b.duration_s)));
  const fin = builds.filter((b) => b.conclusion !== 'cancelled');
  const ok = builds.filter((b) => b.conclusion === 'success').length;
  const failed = builds.filter((b) => b.conclusion === 'failure').sort((a, b) => b.started_at.localeCompare(a.started_at));
  const dots = builds.map((b) => {
    const tip = `${SYSTEM_LABEL[b.system]} · ${b.name}\n${duration(b.duration_s)} · ${b.conclusion} · ${shortDate(b.started_at)}`;
    return `<span class="run run-${e(b.system)} run-${e(b.conclusion)}" style="left:${x(b.duration_s).toFixed(2)}%" title="${e(tip)}"></span>`;
  }).join('');
  // Half the page width: only the ticks that never crowd each other.
  const axis = ticks.filter((t) => ![30, 120, 1200].includes(t)).map((t) => `<span class="tick" style="left:${x(t).toFixed(2)}%">${t ? duration(t) : '0'}</span>`).join('');
  const facts = [
    `${builds.length} runs`,
    `median ${duration(med)}`,
    fin.length ? `${Math.round((ok / fin.length) * 100)}% passed` : null,
    failed.length ? `last failure ${shortDate(failed[0].started_at)}` : null,
  ].filter(Boolean);
  return `
            <div class="detail">
              <h4>Builds &amp; deploys</h4>
              <div class="project-strip activity">
                <span class="strip-track">${dots}<span class="median" style="left:${x(med).toFixed(2)}%" title="${e(`median ${duration(med)}`)}"></span></span>
                <span class="strip-axis">${axis}</span>
              </div>
              <p class="muted">${facts.join(' · ')}</p>
            </div>`;
}
