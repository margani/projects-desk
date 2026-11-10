// The laptop's side of the dashboard database: status files and usage
// numbers go into D1 through the Cloudflare API with the saved `edit` token
// (it has D1 Edit), via `cfapi`, which never prints the token.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run } from './storage-usage.mjs';
import { loadDeskConfig } from './config.mjs';

/**
 * Runs statements as one batch: [{ sql, params }] → one result per statement.
 * `target` is another project's database for reads, with the read token.
 * The body goes through a temporary file, since status files with a year of
 * activity are too long for an argument.
 */
export async function query(statements, { exec = run, write = false, timeout = 60_000, target = loadDeskConfig().d1 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dashboard-d1-'));
  const file = path.join(dir, 'body.json');
  try {
    await writeFile(file, JSON.stringify(statements.length === 1 ? statements[0] : { batch: statements }), { mode: 0o600 });
    let stdout;
    try {
      ({ stdout } = await exec('cfapi', [...(write ? ['--edit'] : []), 'POST', `/accounts/${target.account}/d1/database/${target.database}/query`, '--data-binary', `@${file}`], { timeout }));
    } catch (err) {
      const body = (() => { try { return JSON.parse(err.stdout); } catch { return null; } })();
      if (body?.errors?.length) err.message = `D1: ${body.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`;
      else if (err.timedOut) err.message = `D1: no answer after ${err.timedOut / 1000} s`;
      throw err;
    }
    const body = JSON.parse(stdout);
    if (!body.success) throw new Error(`D1: ${(body.errors ?? []).map((e) => e.message).join('; ') || 'query failed'}`);
    return body.result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * What to change in D1 for the status files on disk.
 * @param files [{ name, text }] every status/*.json
 * @param remote [{ project, sha }] what D1 holds
 * A file that is not valid JSON is left out, so the page keeps its last good
 * copy, as the watcher did when it refused to commit one. Projects whose file
 * is gone are deleted.
 */
export function planSync(files, remote, now) {
  const have = new Map(remote.map((r) => [r.project, r.sha]));
  const invalid = [];
  const upserts = [];
  for (const f of files) {
    try {
      const value = JSON.parse(f.text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('top level is not a JSON object');
    } catch (err) {
      invalid.push({ name: f.name, sha: sha256(f.text), message: err.message });
      continue;
    }
    const sha = sha256(f.text);
    if (have.get(f.name) !== sha) upserts.push({ name: f.name, text: f.text, sha });
  }
  const local = new Set(files.map((f) => f.name));
  const deletes = [...have.keys()].filter((p) => !local.has(p)).sort();
  const at = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
  const statements = [
    ...upserts.map((u) => ({
      sql: 'INSERT INTO status (project, body, sha, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project) DO UPDATE SET body = excluded.body, sha = excluded.sha, updated_at = excluded.updated_at',
      params: [u.name, u.text, u.sha, at],
    })),
    ...deletes.map((p) => ({ sql: 'DELETE FROM status WHERE project = ?', params: [p] })),
  ];
  return { upserts: upserts.map((u) => u.name), deletes, invalid, statements };
}

/** One usage row (key 'github', 'storage', 'apps' or 'claude'). */
export function usageStatement(key, value, now) {
  return {
    sql: 'INSERT INTO usage (key, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at',
    params: [key, JSON.stringify(value), new Date(now).toISOString().replace(/\.\d+Z$/, 'Z')],
  };
}
