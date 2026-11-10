#!/usr/bin/env node
// Collects one project's activity (daily commits, closed issues and changed
// lines, plus recent build and deploy runs) for its dashboard status file.
// The laptop timer runs scripts/activity-all.mjs for every project once a day;
// use this to run it by hand for one.
//
//   node <projects-desk checkout>/scripts/activity.mjs \
//     --repo . --status <projects-desk checkout>/status/<project>.json
//
// Options:
//   --repo DIR        the project's git checkout (default: current directory)
//   --status FILE     write the result into this status file's "activity"
//                     field; without it, print the JSON
//   --weeks N         whole weeks to cover, default 12
//   --branch NAME     remote branch to count (repeatable); default main, plus
//                     sandbox when origin has one
//   --exclude GLOB    extra paths whose lines are not "work" (repeatable), on
//                     top of lockfiles, dist/, build/ and the like
//   --worker NAME     Cloudflare Worker whose builds to read (repeatable);
//                     default: every Worker in the repo's wrangler config
//   --no-cloudflare   skip Workers Builds
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { DEFAULT_WEEKS } from './lib/activity.mjs';
import { collectActivity, summarize, applyActivity } from './lib/collect.mjs';
import { CURRENT_SCHEMA_VERSION } from './lib/schema.mjs';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string', default: '.' },
    status: { type: 'string' },
    weeks: { type: 'string', default: String(DEFAULT_WEEKS) },
    branch: { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true, default: [] },
    worker: { type: 'string', multiple: true },
    'no-cloudflare': { type: 'boolean', default: false },
  },
});

const activity = await collectActivity({
  repo: path.resolve(args.repo), weeks: Number(args.weeks), branches: args.branch,
  exclude: args.exclude, workers: args.worker, cloudflare: !args['no-cloudflare'],
});

if (!args.status) {
  console.log(JSON.stringify(activity, null, 2));
} else {
  const file = path.resolve(args.status);
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (!applyActivity(data, activity, CURRENT_SCHEMA_VERSION)) {
    throw new Error(`${file} is schema v${data.schema_version}; migrate it to v3 first (STATUS_INSTRUCTIONS.md)`);
  }
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote activity to ${file}: ${summarize(activity)}.`);
}
