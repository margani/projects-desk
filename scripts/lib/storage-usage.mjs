// Used and free space across every place files live: laptop disks, ssh hosts,
// OneDrive (rclone), Cloudflare D1 and R2. Collected on the laptop (the page
// itself makes no API calls) and written to usage/storage.json, which the
// build renders on the Builds view next to GitHub usage.
//
// Only aggregate numbers leave this module: sizes, counts and the names of
// disks, remotes, databases and buckets. Never file names, paths inside a
// drive, tokens or account emails.
import { launch } from './repo-bin.mjs';
import { execFile } from 'node:child_process';
import { statfs as statfsAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const GB = 1e9;
const TB = 1e12;

/**
 * D1 limits from "Limits" (developers.cloudflare.com/d1/platform/limits/,
 * last updated 2026-04-21, read 2026-10-20): maximum database size and
 * maximum storage per account.
 */
export const D1_LIMITS = {
  workers_paid: { label: 'Workers Paid', database: 10 * GB, account: 1 * TB },
  free: { label: 'Free', database: 500 * 1e6, account: 5 * GB },
};

/** R2 free tier, from "Pricing" (developers.cloudflare.com/r2/pricing/, read 2026-10-20). */
export const R2_FREE_BYTES = 10 * GB;

/** Filesystems that hold no files of their own on disk. */
const VIRTUAL_FS = /^(tmpfs|devtmpfs|squashfs|overlay|efivarfs|ramfs|proc|sysfs|cgroup2?|nsfs|autofs|fuse(\..*)?|fusectl)$/;

/** Default per-call timeouts, so one hung source cannot stall the publish. */
export const TIMEOUTS = { df: 15_000, ssh: 25_000, rclone: 45_000, cloudflare: 30_000 };

/**
 * Runs a command; resolves { stdout, stderr } or rejects with `.timedOut` set.
 * The timeout is our own timer, not execFile's: that only signals the child
 * and then waits for it to exit, and a Workers build once waited 5 s for a
 * killed `sleep 5`. A process stuck on a hung FUSE mount cannot be
 * killed at all. So at the timeout the call gives up whatever the child does,
 * and the whole process group (rclone's or ssh's helpers too) gets SIGKILL.
 */
export function run(cmd, args, { timeout, execFileImpl = execFile }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const [file, argv] = launch(cmd, args);
    // Not detached on Windows: it would give every call its own console window.
    const options = { maxBuffer: 16 * 1024 * 1024, detached: process.platform !== 'win32', windowsHide: true };
    const child = execFileImpl(file, argv, options, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill?.('SIGKILL');
      }
      reject(Object.assign(new Error(`Command timed out: ${cmd}`), { killed: true, timedOut: timeout, stdout: '', stderr: '' }));
    }, timeout);
  });
}

/**
 * Turns a failed call into one line the page can show. Emails are cut out:
 * rclone and ssh errors can name the account they tried.
 */
