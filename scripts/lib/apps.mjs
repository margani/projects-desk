// The Desktop's apps: a project's own "apps" list, or else one app
// from its production URL. Every icon opens its app in a new tab. The laptop
// probes each app with the usage timer for its icon (and records whether it
// could be framed, which the page no longer uses); the result goes into D1
// like the other usage numbers, so the page itself still makes no calls.

const isWeb = (url) => {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
};

/**
 * Desktop icons, by project name, then in each project's own order. A project
 * with "apps" gets exactly those ([] hides it); otherwise its production URL
 * becomes one app named after the project, unless that URL is a GitHub page or
 * this dashboard itself.
 */
export function appList(entries, self = 'projects-dashboard') {
  const apps = [];
  const projects = entries.filter((x) => x.ok).map((x) => x.data).sort((a, b) => a.project.localeCompare(b.project));
  for (const d of projects) {
    if (Array.isArray(d.apps)) {
      for (const a of d.apps) {
        if (isWeb(a.url)) apps.push({ project: d.project, name: a.name, url: a.url, icon: a.icon ?? null });
      }
      continue;
    }
    const url = d.urls?.production;
    if (!url || d.project === self || !isWeb(url) || new URL(url).hostname === 'github.com') continue;
    apps.push({ project: d.project, name: d.project, url, icon: null });
  }
  return apps;
}

const ACCESS = /\.cloudflareaccess\.com$/;

/**
 * Whether a response may be shown in a frame on the dashboard's hosts.
 * X-Frame-Options DENY or SAMEORIGIN refuses (the app is another origin);
 * CSP frame-ancestors must name * , https: or a matching host.
 */
export function frameVerdict(headers, hosts) {
  const xfo = (headers.get('x-frame-options') || '').trim().toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return { framable: false, reason: `X-Frame-Options: ${xfo.toUpperCase()}` };
  const csp = headers.get('content-security-policy') || '';
  const m = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp);
  if (!m) return { framable: true, reason: null };
  const sources = m[1].trim().split(/\s+/);
  const ok = hosts.every((h) => sources.some((s) => {
    if (s === '*' || s === 'https:') return true;
    const host = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host.startsWith('*.')) return h.endsWith(host.slice(1));
    return host === h;
  }));
  return ok ? { framable: true, reason: null } : { framable: false, reason: `frame-ancestors ${m[1].trim()}` };
}

/** The best icon a page names: apple-touch-icon (large), then any rel=icon; absolute URL or null. */
export function iconFromHtml(html, base) {
  // [^<>]: with [^>], '<link' repeated without a '>' rescanned the rest of
  // the page at every start, quadratic in a body the remote app controls.
  const links = [...html.slice(0, MAX_BODY).matchAll(/<link\b[^<>]*>/gi)].map((t) => t[0]);
  const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(2).find((v) => v != null);
  const pick = (re) => links.find((t) => re.test(attr(t, 'rel') || '') && attr(t, 'href'));
  const tag = pick(/apple-touch-icon/i) || pick(/(^|\s)icon(\s|$)/i);
  if (!tag) return null;
  const href = attr(tag, 'href');
  // An inline data: icon is kept as it is; it costs nothing to show.
  if (/^data:image\//i.test(href)) return href.length <= 4000 ? href : null;
  try {
    const u = new URL(href, base);
    return u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

// Only the start of a page is read: the icon links sit in its head.
const MAX_BODY = 512 * 1024;

/** The first MAX_BODY bytes of a body as text; the rest is not downloaded. */
async function readCapped(res) {
  if (!res.body?.getReader) return (await res.text()).slice(0, MAX_BODY);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, MAX_BODY);
}

// The deadline covers the body too: it used to end with the headers, so
// an app that sent headers and then held the body open stalled the probe, and
// with it every other usage number, until systemd killed the run.
async function fetchWithTimeout(fetchImpl, url, init, ms, read = null) {
  const ctl = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(Object.assign(new Error('timed out'), { name: 'AbortError' }));
    }, ms);
  });
  const work = (async () => {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal });
    const body = read ? await read(res) : null;
    if (!read) res.body?.cancel?.().catch(() => {});
    return { res, body };
  })();
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
}

/** Probes one app: where it ends up anonymously, whether it can be framed, its icon. */
export async function probeApp({ project, name = project, url }, { fetchImpl = fetch, timeoutMs = 10000, hosts = [] } = {}) {
  const out = { project, name, url, framable: null, reason: null, icon: null };
  let res, body;
  const htmlBody = (r) => (r.ok && /text\/html/i.test(r.headers.get('content-type') || '') && !ACCESS.test(new URL(r.url || url).hostname) ? readCapped(r) : null);
  try {
    ({ res, body } = await fetchWithTimeout(fetchImpl, url, { redirect: 'follow', headers: { 'user-agent': 'projects-desk app probe' } }, timeoutMs, htmlBody));
  } catch (err) {
    out.reason = err.name === 'AbortError' ? `no answer in ${timeoutMs / 1000}s` : `unreachable: ${err.message}`;
    return out;
  }
  const final = new URL(res.url || url);
  if (ACCESS.test(final.hostname)) {
    // The login page cannot be framed, and the app's own headers stay unknown.
    out.framable = false;
    out.reason = 'behind Cloudflare Access';
  } else {
    Object.assign(out, frameVerdict(res.headers, hosts));
    if (body != null) out.icon = iconFromHtml(body, final.href);
  }
  if (!out.icon && !ACCESS.test(final.hostname)) {
    try {
      const { res: fav } = await fetchWithTimeout(fetchImpl, new URL('/favicon.ico', url).href, { redirect: 'follow' }, timeoutMs);
      if (fav.ok && /^image\//i.test(fav.headers.get('content-type') || '') && !ACCESS.test(new URL(fav.url || url).hostname)) {
        out.icon = new URL('/favicon.ico', url).href;
      }
    } catch { /* no favicon: the page draws a letter tile */ }
  }
  return out;
}

export async function collectApps(entries, opts = {}) {
  // One failing probe becomes its own row; it never fails the whole collection.
  const list = appList(entries);
  const settled = await Promise.allSettled(list.map((a) => probeApp(a, opts)));
  const apps = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { project: list[i].project, name: list[i].name, url: list[i].url, framable: null, reason: `probe failed: ${s.reason?.message ?? s.reason}`, icon: null }));
  return { generated_at: new Date(opts.now ?? Date.now()).toISOString(), apps };
}

/** usage/apps.json: an object, or why it cannot be shown. */
export function checkApps(value) {
  if (!Array.isArray(value?.apps) || typeof value.generated_at !== 'string') return 'no apps or generated_at';
  return null;
}
