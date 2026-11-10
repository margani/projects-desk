// The page from status files and usage numbers. Shared by the local build
// (files on disk) and the Worker (rows from D1), so both render the same page
// and compute the same version id.
import { loadStatus } from './schema.mjs';
import { renderPage } from './render.mjs';
export { checkApps } from './apps.mjs';
export { checkUsers } from './users.mjs';

/** usage/github.json: an object, or why it cannot be shown. */
export function checkGithubUsage(usage) {
  if (!Array.isArray(usage?.accounts) || typeof usage.period !== 'string') return 'no accounts or period';
  return null;
}

/** usage/storage.json: an object, or why it cannot be shown. */
export function checkStorage(storage) {
  if (!Array.isArray(storage?.sources) || typeof storage.generated_at !== 'string') return 'no sources or generated_at';
  return null;
}

/** usage/claude.json: an object, or why it cannot be shown. */
export function checkClaude(claude) {
  if (typeof claude?.generated_at !== 'string' || !('limits' in claude)) return 'no generated_at or limits';
  return null;
}

/** JSON text → the object, or null with the reason logged. Missing or broken never fails the page. */
export function parseUsage(text, check, label, log = () => {}) {
  if (text == null) return null;
  try {
    const value = JSON.parse(text);
    const problem = check(value);
    if (problem) throw new Error(problem);
    return value;
  } catch (err) {
    log(`  INVALID  ${label}: ${err.message}`);
    return null;
  }
}

async function sha16(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * @param statusRows [{ name, text }] one per status file, raw text: a file
 *   that is not valid JSON still renders, as a warning card. { name, problem }
 *   for one that could not be read.
 * @param updatedAt ISO time of the newest data, for the footer.
 */
export async function renderSite({ statusRows, usage = null, storage = null, apps = null, claude = null, users = null, css, js, now, updatedAt = null }) {
  const entries = statusRows.map(({ name, text, problem }) => (problem ? { name, ok: false, problems: [problem] } : loadStatus(name, text)));
  // The version id is a hash of the page rendered at a fixed time with no id,
  // so it changes when content or code changes, not on every request.
  const fingerprint = renderPage(entries, { css, js, now: 0, version: '', usage, storage, apps, claude, users });
  const version = await sha16(fingerprint);
  const html = renderPage(entries, { css, js, now, version, usage, storage, apps, claude, users, updatedAt });
  return { entries, version, html };
}
