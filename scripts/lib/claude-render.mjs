// Claude plan usage (usage/claude.json) on its own tab, and a line
// on the Overview while a limit is near or the week is on pace to run out
// before its reset.
import { escapeHtml as e, relativeTime } from './render.mjs';
import { weeklyPace } from './claude-usage.mjs';

const NEAR = 80;

/** 'over' | 'near' | 'pace' | 'ok' for a limit in percent. */
export function claudeLevel(percent, pace = null) {
  if (percent == null) return 'unknown';
  if (percent >= 100) return 'over';
  if (percent >= NEAR) return 'near';
  return pace?.run_out_at ? 'pace' : 'ok';
}

const LABEL = { over: 'Limit reached', near: 'Near the limit', pace: 'On pace to run out' };
const at = (iso) => `<time datetime="${e(iso)}" data-abs>${e(iso.slice(0, 16).replace('T', ' '))} UTC</time>`;
const rel = (iso, now) => `<time datetime="${e(iso)}" data-rel title="${e(iso)}">${e(relativeTime(iso, now))}</time>`;
const n1 = (x) => (Math.round(x * 10) / 10).toLocaleString('en-GB');

function meter(name, percent, level, sub) {
  const flag = LABEL[level] ? `<span class="meter-flag">${LABEL[level]}</span>` : '';
  const text = percent == null ? '?' : `${n1(percent)}%`;
  return `
      <div class="meter" data-level="${level}">
        <div class="meter-head"><span class="meter-name">${e(name)}</span><span class="meter-value">${text} used</span></div>
        <span class="meter-track" role="img" aria-label="${e(`${name}: ${text} used`)}"><span class="meter-fill" style="width:${Math.min(100, percent ?? 0).toFixed(1)}%"></span></span>
        ${flag || sub ? `<p class="meter-sub">${flag}${sub}</p>` : ''}
      </div>`;
}

function weeklySub(w, pace, now) {
  // The run-out time leads: it is what the meter is for.
  const parts = [];
  if (pace?.run_out_at) parts.push(`<b>Runs out ${rel(pace.run_out_at, now)}</b> at this week's pace (${pace.projected}% by the reset)`);
  if (w.resets_at) parts.push(`${pace?.run_out_at ? 'resets' : 'Resets'} ${rel(w.resets_at, now)}, ${at(w.resets_at)}`);
  if (pace) {
    if (!pace.run_out_at && pace.projected != null) parts.push(`on pace for ${pace.projected}% by the reset`);
    parts.push(`${n1(pace.elapsed * 7)} of 7 days gone`);
    if (pace.last_24h != null) parts.push(`${n1(pace.last_24h)}% in the last 24 h`);
    if (pace.per_day_left != null && w.percent < 100) parts.push(`keep under ${pace.per_day_left}% a day to last`);
  }
  return parts.join(' · ');
}

/** This week's split by project: one bar per project, models beside it. */
function renderProjects(week, projectNames, nowModels = null) {
  const rows = (week?.projects ?? []).filter((p) => p.share >= 0.5);
  if (!rows.length) return '';
  const max = rows[0].share;
  const items = rows.map((p) => {
    const name = projectNames.has(p.name) ? `<a href="#/p/${e(p.name)}">${e(p.name)}</a>` : e(p.name);
    // With more than one model, say which one an open conversation runs now,
    // first: on a phone the line is cut off after a model or two.
    const cur = nowModels?.[p.name];
    const models = p.models.length > 1 || p.models[0]?.name !== 'Opus 5.5' ? ` <span class="repo-free">${cur ? `<b>now ${e(cur)}</b> · ` : ''}${p.models.map((m) => `${e(m.name)}${p.models.length > 1 ? ` ${n1(m.share)}%` : ''}`).join(' · ')}</span>` : '';
    return `
          <li><span class="repo-name">${name}${models}</span><span class="repo-bar"><span style="width:${((p.share / max) * 100).toFixed(1)}%"></span></span><span class="repo-min">${n1(p.share)}%</span></li>`;
  }).join('');
  return `
      <details class="repo-usage claude-projects" open>
        <summary>This week by project · ${rows.length}</summary>
        <ul>${items}
        </ul>
      </details>`;
}

/**
 * Cheaper ways to run the projects, in two parts: a cheaper model where
 * the project's week says it fits (what the owner asked for), then the
 * projects whose long sessions cost more than any model change would save.
 */
