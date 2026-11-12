// Claude plan usage: the session (5-hour) and weekly limits, and which
// project spent them. The owner ran out a day before the weekly reset in late
// October 2026 with nothing on the dashboard to warn them.
//
// Limits come from the endpoint Claude Code's own /usage reads, called with the
// laptop's Claude login. It is not a documented public API, so every field is
// optional here and a change in its shape becomes a `problem`, never a crash.
// The token is read from the credentials file for the request only: it is
// never logged, stored or returned.
//
// The endpoint has no per-project split, so that comes from Claude Code's
// transcripts (~/.claude/projects/**/*.jsonl, one `message.usage` per request
// with its model and cwd). They can grow by hundreds of MB a week, so they are read incrementally
// from a byte offset kept per file.
import { createReadStream, readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { adviseProjects } from './claude-advice.mjs';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/**
 * API list prices in USD per million tokens (from the claude-api skill's model
 * table, cached 2026-10-06). The plan is not billed per token: these only weigh
 * an Opus token against a Fable one when splitting the week between projects.
 * Cache writes cost 1.25× input (5-minute) and 2× input (1-hour); where the
 * table gives no cache-read price it is 0.1× input.
 */
export const PRICES = [
  ['claude-fable-5', { label: 'Fable 5', input: 10, output: 50, cache_read: 1 }],
  ['claude-fable-5-1', { label: 'Fable 5.1', input: 10, output: 50, cache_read: 0.25 }],
  ['claude-mythos-5-1', { label: 'Mythos 5.1', input: 10, output: 50, cache_read: 0.25 }],
  ['claude-opus-5-5', { label: 'Opus 5.5', input: 4, output: 20, cache_read: 0.2 }],
  ['claude-opus-5', { label: 'Opus 5', input: 5, output: 25, cache_read: 0.5 }],
  ['claude-opus-4', { label: 'Opus 4', input: 5, output: 25, cache_read: 0.5 }],
  ['claude-sonnet-5-5', { label: 'Sonnet 5.5', input: 2, output: 10, cache_read: 0.2 }],
  ['claude-sonnet-5', { label: 'Sonnet 5', input: 2, output: 10, cache_read: 0.2 }],
  ['claude-sonnet-4', { label: 'Sonnet 4', input: 3, output: 15, cache_read: 0.3 }],
  ['claude-haiku-5-5', { label: 'Haiku 5.5', input: 0.1, output: 0.5, cache_read: 0.01 }],
  ['claude-haiku-4', { label: 'Haiku 4.5', input: 1, output: 5, cache_read: 0.1 }],
];

/** The price row for a model id: the longest matching prefix, Opus 5.5 when unknown. */
export function priceOf(model) {
  // Claude Code writes the 1M-context variant as "claude-opus-5-5[1m]".
  model = model?.replace(/\[[^\]]*\]$/, '');
  let best = null;
  for (const [prefix, p] of PRICES) {
    if ((model === prefix || model?.startsWith(`${prefix}-`)) && (!best || prefix.length > best[0].length)) best = [prefix, p];
  }
  return best ? best[1] : { label: model ?? 'unknown', input: 4, output: 20, cache_read: 0.2 };
}

/** One request's tokens → { input, output, cache_write, cache_read, cost } (cost in list-price USD). */
export function weigh(model, u) {
  const p = priceOf(model);
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  const t = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cache_write: w5m + w1h,
    cache_read: u.cache_read_input_tokens ?? 0,
  };
  t.read_cost = (t.cache_read * p.cache_read) / 1e6;
  t.cost = (t.input * p.input + t.output * p.output + w5m * p.input * 1.25 + w1h * p.input * 2) / 1e6 + t.read_cost;
  return t;
}

/** "default_claude_max_5x" → "Max 5x"; null when unknown. */
export function planName(subscriptionType, tier) {
  const m = /max_(\d+x)/.exec(tier ?? '');
  if (m) return `Max ${m[1]}`;
  return subscriptionType ? subscriptionType[0].toUpperCase() + subscriptionType.slice(1) : null;
}

