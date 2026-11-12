import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeLimits, fetchLimits, scanTranscripts, summariseUse, weeklyPace, buildClaudeUsage, priceOf, weigh, planName, projectOf } from '../scripts/lib/claude-usage.mjs';
import { renderClaude, renderClaudeAlert } from '../scripts/lib/claude-render.mjs';
import { build } from '../scripts/build.mjs';

// The shape the usage endpoint answered on 2026-11-04 (trimmed to what is read).
const answer = (weekly = 33, session = 12) => ({
  five_hour: { utilization: session, resets_at: '2026-11-04T13:00:00.433812+00:00' },
  seven_day: { utilization: weekly, resets_at: '2026-11-09T18:00:00.433833+00:00' },
  seven_day_opus: null,
  extra_usage: { is_enabled: false },
  limits: [
    { kind: 'session', percent: session, resets_at: '2026-11-04T13:00:00.433812+00:00' },
    { kind: 'weekly_all', percent: weekly, resets_at: '2026-11-09T18:00:00.433833+00:00' },
    { kind: 'weekly_scoped', percent: 4, resets_at: '2026-11-09T18:00:00.434007+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ],
  seven_day_breakdown: {
    window_started_at: '2026-11-02T18:00:00.433833+00:00',
    rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 91 }, { key: 'chat', display_name: 'Chats', percent: 0 }, { key: 'cowork', display_name: 'Cowork', percent: 9 }],
  },
});
// 4 Nov 10:00 UTC: 1 day 16 hours into the week.
const now = Date.parse('2026-11-04T10:00:00Z');

test('claude: the endpoint answer becomes session, weekly, per-model limits and surfaces', () => {
  const l = normalizeLimits(answer());
  assert.deepEqual(l.session, { percent: 12, resets_at: '2026-11-04T13:00:00.000Z' });
  assert.deepEqual(l.weekly, { percent: 33, resets_at: '2026-11-09T18:00:00.000Z', started_at: '2026-11-02T18:00:00.000Z' });
  assert.deepEqual(l.models, [{ name: 'Fable', percent: 4, resets_at: '2026-11-09T18:00:00.000Z' }]);
  assert.deepEqual(l.surfaces, [{ name: 'Claude Code', percent: 91 }, { name: 'Cowork', percent: 9 }]);
  // Only the new `limits` list: still read. Neither: a problem, not a crash.
  const onlyList = normalizeLimits({ limits: answer().limits });
  assert.equal(onlyList.weekly.percent, 33);
  assert.equal(onlyList.weekly.started_at, '2026-11-02T18:00:00.000Z');
  assert.throws(() => normalizeLimits({ five_hour: null }), /no session or weekly limit/);
  // 17:59:59.567 on one call and 18:00:00.433 on the next are the same reset.
  assert.equal(normalizeLimits({ seven_day: { utilization: 1, resets_at: '2026-11-09T17:59:59.567+00:00' } }).weekly.resets_at, '2026-11-09T18:00:00.000Z');
  assert.equal(planName('max', 'default_claude_max_5x'), 'Max 5x');
  assert.equal(planName('pro', null), 'Pro');
});

test('claude: the login token goes only into the request, never into the result', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'claude-cred-'));
  const credentialsFile = path.join(dir, 'c.json');
  const token = 'sk-ant-oat01-dummy-token-for-tests';
  await writeFile(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: now + 3600e3, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }));
  let sent;
  const ok = await fetchLimits({ credentialsFile, now, fetchImpl: async (url, opts) => { sent = opts.headers.authorization; return new Response(JSON.stringify(answer())); } });
  assert.equal(sent, `Bearer ${token}`);
  assert.equal(ok.problem, null);
  assert.equal(ok.limits.weekly.percent, 33);
  assert.equal(ok.plan, 'Max 5x');
  assert.ok(!JSON.stringify(ok).includes(token));

  const refused = await fetchLimits({ credentialsFile, now, fetchImpl: async () => new Response('{}', { status: 401 }) });
  assert.match(refused.problem, /refused the Claude login \(HTTP 401\)/);
  assert.ok(!JSON.stringify(refused).includes(token));
  const expired = await fetchLimits({ credentialsFile, now: now + 7200e3, fetchImpl: async () => assert.fail('must not call with an expired token') });
  assert.match(expired.problem, /expired/);
  const missing = await fetchLimits({ credentialsFile: path.join(dir, 'none.json') });
  assert.match(missing.problem, /Could not read the Claude login \(ENOENT\)/);
});

