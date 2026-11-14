// The Desktop, the first page: the projects' apps as icons, the way a
// user of them would see them. Every icon opens its app in a new tab.
// Icons come from the status file or, failing
// that, from the laptop's probe (usage/apps.json).
import { escapeHtml as e } from './render.mjs';
import { appList } from './apps.mjs';

// Letter tiles for apps without an icon: a stable colour per name.
const TILE_COLOURS = 6;
function tileColour(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % TILE_COLOURS;
}

const SAFE_ICON = /^(https:\/\/|data:image\/(png|gif|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)[;,])/i;

function iconHtml(name, icon) {
  const letter = `<span class="desk-letter" data-c="${tileColour(name)}" aria-hidden="true">${e([...name][0].toUpperCase())}</span>`;
  if (!icon || !SAFE_ICON.test(icon)) return letter;
  // The letter stays underneath: client.js removes an image that fails to load.
  return `${letter}<img src="${e(icon)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

/**
 * Entries + probe → the icons. A probed icon counts only for the same project
 * and URL; an icon named in the status file wins over it.
 */
export function desktopApps(entries, apps) {
  const key = (a) => `${a.project}\n${a.url}`;
  const probe = new Map((apps?.apps ?? []).map((a) => [key(a), a]));
  return appList(entries).map((a, i) => {
    const p = probe.get(key(a));
    return { ...a, id: `${a.project}/${a.name}`, icon: a.icon ?? p?.icon ?? null };
  });
}

// A status file names an app as its project is named ("chogan"), so the
// Desktop shows the first letter in upper case, the way an app is titled.
function displayName(name) {
  const [first = '', ...rest] = [...name];
  return first.toUpperCase() + rest.join('');
}

// Sorted by what the user reads, not by project: a project with several apps
// had them in its own order, so the grid was not alphabetical. The project
// only breaks a tie, so the order is stable.
const byName = (a, b) => displayName(a.name).localeCompare(displayName(b.name), undefined, { sensitivity: 'base', numeric: true })
  || a.project.localeCompare(b.project);

export function renderDesktop(entries, apps) {
  const list = desktopApps(entries, apps).sort(byName);
  const icons = list.map((a) => {
    const who = a.name === a.project ? a.name : `${a.name} · ${a.project}`;
    return `
      <li><a class="desk-app" href="${e(a.url)}" target="_blank" rel="noopener" data-app="${e(a.id)}" title="${e(`${who} · ${new URL(a.url).host}`)}">
        <span class="desk-icon">${iconHtml(a.name, a.icon)}</span>
        <span class="desk-name">${e(displayName(a.name))}</span>
      </a></li>`;
  }).join('');
  return `
  <section class="view desktop" data-view="desktop" data-title="Desktop" aria-labelledby="desktop-heading">
    <h2 id="desktop-heading" class="sr-only" tabindex="-1">Desktop</h2>
    ${list.length ? `<ul class="desk-icons" role="list">${icons}
    </ul>` : '<p class="empty">No apps yet: a project shows here once its status file has a production URL.</p>'}
  </section>`;
}
