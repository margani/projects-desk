#!/usr/bin/env node
// Writes usage/github.json for the accounts in github-usage.config.json.
// Run by the publish watcher before it commits, so every deploy carries
// fresh numbers; by hand: node scripts/github-usage.mjs
import { readOptionalConfig } from './lib/config.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectUsage } from './lib/github-usage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { accounts } = readOptionalConfig('github-usage.config.json', { accounts: [] });
if (!accounts?.length) {
  console.error('No accounts in github-usage.config.json.');
  process.exit(2);
}
const usage = await collectUsage(accounts);
await mkdir(path.join(root, 'usage'), { recursive: true });
await writeFile(path.join(root, 'usage/github.json'), JSON.stringify(usage, null, 2) + '\n');
for (const a of usage.accounts) {
  console.log(a.problem ? `  ${a.login}: ${a.problem}` : `  ${a.login} (${a.plan}): ${a.minutes.counted} counted (${a.minutes.total} raw)/${a.minutes.included ?? '?'} min, ${a.storage.gb}/${a.storage.included_gb ?? '?'} GB, $${a.billed_usd} billed`);
}