export function explain(err, what) {
  if (err.timedOut) return `${what}: no answer after ${Math.round(err.timedOut / 100) / 10} s`;
  const text = `${err.stderr ?? ''}\n${err.message ?? ''}`;
  let line;
  if (/couldn't fetch token|invalid_grant|token expired|AADSTS700082|unauthenticated/i.test(text)) line = 'sign-in expired; reconnect the rclone remote';
  else if (/Could not resolve hostname|No route to host|Connection timed out|Connection refused|Network is unreachable|Host is down/i.test(text)) line = 'host offline or unreachable';
  else if (/Permission denied \(publickey/i.test(text)) line = 'ssh key refused';
  else if (/didn't find section in config file|not found in config/i.test(text)) line = 'not connected: no such rclone remote';
  else line = text.split('\n').map((s) => s.trim()).find((s) => s && !/^Command failed/.test(s)) ?? 'failed';
  return `${what}: ${line.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '…').slice(0, 160)}`;
}

/** 0-100, or null when there is nothing to measure against. */
const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * Parses `df -B1 --output=source,fstype,size,used,avail,target`.
 * Returns { source, fstype, total, used, free, target } per line.
 */
export function parseDf(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length || !/^Filesystem\s/.test(lines[0])) throw new Error('df printed no header');
  return lines.slice(1).map((line) => {
    // The mount point is last and may contain spaces; the numbers never do.
    const m = line.match(/^(\S+)\s+(\S+)\s+(\d+|-)\s+(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!m) throw new Error(`df line not understood: ${line.slice(0, 80)}`);
    const n = (s) => (s === '-' ? null : Number(s));
    return { source: m[1], fstype: m[2], total: n(m[3]), used: n(m[4]), free: n(m[5]), target: m[6].trim() };
  });
}

/**
 * One row from a df line. % used is used / (used + free), as df prints it:
 * ext4 keeps ~5% for root, so used + free is less than the size.
 */
function dfRow(group, name, fs) {
  return {
    group, name, kind: fs.fstype, total: fs.total, used: fs.used, free: fs.free, trashed: null,
    percent: percent(fs.used, fs.used + fs.free), problem: null,
  };
}

/**
 * Laptop: every real filesystem (a block device, not tmpfs/squashfs/overlay),
 * once each. FUSE mounts (the rclone mounts under ~/mnt) are left out: the
 * same space is counted from the remote itself.
 */
export function laptopRows(dfText, { group = 'Laptop', exclude = [] } = {}) {
  const seen = new Set();
  return parseDf(dfText)
    .filter((fs) => fs.source.startsWith('/dev/') && !VIRTUAL_FS.test(fs.fstype))
    .filter((fs) => !exclude.some((dir) => fs.target === dir || fs.target.startsWith(`${dir}/`)))
    .filter((fs) => fs.total > 0 && !seen.has(fs.source) && seen.add(fs.source))
    .map((fs) => dfRow(group, fs.target, fs));
}

/**
 * A host over ssh: df for the configured paths. df answers for a path
 * that is not a mount point with the filesystem it sits on (the root disk),
 * so a row only counts when df's mount point is the path itself; otherwise the
 * drive is "not mounted". `kind` names a filesystem df only calls fuseblk
 * (NTFS through ntfs-3g).
 */
export function remoteDfRows(dfText, paths, group) {
  let parsed = [];
  try {
    parsed = parseDf(dfText);
  } catch {
    // A missing path makes df exit 1 with no lines for it; handled below.
  }
  return paths.map(({ path, name, kind }) => {
    const fs = parsed.find((f) => f.target === path);
    if (fs) return { ...dfRow(group, name ?? path, fs), ...(kind ? { kind } : {}) };
    return { group, name: name ?? path, kind: 'disk', total: null, used: null, free: null, trashed: null, percent: null, problem: 'not mounted' };
  });
}

/**
 * `rclone about <remote>: --json` → one row. Trash counts as used: it holds
 * quota until emptied. Google Drive also reports `other`, the space Gmail and
 * Photos take from the same quota; it counts as used too.
 */
export function rcloneRow(json, { group, name, kind }) {
  const a = typeof json === 'string' ? JSON.parse(json) : json;
  if (typeof a.total !== 'number' || typeof a.used !== 'number') throw new Error('rclone about returned no total');
  const trashed = a.trashed ?? null;
  const free = a.free ?? a.total - a.used - (trashed ?? 0);
  const row = { group, name, kind, total: a.total, used: a.used, free, trashed, percent: percent(a.total - free, a.total), problem: null };
  return a.other != null ? { ...row, other: a.other } : row;
}

/** Which D1 limits apply, from the account's subscriptions; null when unknown. */
export function d1Plan(subscriptions) {
  if (!Array.isArray(subscriptions)) return null;
  return subscriptions.some((s) => s.rate_plan?.id === 'workers_paid') ? D1_LIMITS.workers_paid : D1_LIMITS.free;
}

/**
 * D1 databases of one account → one row. The bar is whichever is closer to
 * its limit: the biggest database against the per-database maximum, or the
 * account total against the per-account maximum.
 */
export function d1Row(databases, { group = 'Cloudflare D1', name, plan }) {
  const items = databases.map((d) => ({ name: d.name, used: d.file_size ?? 0 }))
    .sort((a, b) => b.used - a.used || a.name.localeCompare(b.name));
  const used = items.reduce((s, d) => s + d.used, 0);
  const biggest = items[0]?.used ?? 0;
  return {
    group, name, kind: 'D1', total: plan?.account ?? null, used, free: plan ? plan.account - used : null, trashed: null,
    percent: plan ? Math.max(percent(biggest, plan.database), percent(used, plan.account)) : null,
    limit: plan ? { plan: plan.label, per_item: plan.database, account: plan.account } : null,
    items: items.map((d) => ({ ...d, percent: plan ? percent(d.used, plan.database) : null })),
    problem: plan ? null : 'plan unknown, so no limit to compare with',
  };
}

/**
 * R2: the bucket list (default and EU jurisdictions) joined with the storage
 * analytics. Analytics name EU buckets `eu_<name>`. Each bucket is the max
 * over the last day, not the newest sample: on 2026-10-20 the newest
 * 10-minute sample of a busy bucket read 0 bytes while the ones before
 * held 49.6 MB.
 */
export function r2Row(buckets, groups, { group = 'Cloudflare R2', name }) {
  const stats = new Map(groups.map((g) => [g.dimensions.bucketName, g.max]));
  const items = buckets.map((b) => {
    const s = stats.get(b.jurisdiction && b.jurisdiction !== 'default' ? `${b.jurisdiction}_${b.name}` : b.name);
    return { name: b.jurisdiction && b.jurisdiction !== 'default' ? `${b.name} (${b.jurisdiction.toUpperCase()})` : b.name, used: s?.payloadSize ?? 0, objects: s?.objectCount ?? 0 };
  }).sort((a, b) => b.used - a.used || a.name.localeCompare(b.name));
  const used = items.reduce((s, b) => s + b.used, 0);
  return {
    group, name, kind: 'R2', total: R2_FREE_BYTES, used, free: Math.max(0, R2_FREE_BYTES - used), trashed: null,
    percent: percent(used, R2_FREE_BYTES), objects: items.reduce((s, b) => s + b.objects, 0),
    limit: { free_tier: R2_FREE_BYTES },
    items: items.map((b) => ({ ...b, percent: null })),
    problem: null,
  };
}

/** Rows for a source that failed as a whole: one per row it would have had. */
const failed = (group, names, kind, problem) => names.map((name) => ({
  group, name, kind, total: null, used: null, free: null, trashed: null, percent: null, problem,
}));

/** `cfapi` (read token) → parsed JSON; it exits 1 and still prints JSON when success is false. */
async function cfapi(args, exec) {
  let stdout;
  try {
    ({ stdout } = await exec('cfapi', args, { timeout: TIMEOUTS.cloudflare }));
  } catch (err) {
    const body = (() => { try { return JSON.parse(err.stdout); } catch { return null; } })();
    if (body?.errors?.length) err.message = body.errors.map((x) => `${x.code}: ${x.message}`).join('; ');
    throw err;
  }
  const body = JSON.parse(stdout);
  if (body.errors?.length && body.success === undefined) throw new Error(body.errors.map((x) => x.message).join('; '));
  return body;
}

async function d1Databases(id, exec) {
  const all = [];
  for (let page = 1; page < 100; page++) {
    const body = await cfapi(['GET', `/accounts/${id}/d1/database?per_page=100&page=${page}`], exec);
    all.push(...(body.result ?? []));
    const info = body.result_info ?? {};
    if (!body.result?.length || all.length >= (info.total_count ?? all.length)) break;
  }
  return all;
}

async function r2Buckets(id, exec) {
  const all = [];
  for (const jurisdiction of ['default', 'eu']) {
    let cursor = null;
    for (let i = 0; i < 100; i++) {
      const query = `per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await cfapi(['GET', `/accounts/${id}/r2/buckets?${query}`, '-H', `cf-r2-jurisdiction: ${jurisdiction}`], exec);
      all.push(...(body.result?.buckets ?? []).map((b) => ({ name: b.name, jurisdiction })));
      cursor = body.result_info?.cursor;
      if (!cursor) break;
    }
  }
  return all;
}

const R2_QUERY = `query R2Storage($accountTag: string!, $start: Time, $end: Time) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
      max { objectCount payloadSize }
      dimensions { bucketName }
    }
  } }
}`;

async function r2Stats(id, now, exec) {
  const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
  const body = await cfapi(['POST', '/graphql', '-d', JSON.stringify({
    query: R2_QUERY, variables: { accountTag: id, start: iso(now - 86_400_000), end: iso(now) },
  })], exec);
  if (body.errors?.length) throw new Error(body.errors.map((x) => x.message).join('; '));
  return body.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [];
}

/** One row per path in `paths` (default: the home folder's drive), from statfs. */
async function statfsRows(src, { home, statfs, platform }) {
  const rows = [];
  for (const given of src.paths ?? [home]) {
    const target = given.replace(/^~(?=[\\/]|$)/, home);
    const name = (platform === 'win32' ? path.win32 : path.posix).parse(target).root || target;
    try {
      const { bsize, blocks, bfree, bavail } = await statfs(target);
      const total = bsize * blocks;
      const used = bsize * (blocks - bfree);
      const free = bsize * bavail;
      rows.push({ group: src.name, name, kind: 'disk', total, used, free, trashed: null, percent: used + free > 0 ? (used / (used + free)) * 100 : null, problem: null });
    } catch (err) {
      rows.push(...failed(src.name, [name], 'disk', explain(err, 'statfs')));
    }
  }
  return rows;
}

/** Each source kind: config entry → rows. Throws only for programming errors. */
const COLLECTORS = {
  async local(src, { exec, home, platform, statfs }) {
    // `df --output` is GNU only, so Windows and macOS ask the filesystem directly.
    if (platform !== 'linux') return statfsRows(src, { home, statfs, platform });
    const exclude = (src.exclude_under ?? []).map((d) => d.replace(/^~(?=\/|$)/, home));
    // df stats every mount, and an rclone mount whose remote hangs blocks it past the
    // timeout: on 2026-11-05 that hid every laptop disk for two days. Those
    // mounts are counted from their remotes, so df skips their type entirely.
    const types = src.skip_types ?? [];
    const badType = types.find((t) => typeof t !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(t));
    if (badType !== undefined) return failed(src.name, ['disks'], 'disk', `skip_types: ${JSON.stringify(badType)} is not a filesystem type`);
    const skip = types.flatMap((t) => ['-x', t]);
    try {
      const { stdout } = await exec('df', ['-B1', ...skip, '--output=source,fstype,size,used,avail,target'], { timeout: TIMEOUTS.df });
      return laptopRows(stdout, { group: src.name, exclude });
    } catch (err) {
      // df exits 1 when one mount cannot be read but still prints the rest.
      if (err.stdout && /^Filesystem/.test(err.stdout)) return laptopRows(err.stdout, { group: src.name, exclude });
      return failed(src.name, ['disks'], 'disk', explain(err, 'df'));
    }
  },

  async ssh(src, { exec }) {
    const target = src.user ? `${src.user}@${src.host}` : src.host;
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, 'df', '-B1', '--output=source,fstype,size,used,avail,target', '--', ...src.paths.map((p) => p.path)];
    try {
      const { stdout } = await exec('ssh', args, { timeout: TIMEOUTS.ssh });
      return remoteDfRows(stdout, src.paths, src.name);
    } catch (err) {
      // Exit 1 with output: df ran, but a path is missing (so not mounted).
      if (err.code === 1 && err.stdout && /^Filesystem/.test(err.stdout)) return remoteDfRows(err.stdout, src.paths, src.name);
      return failed(src.name, src.paths.map((p) => p.name ?? p.path), 'disk', explain(err, src.host));
    }
  },

  async rclone(src, { exec }) {
    const rows = await Promise.all(src.remotes.map(async (remote) => {
      const name = remote.name ?? remote.remote;
      try {
        const { stdout } = await exec('rclone', ['about', `${remote.remote}:`, '--json'], { timeout: TIMEOUTS.rclone });
        return rcloneRow(stdout, { group: src.name, name, kind: src.kind_label ?? 'rclone' });
      } catch (err) {
        return failed(src.name, [name], src.kind_label ?? 'rclone', explain(err, remote.remote))[0];
      }
    }));
    return rows;
  },

  async d1(src, { exec }) {
    return Promise.all(src.accounts.map(async ({ id, name }) => {
      try {
        const [dbs, subs] = await Promise.all([
          d1Databases(id, exec),
          cfapi(['GET', `/accounts/${id}/subscriptions`], exec).then((b) => b.result).catch(() => null),
        ]);
        return d1Row(dbs, { group: src.name, name, plan: d1Plan(subs) });
      } catch (err) {
        return failed(src.name, [name], 'D1', explain(err, 'Cloudflare API'))[0];
      }
    }));
  },

  async r2(src, { exec, now }) {
    return Promise.all(src.accounts.map(async ({ id, name }) => {
      try {
        const [buckets, stats] = await Promise.all([r2Buckets(id, exec), r2Stats(id, now, exec)]);
        return r2Row(buckets, stats, { group: src.name, name });
      } catch (err) {
        return failed(src.name, [name], 'R2', explain(err, 'Cloudflare API'))[0];
      }
    }));
  },
};

/** A source switched off in the config: one row with its note, never a call. */
function disabledRows(src) {
  const names = src.remotes?.map((r) => r.name ?? r.remote) ?? [src.name];
  return names.map((name) => ({
    group: src.name, name, kind: src.kind_label ?? src.kind, total: null, used: null, free: null, trashed: null,
    percent: null, problem: src.note ?? 'disabled', disabled: true,
  }));
}

/**
 * Every source in storage-usage.config.json, in parallel. A source that
 * fails becomes rows with a `problem`; the others are unaffected.
 */
export async function collectStorage(sources, { now = Date.now(), exec = run, home = homedir(), platform = process.platform, statfs = statfsAsync } = {}) {
  const groups = await Promise.all(sources.map(async (src) => {
    if (src.enabled === false) return disabledRows(src);
    const collect = COLLECTORS[src.kind];
    if (!collect) return failed(src.name, [src.name], src.kind, `unknown source kind "${src.kind}"`);
    try {
      return await collect(src, { exec, now, home, platform, statfs });
    } catch (err) {
      return failed(src.name, [src.name], src.kind, explain(err, src.kind));
    }
  }));
  return {
    generated_at: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    sources: groups.flat(),
  };
}

/**
 * A row that could not be read now keeps the last reading it had, with
 * `read_at` and the reason it failed. Google Drive through rclone's shared
 * client was rate-limited in 18% of runs, and an empty "Not read" row
 * hid 600 GB of numbers that were ten minutes old. "not mounted" is a real
 * state, not a failed read, so it is never carried.
 */
export function carryForward(current, previous) {
  if (!previous?.sources?.length) return current;
  const key = (s) => `${s.group}\u0000${s.name}`;
  const last = new Map(previous.sources.filter((s) => s.used != null).map((s) => [key(s), s]));
  return {
    ...current,
    sources: current.sources.map((s) => {
      const old = last.get(key(s));
      if (s.used != null || s.disabled || s.problem === 'not mounted' || !old) return s;
      return { ...old, problem: s.problem, read_at: old.read_at ?? previous.generated_at };
    }),
  };
}
