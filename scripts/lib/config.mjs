// What differs between installations lives in files git ignores, with a
// tracked *.example.json beside each, so an update never touches them and no
// account id reaches the public repository.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** desk.config.json → a list of problems; empty when it can be used. */
export function checkDeskConfig(cfg) {
  const problems = [];
  if (!/^[0-9a-f]{32}$/.test(cfg?.d1?.account ?? '')) problems.push('d1.account must be a Cloudflare account id (32 hex characters)');
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(cfg?.d1?.database ?? '')) problems.push('d1.database must be a D1 database id');
  if (!Array.isArray(cfg?.domains) || cfg.domains.length === 0) problems.push('domains must name at least one custom domain behind Cloudflare Access');
  else if (cfg.domains.some((d) => typeof d !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))) problems.push('domains must be plain host names');
  if ('claude' in (cfg ?? {}) && typeof cfg.claude !== 'boolean') problems.push('claude must be true or false');
  return problems;
}

/**
 * The installation's settings, from DESK_CONFIG_JSON (a hosted build has no
 * private files) or desk.config.json. Throws with what to do: a deploy with
 * half a config could put the page somewhere Access does not cover.
 */
export function loadDeskConfig({ env = process.env, file = path.join(root, 'desk.config.json') } = {}) {
  let text = env.DESK_CONFIG_JSON;
  if (text === undefined) {
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('desk.config.json is missing: copy desk.config.example.json and fill it in (docs/SETUP.md).');
      throw err;
    }
  }
  const cfg = JSON.parse(text);
  const problems = checkDeskConfig(cfg);
  if (problems.length) throw new Error(`desk.config.json: ${problems.join('; ')}`);
  return {
    worker_name: cfg.worker_name ?? 'projects-desk',
    d1: { account: cfg.d1.account, database: cfg.d1.database, name: cfg.d1.name ?? 'projects-desk' },
    domains: cfg.domains,
    claude: cfg.claude === true,
  };
}

/** A collector's optional config file, or `fallback` when this install has none. */
export function readOptionalConfig(name, fallback, { dir = root } = {}) {
  try {
    return JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${name}: ${err.message}`);
  }
}

/**
 * wrangler.jsonc for this installation. workers_dev and preview_urls stay off
 * in code, not in a file someone edits: the page lists private issue titles,
 * and either URL would be reachable without Cloudflare Access.
 */
export function renderWrangler(cfg) {
  return {
    $schema: './node_modules/wrangler/config-schema.json',
    name: cfg.worker_name,
    account_id: cfg.d1.account,
    compatibility_date: '2026-10-06',
    compatibility_flags: ['nodejs_compat'],
    main: 'src/worker.mjs',
    assets: { directory: './dist', binding: 'ASSETS', run_worker_first: ['/', '/index.html', '/version.json'] },
    d1_databases: [{ binding: 'DB', database_name: cfg.d1.name, database_id: cfg.d1.database }],
    routes: cfg.domains.map((pattern) => ({ pattern, custom_domain: true })),
    workers_dev: false,
    preview_urls: false,
  };
}