const line = (o) => JSON.stringify(o) + '\n';
const reply = (id, model, cwd, ts, usage) => line({ type: 'assistant', timestamp: ts, cwd, message: { id, model, usage } });

test('claude: transcripts are read once, one line per request, by project and model', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'claude-home-'));
  const dir = path.join(home, '.claude/projects');
  await mkdir(path.join(dir, 'a/s1/subagents'), { recursive: true });
  // A sibling worktree counts as its repository.
  await mkdir(path.join(home, 'projects/personal/nova-wt'), { recursive: true });
  await writeFile(path.join(home, 'projects/personal/nova-wt/.git'), `gitdir: ${home}/projects/personal/nova/.git/worktrees/nova-wt\n`);
  const u = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const f1 = path.join(dir, 'a/s1.jsonl');
  await writeFile(f1,
    reply('m1', 'claude-opus-5-5', `${home}/projects/personal/orion`, '2026-11-04T08:00:00Z', u)
    + reply('m1', 'claude-opus-5-5', `${home}/projects/personal/orion`, '2026-11-04T08:00:00Z', u) // second content block
    + reply('m0', '<synthetic>', `${home}/projects/personal/orion`, '2026-11-04T08:00:00Z', u)
    + reply('old', 'claude-opus-5-5', `${home}/projects/personal/orion`, '2026-10-01T08:00:00Z', u)
    + line({ type: 'user', message: { content: 'hi' } })
    + reply('m2', 'claude-fable-5-1', `${home}/projects/personal/orion/orion`, '2026-11-04T09:00:00Z', u)
    + '{"type":"assistant","message":{"id":"m3","usage"'); // still being written
  await writeFile(path.join(dir, 'a/s1/subagents/x.jsonl'), reply('s1', 'claude-opus-5-5[1m]', `${home}/projects/personal/nova-wt/src`, '2026-11-04T09:30:00Z', u));

  const first = await scanTranscripts({ dir, home, now });
  assert.equal(first.lines, 3);
  const week = summariseUse(first.state.hours, Date.parse('2026-11-02T18:00:00Z'), now);
  assert.deepEqual(week.projects.map((p) => [p.name, p.output]), [['orion', 2000], ['nova', 1000]]);
  // Fable output costs 2.5× Opus output: orion is (20 + 50) of (20 + 50 + 20).
  assert.equal(week.projects[0].share, 77.8);
  assert.deepEqual(week.projects[0].models.map((m) => m.name), ['Fable 5.1', 'Opus 5.5']);
  assert.deepEqual(week.models.map((m) => m.name), ['Fable 5.1', 'Opus 5.5']);

  // The unfinished line is read once it is finished; nothing else twice.
  await appendFile(f1, ':{"input_tokens":0,"output_tokens":500},"model":"claude-opus-5-5"},"timestamp":"2026-11-04T09:40:00Z","cwd":' + JSON.stringify(`${home}/projects/personal/orion`) + '}\n');
  const again = await scanTranscripts({ dir, home, state: first.state, now });
  assert.equal(again.lines, 1);
  assert.equal(summariseUse(again.state.hours, 0, now + 1).projects.find((p) => p.name === 'orion').output, 2500);
  const idle = await scanTranscripts({ dir, home, state: again.state, now });
  assert.equal(idle.lines, 0);
  assert.equal(idle.bytes, 0);
});

