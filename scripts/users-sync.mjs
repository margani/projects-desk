#!/usr/bin/env node
// Each project's user numbers, read from the projects' own D1
// databases with the `read` token (users.config.json), into usage/users.json
// and the dashboard database's usage key `users`. Run once a day by the
// projects-dashboard-users timer; by hand: node scripts/users-sync.mjs
// (--dry prints the numbers and writes nothing).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query, usageStatement } from './lib/d1.mjs';
import { checkConfig, collectUsers, carryUsers } from './lib/users.mjs';
import { readOptionalConfig } from './lib/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');
const config = readOptionalConfig('users.config.json', null);
if (!config) {
  console.log('No users.config.json: no user numbers to read.');
  process.exit(0);
}
const problems = checkConfig(config);
if (problems.length) {
  for (const p of problems) console.error(`users.config.json: ${p}`);
  process.exit(1);
}
const previous = await readFile(path.join(root, 'usage/users.json'), 'utf8').then(JSON.parse, () => null);
const users = carryUsers(await collectUsers(config, { query }), previous);
for (const p of users.projects) {
  const nums = p.metrics?.map((m) => `${m.n} ${m.label}`).join(', ') ?? '';
  console.log(`  ${p.project}: ${p.problem ? `${p.problem}${nums ? ` (keeps ${nums} from ${p.read_at})` : ''}` : nums}`);
}
if (dry) process.exit(0);
await mkdir(path.join(root, 'usage'), { recursive: true });
await writeFile(path.join(root, 'usage/users.json'), JSON.stringify(users, null, 2) + '\n');
await query([usageStatement('users', users, Date.now())], { write: true });
console.log('written to D1');
// A project that could not be read fails the unit, so journalctl and
// `systemctl --user --failed` show it; the others were still written.
if (users.projects.some((p) => p.problem)) process.exit(1);
