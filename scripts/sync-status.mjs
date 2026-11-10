#!/usr/bin/env node
// Copies status/*.json into the dashboard database. Run by the publish
// watcher after a status file changes; by hand: node scripts/sync-status.mjs
// Prints one line per changed project, and "INVALID <name> <sha>: <reason>"
// for a file that is not JSON (the watcher notifies about those).
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query, planSync } from './lib/d1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'status');
const names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
if (!names.length) {
  // An empty folder would delete every project from the page.
  console.error('No status files in status/; nothing synced.');
  process.exit(2);
}
const files = await Promise.all(names.map(async (f) => ({ name: f.slice(0, -'.json'.length), text: await readFile(path.join(dir, f), 'utf8') })));
const [remote] = await query([{ sql: 'SELECT project, sha FROM status' }]);
const plan = planSync(files, remote.results ?? [], Date.now());
for (const x of plan.invalid) console.log(`INVALID ${x.name} ${x.sha}: ${x.message}`);
if (plan.statements.length) await query(plan.statements, { write: true });
console.log(plan.upserts.length || plan.deletes.length
  ? `synced: ${[...plan.upserts, ...plan.deletes.map((d) => `${d} (deleted)`)].join(', ')}`
  : 'nothing changed');