test('claude: prices weigh Fable above Opus, cache reads far below input', () => {
  assert.equal(priceOf('claude-opus-5-5[1m]').label, 'Opus 5.5');
  assert.equal(priceOf('claude-fable-5-1').label, 'Fable 5.1');
  assert.equal(priceOf('claude-fable-5').label, 'Fable 5');
  const t = weigh('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 0 } });
  assert.equal(t.cost, 4 + 20 + 0.2 + 8);
  assert.equal(projectOf('/home/x', '/home/x'), 'home');
  assert.equal(projectOf('/home/x/projects/personal', '/home/x'), 'personal');
  assert.equal(projectOf('/tmp/foo', '/home/x'), 'foo');
});

test('claude: pace says when the week runs out and how much a day lasts', () => {
  const { weekly } = normalizeLimits(answer());
  const p = weeklyPace(weekly, now, []);
  // 33% after 40 of 168 hours: 139% by the reset, 100% after ~121 hours.
  assert.equal(p.projected, 139);
  assert.equal(p.run_out_at.slice(0, 13), '2026-11-07T19');
  assert.equal(p.per_day_left, 13);
  assert.equal(p.last_24h, null);
  // A sample from 24 h ago gives the last day's use.
  assert.equal(weeklyPace(weekly, now, [{ at: '2026-11-03T10:00:00Z', weekly: 20 }]).last_24h, 13);
  // On pace for less than 100%: no run-out time.
  assert.equal(weeklyPace({ ...weekly, percent: 20 }, now).run_out_at, null);
  // Too early in the week to project.
  assert.equal(weeklyPace(weekly, Date.parse('2026-11-02T21:00:00Z')).projected, null);
});

const usageAt = (weekly, session = 12, extra = {}) => buildClaudeUsage({
  fetched: { limits: normalizeLimits(answer(weekly, session)), plan: 'Max 5x', problem: null },
  hours: { '2026-11-04T08': { orion: { 'claude-fable-5-1': { input: 0, output: 1000, cache_write: 0, cache_read: 0, cost: 0.05 } }, pingly: { 'claude-opus-5-5': { input: 0, output: 1000, cache_write: 0, cache_read: 0, cost: 0.15 } } } },
  now,
  ...extra,
});

test('claude: Overview line only when the week runs out early or a limit is near', () => {
  assert.match(renderClaudeAlert(usageAt(33), now), /Claude limits.*33% of the week used: runs out in 3 days.*keep under 13% a day/);
  assert.equal(renderClaudeAlert(usageAt(20), now), '');
  assert.match(renderClaudeAlert(usageAt(85), now), /85% of the week used, resets in 5 days/);
  assert.match(renderClaudeAlert(usageAt(20, 90), now), /session 90%/);
  assert.match(renderClaudeAlert(usageAt(100), now), /weekly limit reached/);
  assert.equal(renderClaudeAlert(null, now), '');
});

test('claude: the panel shows limits, pace, models and projects, and keeps the last reading on failure', () => {
  const sorted = [{ ok: true, data: { project: 'orion' } }];
  const html = renderClaude(usageAt(33), now, sorted);
  assert.match(html, /Claude usage <span class="muted">· Max 5x/);
  assert.match(html, /data-level="pace"/);
  assert.match(html, /<b>Runs out <time[^>]*>in 3 days<\/time><\/b> at this week's pace \(139% by the reset\) · resets <time/);
  assert.match(html, /Fable this week/);
  assert.match(html, /Claude Code 91% · Cowork 9%/);
  assert.match(html, /<a href="#\/p\/orion">orion<\/a> <span class="repo-free">Fable 5.1<\/span>/);
  assert.match(html, /pingly<\/span><span class="repo-bar"><span style="width:100.0%"><\/span><\/span><span class="repo-min">75%/);

  const good = usageAt(33);
  const failed = buildClaudeUsage({ fetched: { limits: null, plan: null, problem: 'The usage endpoint answered HTTP 500' }, previous: good, hours: {}, now: now + 600e3 });
  assert.equal(failed.limits.weekly.percent, 33);
  assert.equal(failed.read_at, good.read_at);
  assert.equal(failed.plan, 'Max 5x');
  assert.match(renderClaude(failed, now + 600e3), /answered HTTP 500 · showing the reading from <time/);
  assert.match(renderClaude(buildClaudeUsage({ fetched: { limits: null, plan: null, problem: 'No Claude login' }, hours: {}, now }), now), /No Claude login/);
});

test('claude: build puts the panel on its own tab and the line on the Overview', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'claude-build-'));
  await mkdir(path.join(dir, 'status'));
  const claudeFile = path.join(dir, 'claude.json');
  await writeFile(claudeFile, JSON.stringify(usageAt(33)));
  await build({ statusDir: path.join(dir, 'status'), usageFile: path.join(dir, 'none.json'), storageFile: path.join(dir, 'none.json'), appsFile: path.join(dir, 'none.json'), claudeFile, outDir: path.join(dir, 'dist'), now, log: () => {} });
  const html = await (await import('node:fs/promises')).readFile(path.join(dir, 'dist/index.html'), 'utf8');
  const overview = html.slice(html.indexOf('data-view="overview"'), html.indexOf('data-view="activity"'));
  const builds = html.slice(html.indexOf('data-view="builds"'), html.indexOf('data-view="claude"'));
  const claudeView = html.slice(html.indexOf('data-view="claude"'), html.indexOf('data-view="storage"'));
  assert.match(overview, /<a class="usage-alert" href="#\/claude"><span class="meter-flag">Claude limits/);
  // Its own tab, not on Builds.
  assert.match(claudeView, /id="claude-heading"/);
  assert.doesNotMatch(builds, /claude-heading/);
  // A broken file is left out, never a failed build.
  await writeFile(claudeFile, '{"nope":1}');
  const logs = [];
  await build({ statusDir: path.join(dir, 'status'), usageFile: path.join(dir, 'none.json'), storageFile: path.join(dir, 'none.json'), appsFile: path.join(dir, 'none.json'), claudeFile, outDir: path.join(dir, 'dist'), now, log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /INVALID {2}Claude usage file/.test(m)));
});

