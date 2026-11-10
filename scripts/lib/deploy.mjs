// The deploy, in Node so it also runs from PowerShell: deploys the Worker and
// the app files in dist/, then fails if any custom domain answers without an
// Access login. Workers Builds reaches it through scripts/deploy.sh.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { customDomains } from '../custom-domains.mjs';

/** A brand-new custom domain needed more than 3 minutes to get its certificate. */
export const CONNECT_TRIES = 60;
export const CONNECT_WAIT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ACCESS_LOGIN = /^https:\/\/[^/]+\.cloudflareaccess\.com\//;
const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * True only when at least one host was checked and every one redirected an
 * anonymous request to Access. A second domain added without Access would
 * otherwise serve the private page publicly and still pass.
 */
export async function checkHosts(hosts, { fetch: request = fetch, sleep = sleepMs, log = console.log, error = console.error } = {}) {
  if (hosts.length === 0) { error('ERROR: no custom domain was checked.'); return false; }
  for (const host of hosts) {
    let response = null;
    for (let i = 1; i <= CONNECT_TRIES && !response; i++) {
      try {
        response = await request(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch {
        log(`${host} not reachable yet (try ${i}), waiting ${CONNECT_WAIT_MS / 1000}s`);
        await sleep(CONNECT_WAIT_MS);
      }
    }
    if (!response) { error(`ERROR: ${host} did not respond after 10 minutes.`); return false; }
    const location = response.headers.get('location') ?? '';
    log(`${host}: HTTP ${response.status} -> ${location.split('?')[0]}`);
    if (!ACCESS_LOGIN.test(location)) {
      error(`ERROR: ${host} answered HTTP ${response.status} without an Access login. The page may be public — fix the Access application now.`);
      return false;
    }
    log(`OK: an unauthenticated request to ${host} is redirected to Cloudflare Access.`);
  }
  log(`Checked ${hosts.length} custom domain(s).`);
  return true;
}

const runNode = (root) => (args) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true }).status;

/** Returns the exit code. `node` runs one Node command, and is replaced in tests. */
export async function deploy({ root, env = process.env, node = runNode(root), hosts = customDomains, checks = {}, error = console.error }) {
  // Only main is production. A preview trigger or a manual build of another
  // branch must never reach the live page.
  const branch = env.WORKERS_CI_BRANCH;
  if (branch && branch !== 'main') {
    error(`Refusing to deploy branch '${branch}'; only main deploys the live page.`);
    return 1;
  }
  if (!existsSync(path.join(root, 'dist/inline.mjs'))) {
    error('dist/inline.mjs is missing; run the build command first.');
    return 1;
  }
  if (node(['scripts/write-wrangler.mjs']) !== 0) return 1;
  // wrangler's own entry point, because Node will not run npx.cmd without a shell.
  if (node(['node_modules/wrangler/bin/wrangler.js', 'deploy']) !== 0) return 1;
  return await checkHosts(await hosts(), checks) ? 0 : 1;
}
