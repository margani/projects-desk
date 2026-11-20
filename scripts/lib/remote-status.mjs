// Status files written by sessions on other machines (rc.sh --on <machine>)
// are copied here over ssh just before each sync, so no remote machine needs
// access to this one. The page still reads only D1.
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const DIR = /^[A-Za-z0-9._/-]+$/;

/** Runs a program and resolves {code, stdout}; never rejects, so one machine cannot stop the others. */
export function runProgram(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The remote machines in `machines`; the local one never appears. Any project may run on any of them. */
export function remoteMachines(config, local = process.env.RC_MACHINE || 'claude') {
  return Object.keys(config?.machines ?? {}).filter((m) => m !== local);
}

/** The remote shell command: per status file, a marker line with its mtime, the file, an end marker. */
export function remoteCommand(projectsDir) {
  return `for f in "$HOME/${projectsDir}/projects-dashboard/status"/*.json; do [ -f "$f" ] || continue; p=$(basename "$f" .json); echo "@@FILE $p $(date -r "$f" +%s)"; cat "$f"; echo; echo "@@END"; done`;
}

export function parseRemote(stdout) {
  const files = [];
  let current = null;
  for (const line of stdout.split('\n')) {
    const head = /^@@FILE (\S+) (\d+)$/.exec(line);
    if (head) current = { project: head[1], mtime: Number(head[2]), lines: [] };
    else if (line === '@@END') { if (current) files.push({ ...current, text: current.lines.join('\n').trim() + '\n' }); current = null; }
    else if (current) current.lines.push(line);
  }
  return files;
}

/**
 * Copies every status file on every remote machine into statusDir when the
 * remote one is newer than the local one, so with one project on two machines
 * the most recent write wins and a stale copy never overwrites live work.
 * Returns log lines: "PULLED <project> from <machine>" and "REMOTE <machine>:
 * <problem>". A machine that is off, a missing file or a file that is not JSON
 * leaves the last copy where it is; none of it fails the sync.
 */
export async function pullRemoteStatus(config, statusDir, { run = runProgram, timeoutSeconds = 5 } = {}) {
  const log = [];
  // All machines are asked at once: a laptop that is off costs one ConnectTimeout in
  // total, not one per machine (two off laptops delayed every sync by 10 s, #37).
  // Results are applied in config order, so the newest-wins rule stays deterministic.
  const asked = remoteMachines(config).map((machine) => {
    const spec = config.machines[machine] ?? {};
    const alias = spec.ssh ?? machine;
    const projectsDir = spec.projects_dir ?? 'projects/personal';
    if (!ALIAS.test(alias) || !DIR.test(projectsDir)) return { machine, skipped: true };
    return { machine, reply: run('ssh', ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeoutSeconds}`, '--', alias, remoteCommand(projectsDir)]) };
  });
  for (const { machine, skipped, reply } of asked) {
    if (skipped) { log.push(`REMOTE ${machine}: ssh alias or projects_dir is not plain; skipped`); continue; }
    const r = await reply;
    if (r.code !== 0) { log.push(`REMOTE ${machine}: unreachable or failed (exit ${r.code}); keeping the last copies`); continue; }
    for (const f of parseRemote(r.stdout)) {
      if (!PLAIN.test(f.project)) continue;
      try { JSON.parse(f.text); } catch (err) { log.push(`REMOTE ${machine}: ${f.project}.json is not JSON (${err.message}); keeping the last copy`); continue; }
      const target = path.join(statusDir, `${f.project}.json`);
      const local = await stat(target).catch(() => null);
      if (local && Math.floor(local.mtimeMs / 1000) >= f.mtime) continue;
      if (local && (await readFile(target, 'utf8')) === f.text) continue;
      await writeFile(`${target}.tmp`, f.text);
      await utimes(`${target}.tmp`, f.mtime, f.mtime);
      await rename(`${target}.tmp`, target);
      log.push(`PULLED ${f.project} from ${machine}`);
    }
  }
  return log;
}