test('claude: the scan records subagent spend, coordination calls and context, and re-reads an old state', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'claude-nature-'));
  const dir = path.join(home, '.claude/projects');
  await mkdir(path.join(dir, 'h/s/subagents'), { recursive: true });
  const cwd = `${home}/projects/personal/hub`;
  const u = { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 };
  const call = (id, name) => line({ type: 'assistant', timestamp: '2026-11-04T08:00:00Z', cwd, message: { id, model: 'claude-opus-5-5', usage: u, content: [{ type: 'tool_use', name }] } });
  // Two content blocks of one request: both tool calls count, the usage once.
  await writeFile(path.join(dir, 'h/s.jsonl'), call('a', 'SendMessage') + call('a', 'Bash') + call('b', 'SendToProject'));
  await writeFile(path.join(dir, 'h/s/subagents/x.jsonl'), call('c', 'Read'));
  // A state from before the nature fields had offsets past these lines.
  const old = { files: { [path.join(dir, 'h/s.jsonl')]: { offset: 1e9, last_id: 'b' } }, hours: {} };
  const { state, lines } = await scanTranscripts({ dir, home, state: old, now });
  assert.equal(lines, 3);
  const [p] = summariseUse(state.hours, 0, now + 1, state.tools).projects;
  assert.equal(p.requests, 3);
  assert.equal(p.avg_context, 300000);
  assert.equal(p.message_share, 50);
  assert.equal(p.sub_share, 33);
  // Cache reads: 0.3M × $0.20 = $0.06 of each request's $0.08.
  assert.equal(p.read_share, 75);
});

const proj = (name, extra = {}) => ({ name, share: 10, requests: 200, avg_context: 120000, output_per_request: 900, read_share: 40, sub_share: 0, message_share: 0, models: [{ name: 'Opus 5.5', of_project: 100 }], ...extra });

