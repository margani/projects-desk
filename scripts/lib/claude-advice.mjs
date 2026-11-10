// Cheaper ways to run each project's Claude sessions, from how the
// project actually worked over the last 7 days, not from its name:
//   - context: how many tokens each request re-reads, and what share of the
//     project's use that re-reading is;
//   - code: lines changed in git (the status file's `activity`). The tool mix
//     cannot tell coding from ops work, because auto mode edits through
//     Bash/sed (measured 2026-11-04: Bash was 66-100% of every project's calls);
//   - coordination: the share of tool calls that message other sessions;
//   - subagents: the share spent in `subagents/` transcripts (audits).
// Savings use the API list prices in claude-usage.mjs. Sonnet 5.5 reads cache
// at the same $0.20 as Opus 5.5, so a model switch saves only on the part
// that is not re-reading context, and the estimate says so.
//
// Settings named here were checked on 2026-11-04 against code.claude.com/docs:
// `model` in a project's .claude/settings.local.json (settings, model-config)
// and CLAUDE_CODE_SUBAGENT_MODEL (env-vars: "the default model for subagents").

/** Below this share of the week a project is not worth a suggestion. */
const MIN_SHARE = 1;
/** Context a fresh session keeps to between tasks, for the estimate. */
const FRESH_CONTEXT = 150_000;
const LONG_CONTEXT = 200_000;
const CODE_LINES = 3000;
const LIGHT_LINES = 500;

const k = (n) => `${Math.round(n / 1000)}K`;

/** What the project's week looked like, in one phrase. */
export function natureOf(p, lines) {
  if (p.message_share >= 10 && p.output_per_request < 500 && (lines == null || lines <= 200)) {
    return { kind: 'coordinator', text: `Coordination: ${p.message_share}% of its tool calls message other sessions, short replies` };
  }
  if (lines != null && lines >= CODE_LINES) return { kind: 'code', text: `Code: ${lines.toLocaleString('en-GB')} lines changed in 7 days` };
  if (lines != null && lines < LIGHT_LINES && p.requests >= 30) {
    return { kind: 'light', text: `Ops, releases and audits: ${lines.toLocaleString('en-GB')} lines changed in 7 days` };
  }
  if (lines == null) return { kind: 'unknown', text: 'No git activity in its status file' };
  return { kind: 'mixed', text: `${lines.toLocaleString('en-GB')} lines changed in 7 days` };
}

/**
 * @param week summariseUse() over the last 7 days, with the signals.
 * @param linesChanged { project: lines added + deleted in 7 days }; absent = unknown.
 * @returns [{ project, share, models, nature, suggestions: [{ kind, text, how, saving }], saving, saving_of_total }]
 *   saving: % of the project's use; saving_of_total: points of this laptop's week.
 */
/** A model setting names Sonnet: "sonnet", "sonnet[1m]" or a full claude-sonnet-* id. */
const isSonnet = (m) => typeof m === 'string' && /sonnet/i.test(m);

/**
 * The suggestion is already in the project's settings: the owner
 * applied it, and the 7 days of history will show Opus until they age out.
 * Returns { set_at, since } or null; `since` is the use after the change.
 */
function appliedOf(kind, s) {
  if (!s) return null;
  if (kind === 'model' && isSonnet(s.model)) return { set_at: s.model_set_at ?? null, since: s.since ?? null };
  if (kind === 'subagents' && (isSonnet(s.subagent_model) || isSonnet(s.model))) {
    return { set_at: (isSonnet(s.subagent_model) ? s.subagent_set_at : s.model_set_at) ?? null, since: s.since ?? null };
  }
  return null;
}

/**
 * @param settings { project: { model, model_set_at, subagent_model, subagent_set_at,
 *   since: { from, requests, sonnet, sub_sonnet } } } from readModelSettings() and useSince().
 * @param open { project: { context } } from openConversations(), or null when
 *   unknown. The 7 days say a project's sessions ran long; only an open
 *   conversation that is long now makes a fresh one worth it. A project
 *   with none open starts fresh on its next `rc.sh open`, so it is not listed.
 */
