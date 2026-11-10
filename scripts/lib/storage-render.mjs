// Storage (usage/storage.json) on its own view (#/storage), and
// a line on the Overview only when something is nearly full.
import { escapeHtml as e, relativeTime } from './render.mjs';

const NEAR = 80;
const FULL = 90;

/** Decimal units, as disks and clouds sell them (a 12 TB drive reads 12.0 TB). */
export function bytes(n) {
  if (n == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (Math.abs(v) >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  // 10 GB, not 10.0 GB: limits are round numbers. 1.10 TB keeps its zero,
  // so it lines up with 1.11 TB in the next row.
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0).replace(/\.0+$/, '')} ${units[i]}`;
}

/** 'full' (red, ≥90%) | 'near' (amber, ≥80%) | 'ok'; null when unknown. */
export function storageLevel(pct) {
  if (pct == null) return null;
  if (pct >= FULL) return 'full';
  return pct >= NEAR ? 'near' : 'ok';
}

// The meter colours of GitHub usage: near is amber, over is red.
const METER = { full: 'over', near: 'near', ok: 'ok' };
const LABEL = { full: 'Almost full', near: 'Filling up' };

function valueText(s) {
  if (s.kind === 'R2') return `${bytes(s.used)} <span class="muted">of ${bytes(s.limit.free_tier)} free tier</span>`;
  if (s.kind === 'D1') return bytes(s.used);
  return `${bytes(s.used)} of ${bytes(s.total)}`;
}

function subText(s) {
  const parts = [];
  if (s.percent != null) parts.push(`${s.percent.toLocaleString('en-GB')}% used`);
  if (s.kind === 'R2') parts.push(`${s.objects.toLocaleString('en-GB')} objects`);
  else if (s.kind === 'D1') {
    if (s.limit) parts.push(`limit ${bytes(s.limit.per_item)} per database, ${bytes(s.limit.account)} per account (${e(s.limit.plan)})`);
  } else if (s.free != null) parts.push(`${bytes(s.free)} free`);
  if (s.trashed) parts.push(`${bytes(s.trashed)} in trash`);
  if (s.other) parts.push(`${bytes(s.other)} in Gmail and Photos`);
  return parts.join(' · ');
}

/** Databases or buckets, biggest first, on one shared scale. */
function renderItems(s) {
  if (!s.items?.length) return '';
  const what = s.kind === 'D1' ? 'Databases' : 'Buckets';
  const max = s.items[0].used || 1;
  const rows = s.items.map((it) => `
          <li><span class="repo-name" title="${e(it.name)}">${e(it.name)}</span><span class="repo-bar"><span style="width:${((it.used / max) * 100).toFixed(1)}%"></span></span><span class="repo-min"${it.objects != null ? ` title="${it.objects.toLocaleString('en-GB')} ${it.objects === 1 ? 'object' : 'objects'}"` : it.percent != null ? ` title="${it.percent}% of the per-database limit"` : ''}>${bytes(it.used)}</span></li>`).join('');
  return `
      <details class="repo-usage" open>
        <summary>${what} · ${s.items.length}</summary>
        <ul>${rows}
        </ul>
      </details>`;
}

function renderRow(s, now) {
  // The card already says "OneDrive" or "Cloudflare D1"; the kind only adds
  // something for disks (ext4, ntfs3).
  const kind = s.group.includes(s.kind) ? '' : ` <span class="storage-kind">${e(s.kind)}</span>`;
  const title = `<span class="meter-name">${e(s.name)}${kind}</span>`;
  if (s.used == null) {
    return `
      <div class="meter storage-row" data-level="${s.disabled ? 'off' : 'error'}">
        <div class="meter-head">${title}</div>
        <p class="usage-problem${s.disabled ? '' : ' storage-error'}">${s.disabled ? '' : '<span class="meter-flag">Not read</span>'}${e(s.problem)}</p>
      </div>`;
  }
  const lv = storageLevel(s.percent);
  const pct = Math.min(100, Math.max(0, s.percent ?? 0));
  const text = valueText(s);
  return `
      <div class="meter storage-row" data-level="${METER[lv] ?? 'unknown'}">
        <div class="meter-head">${title}<span class="meter-value">${text}</span></div>
        <span class="meter-track" role="img" aria-label="${e(`${s.name}: ${s.percent ?? '?'}% used`)}"><span class="meter-fill" style="width:${pct.toFixed(1)}%"></span></span>
        <p class="meter-sub">${LABEL[lv] ? `<span class="meter-flag">${LABEL[lv]}</span>` : ''}${subText(s)}${s.read_at ? '' : s.problem ? ` · ${e(s.problem)}` : ''}</p>${s.read_at ? `
        <p class="usage-problem storage-stale"><span class="meter-flag">Last reading</span><time datetime="${e(s.read_at)}" data-rel title="${e(s.read_at)}">${e(relativeTime(s.read_at, now))}</time> · ${e(s.problem)}</p>` : ''}
      </div>${renderItems(s)}`;
}

export function renderStorage(storage, now) {
  if (!storage?.sources?.length) return '';
  const groups = new Map();
  for (const s of storage.sources) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  const cards = [...groups].map(([name, rows]) => `
    <div class="usage-account">
      <h3>${e(name)}</h3>${rows.map((s) => renderRow(s, now)).join('')}
    </div>`).join('');
  return `
  <section class="panel usage storage" aria-labelledby="storage-heading">
    <h2 id="storage-heading" tabindex="-1">Storage</h2>
    <div class="usage-grid">${cards}
    </div>
    <p class="viz-foot"><span>Disks: % used as df shows it (space kept for root not counted as free). Trash counts as used until it is emptied. D1: the bar is the database or account closest to its limit. R2: largest size held in the last day.</span><span>Read <time datetime="${e(storage.generated_at)}" data-rel title="${e(storage.generated_at)}">${e(relativeTime(storage.generated_at, now))}</time></span></p>
  </section>`;
}

/** Overview line: only places at 80% or more. Unread sources show on the Storage view, not here. */
export function renderStorageAlert(storage) {
  const hits = (storage?.sources ?? [])
    .filter((s) => s.used != null && storageLevel(s.percent) !== 'ok' && storageLevel(s.percent) !== null)
    .sort((a, b) => b.percent - a.percent)
    .map((s) => `${s.group} ${s.name}: ${s.percent}% used`);
  if (!hits.length) return '';
  return `
    <a class="usage-alert" href="#/storage"><span class="meter-flag">Storage</span>${hits.map(e).join(' · ')}</a>`;
}
