#!/usr/bin/env node
// Writes wrangler.jsonc from desk.config.json (or DESK_CONFIG_JSON).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDeskConfig, renderWrangler, root } from './lib/config.mjs';

try {
  const out = path.join(root, 'wrangler.jsonc');
  await writeFile(out, JSON.stringify(renderWrangler(loadDeskConfig()), null, 2) + '\n');
  console.log(`wrote ${out}`);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