export function adviseProjects(week, linesChanged = {}, settings = {}, open = null) {
  const out = [];
  for (const p of week?.projects ?? []) {
    if (p.share < MIN_SHARE || !p.requests) continue;
    const lines = Object.hasOwn(linesChanged, p.name) ? linesChanged[p.name] : null;
    const nature = natureOf(p, lines);
    const read = p.read_share / 100;
    const opus = p.models.find((m) => m.name.startsWith('Opus'))?.of_project ?? 0;
    const fable = p.models.find((m) => m.name.startsWith('Fable') || m.name.startsWith('Mythos'))?.of_project ?? 0;
    const suggestions = [];
    const kindSaving = {};

    let ctx = 0;
    const now = open ? open[p.name]?.context ?? 0 : p.avg_context;
    if (p.avg_context >= LONG_CONTEXT && p.read_share >= 50 && now >= LONG_CONTEXT) {
      ctx = read * (1 - FRESH_CONTEXT / now);
      suggestions.push({
        kind: 'context',
        text: open
          ? `Its open conversation re-reads ${k(now)} tokens of context on each request; re-reading was ${p.read_share}% of its use. Fresh sessions save more here than any model change.`
          : `Each request re-reads ${k(p.avg_context)} tokens of context; that is ${p.read_share}% of its use. Fresh sessions save more here than any model change.`,
        how: `/clear between tasks in its session, or scripts/rc.sh close ${p.name} then open ${p.name}`,
        saving: Math.round(ctx * 100),
      });
    }

    // Opus → Sonnet 5.5 halves input, output and cache writes, not cache reads.
    const sonnetSaving = (opus / 100) * 0.5 * (1 - read);
    let model = 0;
    if ((nature.kind === 'coordinator' || nature.kind === 'light') && opus >= 50) {
      model = sonnetSaving;
      kindSaving.model = model;
      suggestions.push({
        kind: 'model',
        text: nature.kind === 'coordinator'
          ? 'Sonnet 5.5 for the coordinator: it routes work and reads status, the project sessions do the code.'
          : 'Sonnet 5.5: little code changed, mostly ops, releases and audits.',
        how: `"model": "sonnet" in ${p.name}/.claude/settings.local.json, then a new session`,
        saving: Math.round(model * 100),
      });
    } else if (p.sub_share >= 30 && opus >= 50) {
      // A main model on Sonnet already moves its subagents, so only one of the two.
      model = (p.sub_share / 100) * 0.5 * (1 - read);
      kindSaving.subagents = model;
      suggestions.push({
        kind: 'subagents',
        text: `${p.sub_share}% of its use is subagents (audits, searches): Sonnet 5.5 for them, Opus 5.5 stays for the session.`,
        how: `"env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" } in ${p.name}/.claude/settings.local.json`,
        saving: Math.round(model * 100),
      });
    }
    if (fable >= 10) {
      // Fable 5.1 → Opus 5.5: 0.4× input and output, 0.8× cache reads.
      const f = (fable / 100) * ((1 - read) * 0.6 + read * 0.2);
      model = Math.max(model, f);
      kindSaving.fable = f;
      suggestions.push({
        kind: 'fable',
        text: `Fable 5.1 is ${fable}% of its use, at 2.5× Opus 5.5's price per token, with its own weekly limit too. Opus 5.5 unless this work needs Fable.`,
        how: '/model opus in its session',
        saving: Math.round(f * 100),
      });
    }
    // An applied suggestion is listed as such and no longer counts as a saving to be had.
    const raw = { model: kindSaving.model, subagents: kindSaving.subagents, fable: kindSaving.fable };
    for (const sg of suggestions) {
      const a = appliedOf(sg.kind, settings[p.name]);
      if (a) { sg.applied = a; raw[sg.kind] = 0; }
    }
    model = Math.max(raw.model ?? 0, raw.subagents ?? 0, raw.fable ?? 0);
    const saving = 1 - (1 - ctx) * (1 - model);
    out.push({
      project: p.name,
      share: p.share,
      models: p.models.map((m) => m.name),
      nature,
      suggestions,
      saving: Math.round(saving * 100),
      saving_of_total: Math.round(saving * p.share * 10) / 10,
    });
  }
  return out.sort((a, b) => b.saving_of_total - a.saving_of_total);
}
