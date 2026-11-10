#!/usr/bin/env node
// Daily: collects activity for every project in status/ and writes only each
// file's "activity" field; the status watcher then copies it into D1.
// Run by the systemd user timer projects-dashboard-activity.timer
// (scripts/install-watcher.sh); logs: journalctl --user -u projects-dashboard-activity
//
// A project's checkout is found by matching its repo_url against the origin of
// every git repo under ~/projects (or ACTIVITY_ROOTS, colon-separated).
// Per-project options live in activity.config.json.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { githubSlug } from './lib/activity.mjs';
import { collectActivity, summarize, applyActivity } from './lib/collect.mjs';
import { CURRENT_SCHEMA_VERSION } from './lib/schema.mjs';
import { readOptionalConfig } from './lib/config.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ACTIVITY_STATUS_DIR points a trial run at a copy instead of the real files.
const statusDir = process.env.ACTIVITY_STATUS_DIR ?? path.join(root, 'status');
const roots = (process.env.ACTIVITY_ROOTS ?? path.join(homedir(), 'projects')).split(':');

/** origin slug (lower case) → checkout path, for git repos up to three levels down. */
async function findCheckouts(dir, depth, found) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.name === '.git')) {
    try {
      const url = (await run('git', ['-C', dir, 'remote', 'get-url', 'origin'])).stdout;
      const slug = githubSlug(url)?.toLowerCase();
      // The first checkout found wins; a second clone (e.g. atlas-test) is ignored.
      if (slug && !found.has(slug)) found.set(slug, dir);
    } catch { /* no origin */ }
    return;
  }
  if (depth === 0) return;
  for (const e of entries) {
    if (e.isDirectory() && !/^(\.|node_modules$)/.test(e.name)) await findCheckouts(path.join(dir, e.name), depth - 1, found);
  }
}

const config = readOptionalConfig('activity.config.json', {}).projects ?? {};
const checkouts = new Map();
for (const r of roots) await findCheckouts(r, 3, checkouts);

const files = (await readdir(statusDir)).filter((f) => f.endsWith('.json')).sort();
let failed = 0;
for (const file of files) {
  const name = file.slice(0, -'.json'.length);
  const full = path.join(statusDir, file);
  try {
    const data = JSON.parse(await readFile(full, 'utf8'));
    const opts = config[name] ?? {};
    const slug = githubSlug(data.repo_url ?? '')?.toLowerCase();
    const repo = opts.repo ? path.resolve(homedir(), opts.repo) : slug && checkouts.get(slug);
    if (!repo) { console.log(`skip     ${name}: no local checkout of ${data.repo_url ?? '(no repo_url)'}`); continue; }
    if (data.schema_version < 3) { console.log(`skip     ${name}: schema v${data.schema_version}; its own session migrates it first`); continue; }
    const activity = await collectActivity({
      repo, exclude: opts.exclude, workers: opts.workers, branches: opts.branches, cloudflare: opts.cloudflare !== false,
      warn: (m) => console.log(`warn     ${name}: ${m}`),
    });
    // Re-read just before writing: a session may have updated the file meanwhile.
    const fresh = JSON.parse(await readFile(full, 'utf8'));
    applyActivity(fresh, activity, CURRENT_SCHEMA_VERSION);
    await writeFile(full, JSON.stringify(fresh, null, 2) + '\n');
    console.log(`ok       ${name}: ${summarize(activity)}`);
  } catch (err) {
    failed++;
    console.log(`FAILED   ${name}: ${err.message.split('\n')[0]}`);
  }
}
console.log(`Done: ${files.length - failed} of ${files.length} projects handled, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