test('claude: suggestions follow how a project worked, with the setting and the saving', async () => {
  const { adviseProjects } = await import('../scripts/lib/claude-advice.mjs');
  const advice = adviseProjects({ projects: [
    proj('nova', { avg_context: 390000, read_share: 76 }),
    proj('hub', { message_share: 21, output_per_request: 250, read_share: 48 }),
    proj('ops', { sub_share: 47 }),
    proj('ledger', { sub_share: 42 }),
    proj('finder', { models: [{ name: 'Fable 5.1', of_project: 100 }], read_share: 50 }),
    proj('tiny', { share: 0.4 }),
  ] }, { nova: 9061, ops: 310, ledger: 4457, finder: 1200 });
  const by = Object.fromEntries(advice.map((a) => [a.project, a]));
  assert.equal(by.tiny, undefined);

  // Long context: fresh sessions, not a model change, for a code project.
  assert.equal(by.nova.nature.kind, 'code');
  assert.deepEqual(by.nova.suggestions.map((s) => s.kind), ['context']);
  assert.match(by.nova.suggestions[0].text, /re-reads 390K tokens of context; that is 76% of its use/);
  assert.equal(by.nova.suggestions[0].how, '/clear between tasks in its session, or scripts/rc.sh close nova then open nova');
  assert.equal(by.nova.suggestions[0].saving, Math.round(0.76 * (1 - 150 / 390) * 100));

  // No status file, mostly messages: the coordinator moves to Sonnet.
  assert.equal(by.hub.nature.kind, 'coordinator');
  assert.equal(by.hub.suggestions[0].how, '"model": "sonnet" in hub/.claude/settings.local.json, then a new session');
  // Sonnet halves everything but cache reads: 0.5 × (1 − 0.48).
  assert.equal(by.hub.suggestions[0].saving, 26);

  // Little code changed: Sonnet for the session, which covers its subagents.
  assert.equal(by.ops.nature.kind, 'light');
  assert.deepEqual(by.ops.suggestions.map((s) => s.kind), ['model']);
  // Code with heavy subagents: only the subagents move.
  assert.deepEqual(by.ledger.suggestions.map((s) => s.kind), ['subagents']);
  assert.match(by.ledger.suggestions[0].how, /"CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"/);
  assert.equal(by.ledger.suggestions[0].saving, Math.round(0.42 * 0.5 * 0.6 * 100));
  // Fable: back to Opus unless the work needs it.
  assert.equal(by.finder.suggestions[0].kind, 'fable');
  assert.equal(by.finder.suggestions[0].saving, Math.round((0.5 * 0.6 + 0.5 * 0.2) * 100));

  // Biggest saving of the week first.
  assert.deepEqual(advice.map((a) => a.saving_of_total), [...advice.map((a) => a.saving_of_total)].sort((a, b) => b - a));

  const html = renderClaude({ ...usageAt(33), advice }, now, [{ ok: true, data: { project: 'nova' } }]);
  assert.match(html, /<h3>Cheaper ways <span class="muted">· about \d+% of the last 7 days back/);
  assert.match(html, /<a href="#\/p\/nova">nova<\/a>/);
  assert.match(html, /<code>&quot;model&quot;: &quot;sonnet&quot; in hub\/.claude\/settings.local.json, then a new session<\/code>/);
  assert.match(html, /Anthropic does not publish how each model counts against the plan/);
  // Model changes first, the long-context projects as their own short list.
  assert.ok(html.indexOf('<h4>Cheaper model</h4>') < html.indexOf('<h4>Fresh sessions'));
  assert.match(html, /<li><span class="advice-name"><a href="#\/p\/nova">nova<\/a><\/span><span class="advice-ctx-why">Each request re-reads 390K tokens of context; that is 76% of its use.<\/span>/);
  assert.match(html, /Keep Opus 5.5 for the code-heavy ones: <a href="#\/p\/nova">nova<\/a>/);
});

