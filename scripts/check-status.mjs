#!/usr/bin/env node
// Reports invalid status files without failing. Each project's session owns
// its file, and a broken one already renders as a warning card; on
// 2026-10-17 a test that failed on real data blocked every deploy for 11
// hours because one file had six next steps.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStatus } from './lib/schema.mjs';

export async function checkStatusDir(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const invalid = [];
  for (const f of files) {
    const r = loadStatus(f.slice(0, -5), await readFile(path.join(dir, f), 'utf8'));
    if (!r.ok) invalid.push({ file: f, problems: r.problems });
  }
  return { checked: files.length, invalid };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = path.resolve(process.argv[2] ?? 'status');
  const { checked, invalid } = await checkStatusDir(dir);
  if (checked === 0) {
    console.error(`No status files found in ${dir}.`);
    process.exit(2);
  }
  for (const { file, problems } of invalid) {
    // GitHub shows ::warning lines as annotations on the run.
    console.log(`::warning file=status/${file}::${problems.join('; ')}`);
  }
  console.log(`Checked ${checked} status files, ${invalid.length} invalid.`);
}
