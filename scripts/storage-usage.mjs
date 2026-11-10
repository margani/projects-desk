#!/usr/bin/env node
// Writes usage/storage.json for the sources in storage-usage.config.json.
// Run by the publish watcher before it commits, so every deploy carries
// fresh numbers; by hand: node scripts/storage-usage.mjs
import { readOptionalConfig } from './lib/config.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectStorage, carryForward } from './lib/storage-usage.mjs';
import { bytes } from './lib/storage-render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { sources } = readOptionalConfig('storage-usage.config.json', { sources: [] });
if (!sources?.length) {
  console.error('No sources in storage-usage.config.json.');
  process.exit(2);
}
const previous = await readFile(path.join(root, 'usage/storage.json'), 'utf8').then(JSON.parse, () => null);
// A failed source shows its last reading instead of an empty row.
const storage = carryForward(await collectStorage(sources), previous);
await mkdir(path.join(root, 'usage'), { recursive: true });
await writeFile(path.join(root, 'usage/storage.json'), JSON.stringify(storage, null, 2) + '\n');
for (const s of storage.sources) {
  const label = `${s.group} · ${s.name}`;
  if (s.problem && s.used == null) console.log(`  ${label}: ${s.problem}`);
  else console.log(`  ${label} (${s.kind}): ${bytes(s.used)}${s.total ? ` / ${bytes(s.total)}` : ''}${s.percent != null ? ` (${s.percent}%)` : ''}${s.problem ? ` — ${s.problem}` : ''}`);
}