test('claude: a suggestion already in the project settings is listed as set, with the use since', async () => {
  const { adviseProjects } = await import('../scripts/lib/claude-advice.mjs');
  const { readModelSettings, useSince } = await import('../scripts/lib/claude-usage.mjs');
  const home = await mkdtemp(path.join(tmpdir(), 'claude-settings-'));
  const put = async (rel, body) => { await mkdir(path.dirname(path.join(home, rel)), { recursive: true }); await writeFile(path.join(home, rel), JSON.stringify(body)); };
  await put('projects/personal/ops/.claude/settings.local.json', { model: 'sonnet' });
  await put('projects/personal/quill/.claude/settings.json', { model: 'opus' });
  await put('projects/personal/quill/.claude/settings.local.json', { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } });
  await put('projects/personal/nova/.claude/settings.local.json', { permissions: {} });
  const settings = await readModelSettings({ home });
  assert.deepEqual(Object.keys(settings).sort(), ['ops', 'quill']);
  assert.equal(settings.ops.model, 'sonnet');
  assert.equal(settings.quill.model, 'opus');
  assert.equal(settings.quill.subagent_model, 'sonnet');
  assert.match(settings.ops.model_set_at, /^\d{4}-\d\d-\d\dT/);

  // Only whole hours after the change count: 10:53 → from 11:00.
  const t = (cost, sub = 0) => ({ cost, sub_cost: sub, requests: 1 });
  const hours = {
    '2026-11-04T10': { ops: { 'claude-opus-5-5': t(9) } },
    '2026-11-04T11': { ops: { 'claude-opus-5-5': t(1), 'claude-sonnet-5-5': t(3) }, quill: { 'claude-opus-5-5': t(5, 1), 'claude-sonnet-5-5': t(3, 3) } },
  };
  const at = Date.parse('2026-11-04T12:30:00Z');
  assert.deepEqual(useSince(hours, 'ops', '2026-11-04T10:53:16Z', at), { from: '2026-11-04T11:00:00.000Z', requests: 2, sonnet: 75, sub_sonnet: null });
  assert.equal(useSince(hours, 'quill', '2026-11-04T10:53:24Z', at).sub_sonnet, 75);

  const advice = adviseProjects({ projects: [proj('ops', { sub_share: 47 }), proj('quill', { sub_share: 40 }), proj('ledger', { sub_share: 42 })] },
    { ops: 310, quill: 5000, ledger: 4457 },
    { ops: { ...settings.ops, since: useSince(hours, 'ops', '2026-11-04T10:53:16Z', at) }, quill: { ...settings.quill, since: useSince(hours, 'quill', '2026-11-04T10:53:24Z', at) } });
  const by = Object.fromEntries(advice.map((a) => [a.project, a]));
  assert.equal(by.ops.suggestions[0].kind, 'model');
  assert.ok(by.ops.suggestions[0].applied);
  assert.equal(by.ops.saving, 0);
  assert.ok(by.quill.suggestions[0].applied);
  assert.equal(by.ledger.suggestions[0].applied, undefined);
  assert.ok(by.ledger.saving > 0);

  const html = renderClaude({ ...usageAt(33), advice }, at, []);
  const cheaper = html.slice(html.indexOf('<h4>Cheaper model'), html.indexOf('<h4>Already set'));
  assert.match(cheaper, /ledger/);
  assert.doesNotMatch(cheaper, /ops|quill/);
  const set = html.slice(html.indexOf('<h4>Already set'));
  assert.match(set, /ops<\/span><span class="advice-ctx-why">Sonnet 5\.5, set <time[^>]*>[^<]+<\/time>\. Since then 75% of its use ran on Sonnet\. A session opened before the change is still on the old model\./);
  assert.match(set, /quill<\/span><span class="advice-ctx-why">Subagents on Sonnet, set <time[^>]*>[^<]+<\/time>\. Since then 75% of its subagent use ran on Sonnet\./);
});