/** HTML: every part is escaped or a <time> from rel(). */
function appliedText(s, now) {
  const what = s.kind === 'subagents' ? 'Subagents on Sonnet' : 'Sonnet 5.5';
  const set = s.applied.set_at ? `${what}, set ${rel(s.applied.set_at, now)}` : `${what} is set`;
  const since = s.applied.since;
  const share = s.kind === 'subagents' ? since?.sub_sonnet : since?.sonnet;
  if (!since || !since.requests) return `${set}. No requests since then yet.`;
  if (share == null) return `${set}. ${since.requests} requests since, none of them subagents yet.`;
  const tail = share >= 90 ? '' : ' A session opened before the change is still on the old model.';
  return `${set}. Since then ${share}% of its ${s.kind === 'subagents' ? 'subagent use' : 'use'} ran on Sonnet.${tail}`;
}

function renderAdvice(advice, projectNames, now) {
  const list = (advice ?? []).filter((a) => a.saving_of_total >= 0.2);
  const link = (p) => (projectNames.has(p) ? `<a href="#/p/${e(p)}">${e(p)}</a>` : e(p));
  const head = (a) => `<span class="advice-name">${link(a.project)}</span> <span class="repo-free">${e(a.models.join(' · '))} · ${n1(a.share)}% of the 7 days</span>`;
  const models = list.flatMap((a) => a.suggestions.filter((s) => s.kind !== 'context' && !s.applied).map((s) => ({ a, s })))
    .sort((x, y) => y.s.saving * y.a.share - x.s.saving * x.a.share).slice(0, 8);
  const ctx = list.flatMap((a) => a.suggestions.filter((s) => s.kind === 'context').map((s) => ({ a, s })))
    .sort((x, y) => y.s.saving * y.a.share - x.s.saving * x.a.share).slice(0, 8);
  const keep = (advice ?? []).filter((a) => a.nature.kind === 'code' && !a.suggestions.some((s) => s.kind === 'model' || s.kind === 'fable')).map((a) => a.project);
  // Applied in the project's settings: the 7 days still show the old model.
  const applied = (advice ?? []).flatMap((a) => a.suggestions.filter((s) => s.applied).map((s) => ({ a, s })));
  if (!models.length && !ctx.length && !applied.length) return '';
  const total = Math.round(list.reduce((n, a) => n + a.saving_of_total, 0));
  const pts = (x) => n1((x.s.saving * x.a.share) / 100);
  return `
    <div class="usage-account claude-advice">
      <h3>Cheaper ways${total ? ` <span class="muted">· about ${total}% of the last 7 days back</span>` : ''}</h3>
      ${models.length ? `
      <h4>Cheaper model</h4>
      <ol class="advice-list">${models.map((x) => `
        <li>
          <p class="advice-head">${head(x.a)}<span class="advice-save" title="${pts(x)} points of the 7 days">−${x.s.saving}%</span></p>
          <p class="advice-nature">${e(x.a.nature.text)}</p>
          <p class="advice-text">${e(x.s.text)}</p>
          <code>${e(x.s.how)}</code>
        </li>`).join('')}
      </ol>` : ''}
      ${applied.length ? `
      <h4>Already set <span class="muted">· the 7 days above still count the old model</span></h4>
      <ul class="advice-ctx">${applied.map((x) => `
        <li><span class="advice-name">${link(x.a.project)}</span><span class="advice-ctx-why">${appliedText(x.s, now)}</span></li>`).join('')}
      </ul>
      <p class="meter-sub">A session opened before the change keeps its model: <code>scripts/rc.sh close &lt;project&gt;</code> then <code>open &lt;project&gt;</code>.</p>` : ''}
      ${keep.length ? `<p class="usage-billed">Keep Opus 5.5 for the code-heavy ones: ${keep.map(link).join(', ')}.</p>` : ''}
      ${ctx.length ? `
      <h4>Fresh sessions <span class="muted">· open conversations that are long now</span></h4>
      <ul class="advice-ctx">${ctx.map((x) => `
        <li><span class="advice-name">${link(x.a.project)}</span><span class="advice-ctx-why">${e(x.s.text.replace(/ Fresh sessions save more here than any model change\.$/, ''))}</span><span class="advice-save" title="${pts(x)} points of the 7 days">−${x.s.saving}%</span></li>`).join('')}
      </ul>
      <p class="meter-sub">In each: <code>/clear</code> between tasks, or <code>scripts/rc.sh close &lt;project&gt;</code> then <code>open &lt;project&gt;</code> for a new conversation.</p>` : ''}
      <p class="meter-sub">From each project's last 7 days. Savings are a share of that project's use, by API list price; Anthropic does not publish how each model counts against the plan.</p>
    </div>`;
}