const pct = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
// Reset times come as 17:59:59.567 or 18:00:00.433 from one call to the next:
// the nearest minute is the time the limit means.
const iso = (s) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? new Date(Math.round(Date.parse(s) / 60e3) * 60e3).toISOString() : null);

/** The endpoint's answer → the few fields the dashboard shows. Throws when neither limit is there. */
export function normalizeLimits(json) {
  const byKind = (kind) => (Array.isArray(json?.limits) ? json.limits.find((l) => l?.kind === kind) : null);
  const window = (legacy, kind) => {
    const l = byKind(kind);
    const percent = pct(legacy?.utilization ?? l?.percent);
    return percent == null ? null : { percent, resets_at: iso(legacy?.resets_at ?? l?.resets_at) };
  };
  const session = window(json?.five_hour, 'session');
  const weekly = window(json?.seven_day, 'weekly_all');
  if (!session && !weekly) throw new Error('the usage answer has no session or weekly limit');
  if (weekly) {
    const started = iso(json?.seven_day_breakdown?.window_started_at);
    weekly.started_at = started ?? (weekly.resets_at ? new Date(Date.parse(weekly.resets_at) - 7 * 864e5).toISOString() : null);
  }
  const models = (Array.isArray(json?.limits) ? json.limits : [])
    .filter((l) => l?.kind === 'weekly_scoped' && typeof l.percent === 'number')
    .map((l) => ({ name: l.scope?.model?.display_name ?? l.scope?.surface ?? 'Scoped', percent: pct(l.percent), resets_at: iso(l.resets_at) }));
  const surfaces = (json?.seven_day_breakdown?.rows ?? [])
    .filter((r) => typeof r?.percent === 'number' && r.percent > 0)
    .map((r) => ({ name: String(r.display_name ?? r.key), percent: r.percent }));
  return { session, weekly, models, surfaces, extra_usage: json?.extra_usage?.is_enabled ?? null };
}

/**
 * Reads the limits with the laptop's Claude login.
 * @returns {{ limits: object|null, plan: string|null, problem: string|null }}
 */