// After a restart the 7 days still showed four long-context projects,
// though pingly had a fresh conversation and the others were closed.
test('claude: Fresh sessions lists only a conversation open now and long now', async () => {
  const { adviseProjects } = await import('../scripts/lib/claude-advice.mjs');
  const week = { projects: [
    proj('pingly', { avg_context: 362000, read_share: 61 }),
    proj('quill', { avg_context: 282000, read_share: 58 }),
    proj('ledger', { avg_context: 338000, read_share: 61 }),
  ] };
  // pingly: a fresh conversation, 40K; quill: closed; ledger: a long one still open.
  const open = { pingly: { context: 40000 }, ledger: { context: 420000 } };
  const advice = adviseProjects(week, {}, {}, open);
  const ctx = advice.filter((a) => a.suggestions.some((s) => s.kind === 'context')).map((a) => a.project);
  assert.deepEqual(ctx, ['ledger']);
  const h = advice.find((a) => a.project === 'ledger').suggestions[0];
  assert.match(h.text, /^Its open conversation re-reads 420K tokens of context on each request; re-reading was 61% of its use\./);
  assert.equal(h.saving, Math.round(0.61 * (1 - 150 / 420) * 100));
  // Nothing else to suggest, so the closed and fresh ones save nothing.
  assert.equal(advice.find((a) => a.project === 'pingly').saving, 0);
  assert.equal(advice.find((a) => a.project === 'quill').saving, 0);
  // Not knowing which sessions are open keeps the 7-day reading, never hides it.
  assert.deepEqual(adviseProjects(week, {}, {}, null).filter((a) => a.suggestions.length).map((a) => a.project).sort(), ['ledger', 'pingly', 'quill']);
});

test('claude: the open conversation is the newest transcript since its live session started', async () => {
  const { openConversations } = await import('../scripts/lib/claude-usage.mjs');
  const home = await mkdtemp(path.join(tmpdir(), 'claude-open-'));
  const dir = path.join(home, '.claude/projects');
  const sessions = path.join(home, '.claude/sessions');
  const proc = path.join(home, 'proc');
  await mkdir(path.join(dir, 'n'), { recursive: true });
  await mkdir(sessions, { recursive: true });
  const req = (cwd, id, ts, cache) => line({ type: 'assistant', timestamp: ts, cwd, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: cache, cache_creation_input_tokens: 0 } } });
  const pinglyDir = `${home}/projects/personal/pingly`;
  const ledgerDir = `${home}/projects/personal/ledger`;
  const quillDir = `${home}/projects/personal/quill`;
  // pingly: the long conversation ended on the 3rd; a fresh one began on the 4th.
  await writeFile(path.join(dir, 'n/old.jsonl'), req(pinglyDir, 'a', '2026-11-03T08:00:00Z', 300000) + req(pinglyDir, 'b', '2026-11-03T09:00:00Z', 362000));
  await writeFile(path.join(dir, 'n/new.jsonl'), req(pinglyDir, 'c', '2026-11-04T09:00:00Z', 30000) + req(pinglyDir, 'd', '2026-11-04T09:30:00Z', 40000));
  // ledger: resumed, still long; quill: long, but its session is gone.
  await writeFile(path.join(dir, 'n/ledger.jsonl'), req(ledgerDir, 'e', '2026-11-03T08:00:00Z', 300000) + req(ledgerDir, 'f', '2026-11-04T09:00:00Z', 420000));
  await writeFile(path.join(dir, 'n/quill.jsonl'), req(quillDir, 'g', '2026-11-04T08:00:00Z', 282000));
  const { state } = await scanTranscripts({ dir, home, now });
  assert.equal(state.files[path.join(dir, 'n/old.jsonl')].context, 362010);
  assert.equal(state.files[path.join(dir, 'n/new.jsonl')].project, 'pingly');

  const session = async (pid, cwd, startedAt, procStart, live = procStart) => {
    await writeFile(path.join(sessions, `${pid}.json`), JSON.stringify({ pid, cwd, startedAt: Date.parse(startedAt), procStart }));
    if (live == null) return;
    await mkdir(path.join(proc, String(pid)), { recursive: true });
    // Field 2 may hold spaces and parentheses; field 22 is the start time.
    await writeFile(path.join(proc, String(pid), 'stat'), `${pid} (claude (x) y) S ${Array.from({ length: 18 }, () => 0).join(' ')} ${live} 0 0\n`);
  };
  await session(101, pinglyDir, '2026-11-04T08:50:00Z', '500');
  await session(102, ledgerDir, '2026-11-04T08:00:00Z', '600');
  // quill's file outlived its process, and its pid now belongs to another one.
  await session(103, quillDir, '2026-11-03T07:00:00Z', '700', '999');
  await session(104, `${home}/projects/personal/media`, '2026-11-04T09:40:00Z', '800');
  const open = await openConversations({ sessionsDir: sessions, home, files: state.files, procDir: proc });
  assert.deepEqual(Object.keys(open).sort(), ['ledger', 'media', 'pingly']);
  assert.equal(open.pingly.context, 40010);
  assert.equal(open.ledger.context, 420010);
  // A session with no request yet holds no context.
  assert.equal(open.media.context, 0);
  assert.equal(await openConversations({ sessionsDir: path.join(home, 'none'), home, files: state.files, procDir: proc }), null);
});