/** @param sorted status entries, to link a project to its page */
export function renderClaude(usage, now, sorted = []) {
  if (!usage) return '';
  const l = usage.limits;
  const projectNames = new Set(sorted.filter((x) => x.ok).map((x) => x.data.project));
  const head = `<h2 id="claude-heading">Claude usage${usage.plan ? ` <span class="muted">· ${e(usage.plan)}</span>` : ''}</h2>`;
  const stale = usage.problem
    ? `<p class="usage-problem">${e(usage.problem)}${l && usage.read_at ? ` · showing the reading from ${rel(usage.read_at, now)}` : ''}</p>`
    : '';
  if (!l) return `
  <section class="panel usage claude-usage" aria-labelledby="claude-heading">
    ${head}${stale || '<p class="usage-problem">No reading yet.</p>'}
  </section>`;
  const pace = weeklyPace(l.weekly, now, usage.history);
  const cards = [];
  const limitsCard = [];
  if (l.weekly) limitsCard.push(meter('This week', l.weekly.percent, claudeLevel(l.weekly.percent, pace), weeklySub(l.weekly, pace, now)));
  if (l.session) limitsCard.push(meter('Current session (5 h)', l.session.percent, claudeLevel(l.session.percent), l.session.resets_at ? `Resets ${rel(l.session.resets_at, now)}, ${at(l.session.resets_at)}` : ''));
  for (const m of l.models ?? []) limitsCard.push(meter(`${m.name} this week`, m.percent, claudeLevel(m.percent), 'Its own weekly limit, beside the one above'));
  cards.push(`
    <div class="usage-account">
      <h3>Plan limits</h3>${stale}${limitsCard.join('')}
      ${l.surfaces?.length ? `<p class="usage-billed">This week: ${l.surfaces.map((s) => `${e(s.name)} ${s.percent}%`).join(' · ')}</p>` : ''}
    </div>`);
  const week = usage.week;
  if (week?.projects?.length) {
    cards.push(`
    <div class="usage-account">
      <h3>Who used it <span class="muted">· since the week began</span></h3>
      ${week.models.length ? `<p class="usage-billed">${week.models.filter((m) => m.share >= 0.5).map((m) => `${e(m.name)} ${n1(m.share)}%`).join(' · ')}</p>` : ''}
      ${renderProjects(week, projectNames, usage.now_models)}
      ${usage.day?.projects?.length ? `<p class="usage-billed">Last 24 h: ${usage.day.projects.slice(0, 3).map((p) => `${e(p.name)} ${n1(p.share)}%`).join(' · ')}</p>` : ''}
    </div>`);
  }
  const advice = renderAdvice(usage.advice, projectNames, now);
  return `
  <section class="panel usage claude-usage" aria-labelledby="claude-heading">
    ${head}
    <div class="usage-grid">${cards.join('')}
    </div>${advice}
    <p class="viz-foot"><span>Limits as Claude's /usage shows them. The split by project is this laptop's Claude Code sessions, weighed by API list price so a Fable token counts more than an Opus one; Chats and Cowork are not in it.</span><span>Read ${rel(usage.read_at ?? usage.generated_at, now)}</span></p>
  </section>`;
}

/** Overview line: only while a limit is near or the week runs out before its reset. */
export function renderClaudeAlert(usage, now) {
  const l = usage?.limits;
  if (!l) return '';
  const hits = [];
  const pace = weeklyPace(l.weekly, now, usage.history);
  const wl = claudeLevel(l.weekly?.percent, pace);
  if (wl === 'over') hits.push(`weekly limit reached, resets ${relativeTime(l.weekly.resets_at, now)}`);
  else if (wl === 'near') hits.push(`${n1(l.weekly.percent)}% of the week used, resets ${relativeTime(l.weekly.resets_at, now)}`);
  else if (wl === 'pace') hits.push(`${n1(l.weekly.percent)}% of the week used: runs out ${relativeTime(pace.run_out_at, now)}, the reset is ${relativeTime(l.weekly.resets_at, now)}; keep under ${pace.per_day_left}% a day`);
  const sl = claudeLevel(l.session?.percent);
  if (sl === 'over' || sl === 'near') hits.push(`session ${n1(l.session.percent)}%, resets ${relativeTime(l.session.resets_at, now)}`);
  for (const m of l.models ?? []) {
    const ml = claudeLevel(m.percent);
    if (ml === 'over' || ml === 'near') hits.push(`${m.name} ${n1(m.percent)}% of its weekly limit`);
  }
  if (!hits.length) return '';
  return `
    <a class="usage-alert" href="#/claude"><span class="meter-flag">Claude limits</span>${hits.map(e).join(' · ')}</a>`;
}
