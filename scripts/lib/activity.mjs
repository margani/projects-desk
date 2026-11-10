// Pure helpers for scripts/activity.mjs: week buckets, git log parsing, path
// excludes, wrangler config reading. Kept free of I/O so they can be tested.
import path from 'node:path';

export const DEFAULT_WEEKS = 12;
export const DEFAULT_DAYS = DEFAULT_WEEKS * 7;
export const MAX_BUILDS = 40;

// Lines in these files are generated, not written: counting them would let one
// `npm install` outweigh a month of work.
export const DEFAULT_EXCLUDES = [
  '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml',
  '**/*.lock', '**/go.sum', '**/dist/**', '**/build/**', '**/node_modules/**',
  '**/vendor/**', '**/*.min.js', '**/*.min.css', '**/*.map',
];

/** Monday 00:00 UTC of the week containing `date`, as YYYY-MM-DD. */
export function weekStart(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

/** The `count` week starts ending with the week of `now`, oldest first. */
export function weekKeys(now, count = DEFAULT_WEEKS) {
  const last = new Date(`${weekStart(now)}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(last);
    d.setUTCDate(d.getUTCDate() - 7 * (count - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

/** The calendar day (UTC) of `date`, as YYYY-MM-DD. */
export const dayOf = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * Every day from the Monday `weeks - 1` weeks before the week of `now` up to
 * `now`, oldest first: whole weeks, so a calendar view starts on a Monday.
 */
export function dayKeys(now, weeks = DEFAULT_WEEKS) {
  const first = new Date(`${weekKeys(now, weeks)[0]}T00:00:00Z`);
  const last = dayOf(now);
  const days = [];
  for (const d = first; dayOf(d) <= last; d.setUTCDate(d.getUTCDate() + 1)) days.push(dayOf(d));
  return days;
}

export function isExcluded(file, excludes) {
  return excludes.some((g) => path.matchesGlob(file, g));
}

/**
 * Parses `git log --format=%x1e%H%x1f%aI --numstat` output.
 * @returns {{ hash: string, date: string, files: { path: string, added: number|null, deleted: number|null }[] }[]}
 */
export function parseNumstat(text) {
  const commits = [];
  for (const chunk of text.split('\x1e')) {
    const lines = chunk.split('\n');
    const head = lines.shift();
    if (!head || !head.includes('\x1f')) continue;
    const [hash, date] = head.split('\x1f');
    const files = [];
    for (const line of lines) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
      if (!m) continue;
      // A rename prints "old => new" or "dir/{old => new}"; the new path is what was touched.
      const file = m[3].replace(/\{[^}]* => ([^}]*)\}/g, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
      files.push({ path: file, added: m[1] === '-' ? null : +m[1], deleted: m[2] === '-' ? null : +m[2] });
    }
    commits.push({ hash: hash.trim(), date: date.trim(), files });
  }
  return commits;
}

/**
 * Buckets commits into days (UTC). A commit counts only if it touched at least
 * one file that is not excluded (so a lockfile bump or a generated status file
 * is not "work"); binary files count as touched but add no lines.
 */
export function bucketCommits(commits, days, excludes = DEFAULT_EXCLUDES) {
  const byDay = new Map(days.map((d) => [d, { date: d, commits: 0, issues_closed: 0, lines_added: 0, lines_deleted: 0 }]));
  const seen = new Set();
  for (const c of commits) {
    if (seen.has(c.hash)) continue;
    seen.add(c.hash);
    const bucket = byDay.get(dayOf(c.date));
    if (!bucket) continue;
    const kept = c.files.filter((f) => !isExcluded(f.path, excludes));
    if (!kept.length) continue;
    bucket.commits += 1;
    for (const f of kept) {
      bucket.lines_added += f.added ?? 0;
      bucket.lines_deleted += f.deleted ?? 0;
    }
  }
  return [...byDay.values()];
}

export function addClosedIssues(buckets, closedAtList) {
  const byDay = new Map(buckets.map((b) => [b.date, b]));
  for (const at of closedAtList) {
    const b = byDay.get(dayOf(at));
    if (b) b.issues_closed += 1;
  }
  return buckets;
}

const CONCLUSIONS = { success: 'success', failure: 'failure', fail: 'failure', failed: 'failure', cancelled: 'cancelled', canceled: 'cancelled' };
export const normalizeConclusion = (v) => CONCLUSIONS[String(v ?? '').toLowerCase()] ?? 'other';

const seconds = (from, to) => {
  const s = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(s) && s >= 0 ? Math.round(s) : null;
};

/** `gh run list --json workflowName,startedAt,updatedAt,conclusion,status` → builds. */
export function githubBuilds(runs, sinceIso) {
  return runs
    .filter((r) => r.status === 'completed' && r.startedAt >= sinceIso)
    .map((r) => ({ system: 'github', name: r.workflowName || 'workflow', started_at: r.startedAt, duration_s: seconds(r.startedAt, r.updatedAt), conclusion: normalizeConclusion(r.conclusion) }))
    .filter((b) => b.duration_s !== null);
}

/** Workers Builds API `result[]` → builds. The duration is running → stopped. */
export function cloudflareBuilds(results, worker, sinceIso) {
  return results
    .filter((b) => b.status === 'stopped' && (b.running_on || b.initializing_on) >= sinceIso)
    .map((b) => {
      const start = b.running_on || b.initializing_on;
      return { system: 'cloudflare', name: worker, started_at: start, duration_s: seconds(start, b.stopped_on), conclusion: normalizeConclusion(b.build_outcome) };
    })
    .filter((b) => b.duration_s !== null);
}

/** Newest first, capped. */
export function mergeBuilds(lists, max = MAX_BUILDS) {
  return lists.flat().sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, max);
}

/** Removes // and /* *\/ comments and trailing commas outside strings, so JSONC parses. */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === '"') inString = false;
      i += 1;
    } else if (ch === '"') {
      inString = true; out += ch; i += 1;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
    } else {
      out += ch; i += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Worker names and account from a wrangler config: the top-level Worker and
 * every `env.<name>` Worker (which wrangler names `<top>-<env>` unless the env
 * sets its own name).
 * @returns {{ accountId: string|null, workers: string[] }}
 */
export function workersFromConfig(text, kind) {
  if (kind === 'toml') {
    const top = /^name\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
    const accountId = /^account_id\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
    const workers = top ? [top] : [];
    for (const m of text.matchAll(/^\[env\.([\w-]+)\]\s*\n((?:(?!^\[).*\n?)*)/gm)) {
      const own = /^name\s*=\s*"([^"]+)"/m.exec(m[2])?.[1];
      if (own || top) workers.push(own ?? `${top}-${m[1]}`);
    }
    return { accountId, workers: [...new Set(workers)] };
  }
  const cfg = JSON.parse(stripJsonc(text));
  const workers = cfg.name ? [cfg.name] : [];
  for (const [env, v] of Object.entries(cfg.env ?? {})) {
    if (v?.name || cfg.name) workers.push(v?.name ?? `${cfg.name}-${env}`);
  }
  return { accountId: cfg.account_id ?? null, workers: [...new Set(workers)] };
}

/** "git@github.com:Owner/repo.git" or "https://github.com/Owner/repo" → "Owner/repo". */
export function githubSlug(remote) {
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? m[1] : null;
}
