// Collects one project's activity from its git checkout, GitHub (`gh`) and
// Cloudflare Workers Builds (`cfapi`, the saved read token). Shared by
// scripts/activity.mjs (one project) and scripts/activity-all.mjs (the timer).
import './repo-bin.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_EXCLUDES, DEFAULT_WEEKS, dayKeys, parseNumstat, bucketCommits, addClosedIssues,
  githubBuilds, cloudflareBuilds, mergeBuilds, workersFromConfig, githubSlug,
} from './activity.mjs';

const run = promisify(execFile);
const sh = async (cmd, args) => (await run(cmd, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' })).stdout;

async function findConfigs(dir, depth = 2) {
  const found = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isFile() && /^wrangler\.(jsonc?|toml)$/.test(ent.name)) found.push(p);
    else if (ent.isDirectory() && depth > 0 && !/^(\.|node_modules$|dist$|build$)/.test(ent.name)) {
      found.push(...await findConfigs(p, depth - 1));
    }
  }
  return found;
}

// One scripts list per account per process: the timer reads many projects.
let scriptsCache = null;
async function cloudflareScripts(cfapi) {
  if (!scriptsCache) {
    scriptsCache = (async () => {
      const accounts = (await cfapi('/accounts')).result.map((a) => a.id);
      const byAccount = new Map();
      for (const acc of accounts) byAccount.set(acc, (await cfapi(`/accounts/${acc}/workers/scripts`)).result);
      return { accounts, byAccount };
    })();
  }
  return scriptsCache;
}

/**
 * @param {{ repo: string, weeks?: number, branches?: string[], exclude?: string[],
 *           workers?: string[], cloudflare?: boolean, now?: Date, warn?: (msg: string) => void }} opts
 * @returns {Promise<{ generated_at: string, days: object[], builds: object[] }>}
 */
export async function collectActivity({
  repo, weeks = DEFAULT_WEEKS, branches, exclude = [], workers, cloudflare = true,
  now = new Date(), warn = (m) => console.error(`activity: ${m}`),
}) {
  const git = (...a) => sh('git', ['-C', repo, ...a]);
  const days = dayKeys(now, weeks);
  const since = `${days[0]}T00:00:00Z`;

  // Commits and lines, from the remote branches so local work in progress does not count.
  await git('fetch', '--quiet', 'origin');
  const remote = (await git('branch', '-r', '--format=%(refname:short)')).split('\n').filter(Boolean);
  const refs = (branches ?? ['main', 'sandbox']).map((b) => `origin/${b}`).filter((b) => remote.includes(b));
  if (!refs.length) throw new Error(`none of ${branches ?? 'main, sandbox'} exists on origin in ${repo}`);
  const log = await git('log', '--no-merges', `--since=${since}`, '--format=%x1e%H%x1f%aI', '--numstat', ...refs);
  const buckets = bucketCommits(parseNumstat(log), days, [...DEFAULT_EXCLUDES, ...exclude]);

  // Closed issues and Actions runs.
  const slug = githubSlug(await git('remote', 'get-url', 'origin'));
  let ghRuns = [];
  if (slug) {
    const closed = JSON.parse(await sh('gh', ['issue', 'list', '-R', slug, '--state', 'closed', '--limit', '1000',
      '--search', `closed:>=${days[0]}`, '--json', 'closedAt']));
    addClosedIssues(buckets, closed.map((i) => i.closedAt));
    const runs = JSON.parse(await sh('gh', ['run', 'list', '-R', slug, '--limit', '200',
      '--json', 'workflowName,startedAt,updatedAt,conclusion,status']));
    ghRuns = githubBuilds(runs, since);
  } else {
    warn('origin is not on GitHub: no closed issues or Actions runs');
  }

  // Workers Builds, for every Worker in the repo's wrangler config.
  const cfBuilds = [];
  if (cloudflare) {
    const wanted = new Map();
    if (workers?.length) for (const w of workers) wanted.set(w, null);
    else {
      for (const file of await findConfigs(repo)) {
        try {
          const found = workersFromConfig(await readFile(file, 'utf8'), file.endsWith('.toml') ? 'toml' : 'json');
          for (const w of found.workers) wanted.set(w, found.accountId);
        } catch (err) {
          warn(`could not read ${path.relative(repo, file)}: ${err.message}`);
        }
      }
    }
    if (wanted.size) {
      const cfapi = async (p) => JSON.parse(await sh('cfapi', ['GET', p]));
      try {
        const { accounts, byAccount } = await cloudflareScripts(cfapi);
        for (const [name, hinted] of wanted) {
          const acc = [hinted, ...accounts].find((a) => a && byAccount.get(a)?.some((s) => s.id === name));
          if (!acc) { warn(`Worker ${name} not found on any account`); continue; }
          const tag = byAccount.get(acc).find((s) => s.id === name).tag;
          const res = await cfapi(`/accounts/${acc}/builds/workers/${tag}/builds?per_page=50`).catch(() => null);
          cfBuilds.push(cloudflareBuilds(res?.result ?? [], name, since));
        }
      } catch (err) {
        warn(`Cloudflare builds skipped: ${err.message.split('\n')[0]} (is the read token saved? see docs/SETUP.md)`);
      }
    }
  }

  return { generated_at: now.toISOString(), days: buckets, builds: mergeBuilds([ghRuns, ...cfBuilds]) };
}

export function summarize(activity) {
  const sum = (k) => activity.days.reduce((n, d) => n + d[k], 0);
  return `${sum('commits')} commits, ${sum('issues_closed')} issues closed, +${sum('lines_added')}/-${sum('lines_deleted')} lines, `
    + `${activity.builds.length} builds over ${activity.days.length} days`;
}

/**
 * Puts `activity` into a parsed status file. v3 and v4 differ from v5 only in
 * `activity`, so they move to v5; v1 and v2 lack other fields their own
 * session must add, so they are left alone.
 * @returns {boolean} whether the file was updated
 */
export function applyActivity(data, activity, currentVersion) {
  if (!Number.isInteger(data.schema_version) || data.schema_version < 3) return false;
  if (data.schema_version < currentVersion) data.schema_version = currentVersion;
  data.activity = activity;
  return true;
}
