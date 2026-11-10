// Prints the Worker's custom domains from wrangler.jsonc, one per line.
// scripts/deploy.sh checks each of them for the Access login after a deploy
//: checking only one would let a second domain added without Access serve
// the private page publicly and still pass.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function customDomains(file = path.join(root, 'wrangler.jsonc')) {
  const cfg = JSON.parse((await readFile(file, 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  return (cfg.routes ?? []).filter((r) => r.custom_domain).map((r) => r.pattern);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hosts = await customDomains(process.argv[2]);
  if (hosts.length === 0) {
    console.error('wrangler.jsonc has no custom domains to check.');
    process.exit(2);
  }
  console.log(hosts.join('\n'));
}