export async function fetchLimits({ credentialsFile, fetchImpl = fetch, timeoutMs = 15000, now = Date.now() } = {}) {
  let oauth;
  try {
    oauth = JSON.parse(await readFile(credentialsFile, 'utf8')).claudeAiOauth;
  } catch (err) {
    return { limits: null, plan: null, problem: `Could not read the Claude login (${err.code ?? err.message})` };
  }
  const plan = planName(oauth?.subscriptionType, oauth?.rateLimitTier);
  if (!oauth?.accessToken) return { limits: null, plan, problem: 'No Claude login on this laptop: run claude and sign in' };
  if (oauth.expiresAt && oauth.expiresAt < now) {
    // Claude Code renews it on its next request; refreshing it here could race
    // a running session over the stored refresh token.
    return { limits: null, plan, problem: 'The Claude login token has expired; it renews the next time a Claude session runs' };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
      signal: ctl.signal,
    });
    const body = await res.text();
    if (res.status === 401 || res.status === 403) return { limits: null, plan, problem: `The usage endpoint refused the Claude login (HTTP ${res.status})` };
    if (!res.ok) return { limits: null, plan, problem: `The usage endpoint answered HTTP ${res.status}` };
    return { limits: normalizeLimits(JSON.parse(body)), plan, problem: null };
  } catch (err) {
    return { limits: null, plan, problem: err.name === 'AbortError' ? `The usage endpoint did not answer within ${timeoutMs / 1000} s` : `Could not read the usage endpoint: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

const worktreeRepo = new Map();
/** A sibling worktree (~/projects/foo-wt) counts as its repository (foo). */
function repoName(dir) {
  if (worktreeRepo.has(dir)) return worktreeRepo.get(dir);
  let name = path.basename(dir);
  try {
    const m = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/m.exec(readFileSync(path.join(dir, '.git'), 'utf8'));
    if (m) name = path.basename(m[1]);
  } catch { /* a normal checkout, or not a repository */ }
  worktreeRepo.set(dir, name);
  return name;
}

/** The project a transcript's cwd belongs to: ~/projects/<group>/<name>/… → name. */
export function projectOf(cwd, home) {
  if (!cwd) return 'unknown';
  if (cwd === home) return 'home';
  const rel = path.relative(path.join(home, 'projects'), cwd);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const [group, name] = rel.split(path.sep);
    return name ? repoName(path.join(home, 'projects', group, name)) : group;
  }
  return path.basename(cwd) || 'unknown';
}

const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);
const KEEP_MS = 8 * 864e5;

async function listTranscripts(dir) {
  const out = [];
  async function walk(d, depth) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  await walk(dir, 0);
  return out;
}

function add(into, t) {
  for (const k of ['input', 'output', 'cache_write', 'cache_read', 'cost', 'read_cost', 'sub_cost', 'requests']) into[k] = (into[k] ?? 0) + (t[k] ?? 0);
}

/** Tool calls that hand work to or read from other sessions: a coordinator's day. */
const MESSAGE_TOOLS = new Set(['SendMessage', 'SendToProject', 'SendToProjectContext', 'ListAgents', 'FetchInboxMessage', 'ReadNotifications']);

/**
 * Bump when the scan records a new field: a state from an older version is
 * dropped and the last 8 days are read again, so no project is half-counted.
 */
export const SCAN_VERSION = 4;

/**
 * Adds the transcript lines written since the last run to `state` (mutated
 * and returned): { version, files: { path: { offset, last_id } },
 * hours: { 'YYYY-MM-DDTHH': { project: { model: tokens } } },
 * tools: { 'YYYY-MM-DDTHH': { project: { total, message } } } }.
 * A main conversation's file also keeps its project, the time of its last
 * request, that request's context and model (`last_at`, `context`, `model`):
 * the 7-day
 * average cannot tell a long conversation that ended from one still open.
 * `sub_cost` is the part spent by subagents (their transcripts sit in a
 * `subagents/` folder); `requests` and the input tokens give the context size.
 * Only whole lines are read; a line still being written is read next time.
 * A request's content blocks are separate lines with the same message id and
 * the same usage, so only the first line of each id counts.
 */
export async function scanTranscripts({ dir, home, state = {}, now = Date.now() }) {
  if (state.version !== SCAN_VERSION) state = { version: SCAN_VERSION };
  state.files ??= {};
  state.hours ??= {};
  state.tools ??= {};
  const since = now - KEEP_MS;
  let lines = 0;
  let read = 0;
  const seenFiles = new Set();
  for (const file of await listTranscripts(dir)) {
    let st;
    try { st = await stat(file); } catch { continue; }
    seenFiles.add(file);
    const prev = state.files[file] ?? { offset: 0, last_id: null };
    if (st.mtimeMs < since && !state.files[file]) continue;
    // A file that shrank was rewritten: start over rather than read garbage.
    const start = st.size < prev.offset ? 0 : prev.offset;
    if (st.size === start) { state.files[file] = prev; continue; }
    let offset = start;
    let lastId = prev.last_id;
    let conv = { project: prev.project, last_at: prev.last_at, context: prev.context, model: prev.model };
    const isSub = file.split(path.sep).includes('subagents');
    const rl = readline.createInterface({ input: createReadStream(file, { start, end: st.size - 1 }), crlfDelay: Infinity });
    let pending = start;
    for await (const line of rl) {
      const lineEnd = pending + Buffer.byteLength(line) + 1;
      if (lineEnd > st.size) break; // no newline yet: written but not finished
      pending = lineEnd;
      offset = lineEnd;
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const m = row.message;
      if (row.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') continue;
      const at = Date.parse(row.timestamp);
      if (!(at >= since)) continue;
      const project = projectOf(row.cwd, home);
      // Each content block is its own line, so tool calls count on every line.
      const calls = Array.isArray(m.content) ? m.content.filter((c) => c?.type === 'tool_use') : [];
      if (calls.length) {
        const tc = ((state.tools[hourKey(at)] ??= {})[project] ??= { total: 0, message: 0 });
        tc.total += calls.length;
        tc.message += calls.filter((c) => MESSAGE_TOOLS.has(c.name)).length;
      }
      if (m.id && m.id === lastId) continue;
      lastId = m.id ?? lastId;
      const t = weigh(m.model, m.usage);
      t.requests = 1;
      if (isSub) t.sub_cost = t.cost;
      else if (!(at < (conv.last_at ?? 0))) conv = { project, last_at: at, model: m.model, context: (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0) };
      add(((state.hours[hourKey(at)] ??= {})[project] ??= {})[m.model] ??= {}, t);
      lines++;
    }
    read += offset - start;
    state.files[file] = conv.last_at == null ? { offset, last_id: lastId } : { offset, last_id: lastId, ...conv };
  }
  for (const f of Object.keys(state.files)) if (!seenFiles.has(f)) delete state.files[f];
  for (const k of ['hours', 'tools']) for (const h of Object.keys(state[k])) if (Date.parse(`${h}:00:00Z`) < since - 3600e3) delete state[k][h];
  return { state, lines, bytes: read };
}

/**
 * The conversations open right now, by project: { project: { context,
 * last_at, file, model } } (model: the last request's), the largest when a project has several sessions.
 * A session is ~/.claude/sessions/<pid>.json; it is open while that pid runs
 * and its start time in /proc matches `procStart` (files of sessions that
 * ended, even before a reboot, stay behind with a reused or dead pid).
 * Its conversation is the project's newest main transcript with a request
 * since the session started: a fresh one, a resumed one, or the one /clear
 * began. A session with no request yet counts as context 0.
 * Returns null when the sessions folder cannot be read: unknown, not "none".
 */
export async function openConversations({ sessionsDir, home, files = {}, procDir = '/proc' }) {
  let names;
  try { names = (await readdir(sessionsDir)).filter((f) => /^\d+\.json$/.test(f)); } catch { return null; }
  const out = {};
  for (const f of names) {
    let s;
    try { s = JSON.parse(await readFile(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
    let started;
    try { started = (await readFile(path.join(procDir, String(s.pid), 'stat'), 'utf8')).replace(/^.*\) /s, '').split(' ')[19]; } catch { continue; }
    if (s.procStart != null && String(s.procStart) !== started) continue;
    const project = projectOf(s.cwd, home);
    let best = null;
    for (const [file, c] of Object.entries(files)) {
      if (c.project !== project || c.last_at == null || c.last_at < (s.startedAt ?? 0)) continue;
      if (!best || c.last_at > best.last_at) best = { context: c.context, last_at: c.last_at, file, model: c.model ?? null };
    }
    best ??= { context: 0, last_at: null, file: null, model: null };
    if (!out[project] || best.context > out[project].context) out[project] = best;
  }
  return out;
}

/**
 * Use between two times → projects (biggest first, with their models and the
 * signals the suggestions read) and models.
 */
export function summariseUse(hours, from, to, tools = {}) {
  const inRange = (h) => { const at = Date.parse(`${h}:00:00Z`); return !(at + 3600e3 <= from || at >= to); };
  const projects = new Map();
  const models = new Map();
  let total = 0;
  for (const [h, byProject] of Object.entries(hours ?? {})) {
    if (!inRange(h)) continue;
    for (const [project, byModel] of Object.entries(byProject)) {
      for (const [model, t] of Object.entries(byModel)) {
        const label = priceOf(model).label;
        const p = projects.get(project) ?? { name: project, cost: 0, output: 0, models: {}, requests: 0, context: 0, read_cost: 0, sub_cost: 0 };
        p.cost += t.cost;
        p.output += t.output;
        p.requests += t.requests ?? 0;
        p.context += (t.input ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0);
        p.read_cost += t.read_cost ?? 0;
        p.sub_cost += t.sub_cost ?? 0;
        p.models[label] = (p.models[label] ?? 0) + t.cost;
        projects.set(project, p);
        const mm = models.get(label) ?? { name: label, cost: 0, output: 0 };
        mm.cost += t.cost;
        mm.output += t.output;
        models.set(label, mm);
        total += t.cost;
      }
    }
  }
  const calls = new Map();
  for (const [h, byProject] of Object.entries(tools ?? {})) {
    if (!inRange(h)) continue;
    for (const [project, c] of Object.entries(byProject)) {
      const x = calls.get(project) ?? { total: 0, message: 0 };
      x.total += c.total;
      x.message += c.message;
      calls.set(project, x);
    }
  }
  const share = (c) => (total ? Math.round((c / total) * 1000) / 10 : 0);
  const round = (c) => Math.round(c * 100) / 100;
  const part = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  return {
    total_cost: round(total),
    projects: [...projects.values()].sort((a, b) => b.cost - a.cost).map((p) => ({
      name: p.name, share: share(p.cost), cost: round(p.cost), output: p.output,
      models: Object.entries(p.models).sort((a, b) => b[1] - a[1]).map(([name, c]) => ({ name, share: share(c), of_project: part(c, p.cost) })),
      requests: p.requests,
      avg_context: p.requests ? Math.round(p.context / p.requests) : 0,
      output_per_request: p.requests ? Math.round(p.output / p.requests) : 0,
      read_share: part(p.read_cost, p.cost),
      sub_share: part(p.sub_cost, p.cost),
      message_share: part(calls.get(p.name)?.message ?? 0, calls.get(p.name)?.total ?? 0),
    })),
    models: [...models.values()].sort((a, b) => b.cost - a.cost).map((m) => ({ name: m.name, share: share(m.cost), cost: round(m.cost), output: m.output })),
  };
}

/**
 * Where the weekly limit is heading at this week's average rate.
 * @returns {null | { elapsed, projected, run_out_at, per_day_left, last_24h }}
 *   projected: % at the reset; run_out_at: ISO time 100% is reached before the
 *   reset (null if it is not); per_day_left: % a day that lasts to the reset;
 *   last_24h: points used in the last 24 hours, from the history.
 */
export function weeklyPace(weekly, now, history = []) {
  if (!weekly?.started_at || !weekly.resets_at || weekly.percent == null) return null;
  const start = Date.parse(weekly.started_at);
  const end = Date.parse(weekly.resets_at);
  if (!(end > start) || now <= start) return null;
  const elapsed = Math.min(1, (now - start) / (end - start));
  const daysLeft = Math.max(0, (end - now) / 864e5);
  const out = {
    elapsed: Math.round(elapsed * 1000) / 1000,
    projected: null,
    run_out_at: null,
    per_day_left: daysLeft > 0 ? Math.round(Math.max(0, 100 - weekly.percent) / daysLeft) : null,
    last_24h: null,
  };
  // Too early in the week (under ~8 hours) the average says nothing.
  if (elapsed >= 0.05) {
    out.projected = Math.round(weekly.percent / elapsed);
    if (weekly.percent > 0) {
      const at = start + (100 / weekly.percent) * (now - start);
      if (at < end) out.run_out_at = new Date(at).toISOString();
    }
  }
  const dayAgo = now - 864e5;
  const old = history.filter((h) => Date.parse(h.at) <= dayAgo && Date.parse(h.at) >= start && h.weekly != null).at(-1);
  if (old && dayAgo - Date.parse(old.at) < 3 * 3600e3) out.last_24h = Math.round((weekly.percent - old.weekly) * 10) / 10;
  else if (now - start <= 864e5 + 3600e3) out.last_24h = weekly.percent;
  return out;
}

/** Keeps one sample per half hour for 8 days, for the last-24-hours figure. */
export function addSample(history = [], limits, now) {
  const at = new Date(now).toISOString();
  const kept = history.filter((h) => Date.parse(h.at) >= now - KEEP_MS);
  const last = kept.at(-1);
  const sample = { at, session: limits?.session?.percent ?? null, weekly: limits?.weekly?.percent ?? null };
  if (last && now - Date.parse(last.at) < 30 * 60e3) kept[kept.length - 1] = { ...sample, at: last.at };
  else kept.push(sample);
  return kept;
}

/**
 * usage/claude.json from this run's reading and the previous file: a failed
 * reading keeps the last good limits with their read_at, like Storage.
 */
/**
 * `model` and CLAUDE_CODE_SUBAGENT_MODEL for each project folder under
 * ~/projects/<group>/<name>. Claude Code merges the user-level
 * ~/.claude/settings.json, then the project's .claude/settings.json, then
 * settings.local.json on top; so does this. Reading only the project files
 * kept advising "subagents on Sonnet" for projects that the user-level
 * setting already covered (#13). The time is the mtime of the file that sets
 * the value, the best "since" there is.
 * Keyed like the transcripts (projectOf), so a worktree's settings do not count.
 */
export async function readModelSettings({ home }) {
  const out = {};
  const apply = async (s, file) => {
    let text, st;
    try { [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]); } catch { return; }
    let j;
    try { j = JSON.parse(text); } catch { return; }
    const at = new Date(st.mtimeMs).toISOString();
    if (typeof j.model === 'string') { s.model = j.model; s.model_set_at = at; }
    const sub = j.env?.CLAUDE_CODE_SUBAGENT_MODEL;
    if (typeof sub === 'string') { s.subagent_model = sub; s.subagent_set_at = at; }
  };
  const user = {};
  await apply(user, path.join(home, '.claude', 'settings.json'));
  const base = path.join(home, 'projects');
  let groups = [];
  try { groups = await readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const g of groups.filter((d) => d.isDirectory())) {
    let dirs = [];
    try { dirs = await readdir(path.join(base, g.name), { withFileTypes: true }); } catch { continue; }
    for (const d of dirs.filter((x) => x.isDirectory())) {
      const dir = path.join(base, g.name, d.name);
      const s = { ...user };
      for (const f of ['settings.json', 'settings.local.json']) await apply(s, path.join(dir, '.claude', f));
      const name = projectOf(dir, home);
      if (Object.keys(s).length && !out[name]) out[name] = s;
    }
  }
  return out;
}

/**
 * The project's use after `at`, from the first whole hour after it (the
 * hour of the change mixes both models): requests, and the share on Sonnet
 * of all of it and of its subagents. Null shares mean nothing ran yet.
 */
export function useSince(hours, project, at, now = Date.now()) {
  const from = Math.ceil(Date.parse(at) / 3600e3) * 3600e3;
  let requests = 0, cost = 0, sonnet = 0, sub = 0, subSonnet = 0;
  for (const [h, byProject] of Object.entries(hours ?? {})) {
    const t0 = Date.parse(`${h}:00:00Z`);
    if (t0 < from || t0 >= now) continue;
    for (const [model, t] of Object.entries(byProject[project] ?? {})) {
      const son = /sonnet/i.test(model);
      requests += t.requests ?? 0;
      cost += t.cost ?? 0;
      sub += t.sub_cost ?? 0;
      if (son) { sonnet += t.cost ?? 0; subSonnet += t.sub_cost ?? 0; }
    }
  }
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
  return { from: new Date(from).toISOString(), requests, sonnet: pct(sonnet, cost), sub_sonnet: pct(subSonnet, sub) };
}

export function buildClaudeUsage({ fetched, previous = null, hours, tools = {}, linesChanged = {}, settings = {}, open = null, now = Date.now() }) {
  const generated_at = new Date(now).toISOString();
  const limits = fetched.limits ?? previous?.limits ?? null;
  const read_at = fetched.limits ? generated_at : previous?.read_at ?? null;
  const history = fetched.limits ? addSample(previous?.history, fetched.limits, now) : previous?.history ?? [];
  const from = limits?.weekly?.started_at ? Date.parse(limits.weekly.started_at) : now - 7 * 864e5;
  return {
    generated_at,
    read_at,
    plan: fetched.plan ?? previous?.plan ?? null,
    problem: fetched.problem,
    limits,
    history,
    week: { from: new Date(from).toISOString(), ...summariseUse(hours, from, now, tools) },
    // The model each open conversation runs now: the week's split is
    // history, and a project switched to Opus still shows last week's Fable.
    now_models: open ? Object.fromEntries(Object.entries(open).filter(([, o]) => o.model).map(([p, o]) => [p, priceOf(o.model).label])) : null,
    day: summariseUse(hours, now - 864e5, now),
    // Advice reads a full week of use, so a Monday evening still has a basis.
    advice: adviseProjects(summariseUse(hours, now - 7 * 864e5, now, tools), linesChanged, Object.fromEntries(Object.entries(settings).map(([p, s]) => {
      const at = [s.model_set_at, s.subagent_set_at].filter(Boolean).sort().at(-1);
      return [p, at ? { ...s, since: useSince(hours, p, at, now) } : s];
    })), open),
  };
}