// A project moved to Opus, and the week still read "Opus 5.5 · Fable 5.1".
test('claude: the week by project says which model an open conversation runs now', async () => {
  const { openConversations } = await import('../scripts/lib/claude-usage.mjs');
  const home = await mkdtemp(path.join(tmpdir(), 'claude-now-'));
  const dir = path.join(home, '.claude/projects');
  const sessions = path.join(home, '.claude/sessions');
  const proc = path.join(home, 'proc');
  await mkdir(path.join(dir, 'c'), { recursive: true });
  await mkdir(path.join(proc, '201'), { recursive: true });
  await mkdir(sessions, { recursive: true });
  const cwd = `${home}/projects/personal/orion`;
  const req = (id, ts, model) => line({ type: 'assistant', timestamp: ts, cwd, message: { id, model, usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 } } });
  // Fable in the morning, then /model opus in the same conversation.
  await writeFile(path.join(dir, 'c/s.jsonl'), req('a', '2026-11-04T08:00:00Z', 'claude-fable-5-1') + req('b', '2026-11-04T09:00:00Z', 'claude-opus-5-5'));
  await writeFile(path.join(sessions, '201.json'), JSON.stringify({ pid: 201, cwd, startedAt: Date.parse('2026-11-04T07:00:00Z'), procStart: '42' }));
  await writeFile(path.join(proc, '201', 'stat'), `201 (claude) S ${Array.from({ length: 18 }, () => 0).join(' ')} 42 0\n`);
  const { state } = await scanTranscripts({ dir, home, now });
  const open = await openConversations({ sessionsDir: sessions, home, files: state.files, procDir: proc });
  assert.equal(open.orion.model, 'claude-opus-5-5');

  const u = buildClaudeUsage({ fetched: { limits: normalizeLimits(answer()), plan: null, problem: null }, hours: state.hours, tools: state.tools, open, now });
  assert.deepEqual(u.now_models, { orion: 'Opus 5.5' });
  const html = renderClaude(u, now, [{ ok: true, data: { project: 'orion' } }]);
  assert.match(html, /<a href="#\/p\/orion">orion<\/a> <span class="repo-free"><b>now Opus 5\.5<\/b> · (Fable 5\.1|Opus 5\.5) [\d.]+% · (Fable 5\.1|Opus 5\.5) [\d.]+%<\/span>/);
});

test('claude: a user-level ~/.claude/settings.json applies to every project, and a project overrides it (#13)', async () => {
  const { readModelSettings } = await import('../scripts/lib/claude-usage.mjs');
  const home = await mkdtemp(path.join(tmpdir(), 'claude-user-settings-'));
  const put = async (rel, body) => { await mkdir(path.dirname(path.join(home, rel)), { recursive: true }); await writeFile(path.join(home, rel), JSON.stringify(body)); };
  await put('.claude/settings.json', { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } });
  await put('projects/personal/plain/.claude/settings.local.json', { permissions: {} });
  await put('projects/personal/heavy/.claude/settings.local.json', { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });
  const settings = await readModelSettings({ home });
  assert.deepEqual(Object.keys(settings).sort(), ['heavy', 'plain']);
  assert.equal(settings.plain.subagent_model, 'sonnet');
  assert.match(settings.plain.subagent_set_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(settings.heavy.subagent_model, 'opus');
});
