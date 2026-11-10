// GitHub plan usage for the accounts in github-usage.config.json: Actions
// minutes, Actions/Packages storage and what GitHub has billed this month.
// Collected on the laptop with `gh` (the page itself makes no API calls) and
// written to usage/github.json, which the build renders on the Builds view.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * What each plan includes per month, from "GitHub Actions billing"
 * (docs.github.com/en/billing/concepts/product-billing/github-actions, read
 * 2026-10-18). Storage is shared by Actions artifacts/caches and Packages.
 */
export const PLAN_QUOTAS = {
  free: { minutes: 2000, storage_gb: 0.5 },
  pro: { minutes: 3000, storage_gb: 1 },
  team: { minutes: 3000, storage_gb: 2 },
  enterprise: { minutes: 50000, storage_gb: 50 },
};

const OS = ['linux', 'windows', 'macos'];

/**
 * Per-minute rates in USD, from the same docs page (read 2026-10-20), for items
 * that carry no `pricePerUnit` (the summary shape). Included minutes are
 * measured in Linux minutes: GitHub counts usage by cost, so a macOS minute
 * uses about ten of them.
 */
const RATE = { linux: 0.006, windows: 0.01, macos: 0.062 };

/**
 * Sums billing usage items into the numbers the page shows. Takes the detailed
 * report (`quantity`, `unitType: "Minutes"`, `sku: "Actions Linux"`, one item
 * per day and repository) and the summary shape (`grossQuantity`,
 * `unitType: "minutes"`, `sku: "actions_linux"`).
 * Minutes are raw minutes per OS, and `counted` is what they use of the
 * quota: each minute at its price in Linux minutes. Adding raw minutes reads far below what GitHub bills.
 * Standard runners are free in public repositories and the quota is defined
 * for private ones, so minutes of a repository `visibility` names as public
 * go to `public` and only the rest count (`total`).
 * Storage is GB-hours divided by the hours elapsed this month: the average
 * held so far, which is what the GB quota is measured against.
 */
export function summarise(items, { plan, now, visibility = new Map() }) {
  const minutes = { linux: 0, windows: 0, macos: 0, other: 0 };
  let publicMinutes = 0;
  let counted = 0;
  const byRepo = new Map();
  let gbHours = 0;
  let billed = 0;
  for (const it of items) {
    const qty = it.quantity ?? it.grossQuantity ?? 0;
    const unit = (it.unitType ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const sku = (it.sku ?? '').toLowerCase();
    billed += it.netAmount ?? 0;
    if (unit === 'minutes' && it.product?.toLowerCase() === 'actions') {
      const os = OS.find((o) => sku.includes(o)) ?? 'other';
      if (visibility.get(it.repositoryName) === 'public') publicMinutes += qty;
      else {
        minutes[os] += qty;
        counted += (qty * (it.pricePerUnit ?? RATE[os] ?? RATE.linux)) / RATE.linux;
      }
      if (it.repositoryName) byRepo.set(it.repositoryName, (byRepo.get(it.repositoryName) ?? 0) + qty);
    } else if (unit === 'gigabytehours') {
      gbHours += qty;
    }
  }
  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const hours = Math.max(1, (now - monthStart) / 3_600_000);
  const quota = PLAN_QUOTAS[plan] ?? null;
  const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    plan,
    minutes: {
      ...Object.fromEntries(Object.entries(minutes).map(([k, v]) => [k, Math.round(v)])),
      total: Math.round(minutes.linux + minutes.windows + minutes.macos + minutes.other),
      public: Math.round(publicMinutes),
      counted: Math.round(counted),
      included: quota?.minutes ?? null,
    },
    repos: [...byRepo].map(([name, m]) => ({ name, minutes: Math.round(m), public: visibility.get(name) === 'public' }))
      .filter((r) => r.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
    storage: { gb: round(gbHours / hours, 3), included_gb: quota?.storage_gb ?? null },
    billed_usd: round(billed, 2),
    problem: null,
  };
}

async function gh(args) {
  const { stdout } = await run('gh', ['api', ...args], { timeout: 30_000 });
  return JSON.parse(stdout);
}

/** Turns a gh failure into one line the page can show. */
function explain(err) {
  const text = `${err.stderr ?? ''} ${err.message ?? ''}`;
  if (/needs the "user" scope/.test(text)) return 'gh cannot read this account yet: it needs the "user" scope (gh auth refresh -h github.com -s user).';
  if (/HTTP 403|HTTP 404/.test(text)) return `GitHub refused the billing read (${text.match(/HTTP \d+/)[0]}).`;
  return `Could not read usage: ${text.trim().split('\n')[0].slice(0, 160)}`;
}

/** One account: { login, kind: 'org' | 'user' } → its summary, or a problem. */
export async function collectAccount({ login, kind }, { now = Date.now(), api = gh } = {}) {
  try {
    const owner = await api([kind === 'org' ? `orgs/${login}` : 'user']);
    const plan = owner.plan?.name ?? null;
    // The detailed report, not the summary: only it names the repository.
    const d = new Date(now);
    const month = `year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}`;
    const base = kind === 'org' ? `organizations/${login}` : `users/${login}`;
    const usage = await api([`${base}/settings/billing/usage?${month}`]);
    const items = usage.usageItems ?? [];
    // A repository that cannot be read (deleted, renamed) stays counted.
    const names = [...new Set(items.map((it) => it.repositoryName).filter(Boolean))];
    const visibility = new Map(await Promise.all(names.map(async (name) => {
      try {
        return [name, (await api([`repos/${login}/${name}`])).visibility ?? null];
      } catch {
        return [name, null];
      }
    })));
    return { login, kind, ...summarise(items, { plan, now, visibility }) };
  } catch (err) {
    return { login, kind, plan: null, minutes: null, repos: [], storage: null, billed_usd: null, problem: explain(err) };
  }
}

export async function collectUsage(accounts, { now = Date.now(), api } = {}) {
  const date = new Date(now);
  return {
    generated_at: date.toISOString().replace(/\.\d+Z$/, 'Z'),
    period: date.toISOString().slice(0, 7),
    accounts: await Promise.all(accounts.map((a) => collectAccount(a, { now, api }))),
  };
}
