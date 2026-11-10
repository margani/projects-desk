#!/usr/bin/env node
// Collects GitHub usage, storage use, the Desktop's app probe and
// Claude plan usage, and writes them into the dashboard database, and into usage/*.json for
// `npm run dev`. Run every 10
// minutes by the projects-dashboard-usage timer; by hand:
// node scripts/usage-sync.mjs
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { collectUsage } from './lib/github-usage.mjs';
import { collectStorage, carryForward } from './lib/storage-usage.mjs';
import { loadDeskConfig, readOptionalConfig, root } from './lib/config.mjs';
import { bytes } from './lib/storage-render.mjs';
import { query, usageStatement } from './lib/d1.mjs';
import { collectApps } from './lib/apps.mjs';
import { loadStatus } from './lib/schema.mjs';
import { fetchLimits, scanTranscripts, buildClaudeUsage, readModelSettings, openConversations } from './lib/claude-usage.mjs';
import os from 'node:os';

const desk = loadDeskConfig();
const { accounts } = readOptionalConfig('github-usage.config.json', { accounts: [] });
const { sources } = readOptionalConfig('storage-usage.config.json', { sources: [] });
const previous = await readFile(path.join(root, 'usage/storage.json'), 'utf8').then(JSON.parse, () => null);
const statusDir = path.join(root, 'status');
const entries = await Promise.all((await readdir(statusDir)).filter((f) => f.endsWith('.json')).map(async (f) => loadStatus(f.slice(0, -5), await readFile(path.join(statusDir, f), 'utf8'))));
const home = os.homedir();
const readJson = (f) => readFile(path.join(root, f), 'utf8').then(JSON.parse, () => null);
// Claude: the limits from Anthropic, the split by project from the
// transcripts read since the last run (offsets in usage/claude-scan.json).
const collectClaude = async () => {
  const [prevClaude, scanState] = await Promise.all([readJson('usage/claude.json'), readJson('usage/claude-scan.json')]);
  const [fetched, scan, settings] = await Promise.all([
    fetchLimits({ credentialsFile: path.join(home, '.claude/.credentials.json') }),
    scanTranscripts({ dir: path.join(home, '.claude/projects'), home, state: scanState ?? {} }),
    // Which suggestions a project already applied.
    readModelSettings({ home }),
  ]);
  // Lines changed in git over 7 days, the "is it a code project" signal.
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const linesChanged = Object.fromEntries(entries.filter((x) => x.ok && Array.isArray(x.data.activity?.days)).map((x) => [
    x.data.project,
    x.data.activity.days.filter((d) => d.date >= since).reduce((n, d) => n + (d.lines_added ?? 0) + (d.lines_deleted ?? 0), 0),
  ]));
  // The conversations open now: the 7 days cannot tell a long
  // conversation that ended (a restart, rc.sh close) from one still running.
  const open = await openConversations({ sessionsDir: path.join(home, '.claude/sessions'), home, files: scan.state.files });
  return { claude: buildClaudeUsage({ fetched, previous: prevClaude, hours: scan.state.hours, tools: scan.state.tools, linesChanged, settings, open }), scan };
};
// Claude is opt-in: it reads an undocumented endpoint with the Claude Code login.
const [github, fresh, apps, { claude = null, scan = null } = {}] = await Promise.all([collectUsage(accounts), collectStorage(sources), collectApps(entries, { hosts: desk.domains }), desk.claude ? collectClaude() : undefined]);
// A failed source shows its last reading instead of an empty row.
const storage = carryForward(fresh, previous);

await mkdir(path.join(root, 'usage'), { recursive: true });
await writeFile(path.join(root, 'usage/github.json'), JSON.stringify(github, null, 2) + '\n');
await writeFile(path.join(root, 'usage/storage.json'), JSON.stringify(storage, null, 2) + '\n');
await writeFile(path.join(root, 'usage/apps.json'), JSON.stringify(apps, null, 2) + '\n');
if (claude) {
  await writeFile(path.join(root, 'usage/claude.json'), JSON.stringify(claude, null, 2) + '\n');
  await writeFile(path.join(root, 'usage/claude-scan.json'), JSON.stringify(scan.state) + '\n');
}
const now = Date.now();
await query([usageStatement('github', github, now), usageStatement('storage', storage, now), usageStatement('apps', apps, now), claude ? usageStatement('claude', claude, now) : { sql: 'DELETE FROM usage WHERE key = ?', params: ['claude'] }], { write: true });

for (const a of github.accounts) {
  console.log(a.problem ? `  ${a.login}: ${a.problem}` : `  ${a.login} (${a.plan}): ${a.minutes.counted} counted (${a.minutes.total} raw)/${a.minutes.included ?? '?'} min, $${a.billed_usd} billed`);
}
for (const s of storage.sources) {
  const label = `${s.group} · ${s.name}`;
  console.log(s.problem && s.used == null ? `  ${label}: ${s.problem}` : `  ${label}: ${bytes(s.used)}${s.total ? ` / ${bytes(s.total)}` : ''}${s.percent != null ? ` (${s.percent}%)` : ''}`);
}
for (const a of apps.apps) console.log(`  app ${a.project}: ${a.framable ? 'window' : `tab (${a.reason ?? 'unknown'})`}${a.icon ? '' : ', no icon'}`);
if (claude) {
  const cl = claude.limits;
  console.log(claude.problem ? `  claude: ${claude.problem}` : `  claude (${claude.plan}): session ${cl.session?.percent}%, week ${cl.weekly?.percent}%`);
  console.log(`  claude transcripts: ${scan.lines} new requests, ${Math.round(scan.bytes / 1e6)} MB read; week by project: ${claude.week.projects.slice(0, 4).map((p) => `${p.name} ${p.share}%`).join(', ')}`);
}
console.log('written to D1');
