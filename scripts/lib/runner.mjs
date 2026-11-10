// Keeps the dashboard fed on a computer without systemd: Windows, macOS, or a
// Linux with no user session. Does what the systemd units in scripts/systemd/
// do on Linux. scripts/watch.mjs is the command around this.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const JOBS = [
  { name: 'publish', script: 'scripts/sync-status.mjs', every: 2 * 60_000, timeout: 120_000 },
  { name: 'usage', script: 'scripts/usage-sync.mjs', every: 10 * 60_000, timeout: 5 * 60_000 },
  { name: 'activity', script: 'scripts/activity-all.mjs', daily: [6, 30], timeout: 30 * 60_000 },
  { name: 'users', script: 'scripts/users-sync.mjs', daily: [6, 40], timeout: 5 * 60_000 },
];

export const TICK_MS = 5_000;
export const DEBOUNCE_MS = 30_000;
export const FAILURES_BEFORE_NOTICE = 15;
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_STALE_MS = 120_000;
const MAX_LOG_BYTES = 1_000_000;
const MAX_OUTPUT_CHARS = 64_000;
const OUTPUT_LINES_LOGGED = 200;
const APP_NAME = 'Projects dashboard';
// The id of Windows PowerShell itself: a toast needs a registered app to come
// from, and this one is present on every Windows without installing anything.
const WINDOWS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

export function stateDirFrom(env = process.env) {
  if (env.DESK_STATE_DIR) return env.DESK_STATE_DIR;
  return path.join(env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'projects-dashboard');
}

/** The newest scheduled time at or before `now`, in local time. */
export function latestOccurrence(now, [hour, minute]) {
  const day = new Date(now);
  day.setHours(hour, minute, 0, 0);
  if (day.getTime() > now) day.setDate(day.getDate() - 1);
  return day.getTime();
}

/** Compares wall-clock times, so a job missed while the laptop slept runs on wake. */
export function isDue(job, lastStart, now) {
  if (job.daily) return lastStart < latestOccurrence(now, job.daily);
  return now - lastStart >= job.every || lastStart > now;
}

/**
 * What changed in status/, as one string. Polled instead of fs.watch: Windows
 * also reports a file being read, so the publish itself would look like a
 * change, and on Linux the watch needs an inotify instance that can run out.
 */
export function statusSignature(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return `${f}:${stat.mtimeMs}:${stat.size}`;
    }).join('|');
  } catch {
    return '';
  }
}

/**
 * What one publish means: exit 2 is the sync refusing an empty status/ folder,
 * which is not an outage. A failed sync loses nothing, and retries every 2
 * minutes, so a notice per failure put 51 on the desktop in one DNS outage. An
 * outage gets one notice, on exactly its 15th failure in a row. A broken file
 * gets one notice per version of it, because it stays broken across runs.
 */
export function publishOutcome(previous, code, output) {
  const lines = String(output).split(/\r?\n/);
  const notices = [];
  const seen = new Set(previous.invalid ?? []);
  const invalid = [];
  const fresh = [];
  for (const line of lines) {
    const match = /^INVALID (\S+) ([^\s:]+)/.exec(line);
    if (!match) continue;
    const key = `${match[1]} ${match[2]}`;
    invalid.push(key);
    if (!seen.has(key)) fresh.push(match[1]);
  }
  if (fresh.length) notices.push(`Invalid JSON, not published: ${fresh.join(' ')}. See: node scripts/watch.mjs --status`);
  if (code === 0 || code === 2) return { state: { failures: 0, invalid }, notices };
  const failures = (previous.failures ?? 0) + 1;
  if (failures === FAILURES_BEFORE_NOTICE) {
    const reason = lines.find((l) => /^(curl: |cfapi: |Error: D1)/.test(l));
    notices.push(`Status has not reached the dashboard for about 30 minutes${reason ? ` (${reason})` : ''}. Still retrying; no more notices until it works again.`);
  }
  return { state: { failures, invalid }, notices };
}

/** The text reaches PowerShell through the environment, so none of it can run as code. */
const WINDOWS_TOAST = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$text = $xml.GetElementsByTagName('text')",
  '[void]$text.Item(0).AppendChild($xml.CreateTextNode($env:DESK_NOTICE_TITLE))',
  '[void]$text.Item(1).AppendChild($xml.CreateTextNode($env:DESK_NOTICE_BODY))',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
].join('; ');

export function noticeCommand(title, body, platform = process.platform) {
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_TOAST],
      env: { DESK_NOTICE_TITLE: title, DESK_NOTICE_BODY: body },
    };
  }
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body],
      env: {},
    };
  }
  return { cmd: 'notify-send', args: [`--app-name=${APP_NAME}`, '--urgency=critical', title, body], env: {} };
}

/** A notice that cannot be shown must not stop the runner: it is in the log anyway. */
export function notifyDesktop(title, body, { platform = process.platform, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    try {
      const { cmd, args, env } = noticeCommand(title, body, platform);
      const child = spawnImpl(cmd, args, { stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function killTree(child) {
  if (process.platform === 'win32') {
    // child.kill would leave the git and gh the script started.
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Runs one job's script; resolves { code, output }, with code null if it never finished. */
export function startJob(job, { root }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // A job has no terminal: an ssh host asking for a password must fail, not wait.
    env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes -o ConnectTimeout=15';
    let output = '';
    const keep = (chunk) => { output = (output + chunk).slice(-MAX_OUTPUT_CHARS); };
    let child;
    try {
      child = spawn(process.execPath, [path.join(root, job.script)], {
        cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a timeout can end the helpers it started.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ code: null, output: `could not start: ${err.message}` });
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ code: null, output: `${output}\ntimed out after ${job.timeout / 1000} s` });
    }, job.timeout);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, output: `could not start: ${err.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

export class Runner {
  constructor({ root, stateDir, jobs = JOBS, now = Date.now, start = startJob, notify = notifyDesktop }) {
    Object.assign(this, { root, stateDir, jobs, now, start, notify });
    this.statusDir = path.join(root, 'status');
    this.stateFile = path.join(stateDir, 'runner.json');
    this.logFile = path.join(stateDir, 'watch.log');
    this.running = new Set();
    this.changedAt = null;
    this.signature = undefined;
    fs.mkdirSync(stateDir, { recursive: true });
    this.state = readRunnerState(this.stateFile);
  }

  log(message) {
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > MAX_LOG_BYTES) {
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      }
      fs.appendFileSync(this.logFile, `${new Date(this.now()).toISOString()} ${message}\n`);
    } catch { /* a full disk must not stop the publish */ }
  }

  save() {
    try {
      const temporary = `${this.stateFile}.${process.pid}`;
      fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
      fs.renameSync(temporary, this.stateFile);
    } catch (err) {
      this.log(`could not save the runner state: ${err.message}`);
    }
  }

  due(job, now) {
    // The 2-minute poll below still applies, so files that never stop changing
    // cannot hold the publish back for ever.
    if (job.name === 'publish' && this.changedAt !== null && now - this.changedAt >= DEBOUNCE_MS) return true;
    return isDue(job, this.state.jobs[job.name]?.lastStart ?? 0, now);
  }

  /** Starts whatever is due; the promise is for tests, and the loop ignores it. */
  tick() {
    const now = this.now();
    const signature = statusSignature(this.statusDir);
    if (this.signature !== undefined && signature !== this.signature) this.changedAt = now;
    this.signature = signature;
    const started = [];
    for (const job of this.jobs) {
      if (!this.running.has(job.name) && this.due(job, now)) started.push(this.runJob(job, now));
    }
    return Promise.all(started);
  }

  async runJob(job, now) {
    this.running.add(job.name);
    // Cleared at the start, so a change made during this run is still due after it.
    if (job.name === 'publish') this.changedAt = null;
    this.state.jobs[job.name] = { ...this.state.jobs[job.name], lastStart: now };
    this.save();
    this.log(`${job.name}: started`);
    const { code, output } = await this.start(job, { root: this.root });
    this.running.delete(job.name);
    for (const line of String(output).trim().split(/\r?\n/).slice(-OUTPUT_LINES_LOGGED)) {
      if (line) this.log(`${job.name}: ${line}`);
    }
    this.log(`${job.name}: finished, exit ${code}`);
    this.state.jobs[job.name] = { ...this.state.jobs[job.name], lastEnd: this.now(), lastCode: code };
    if (job.name === 'publish') {
      const { state, notices } = publishOutcome(this.state.publish, code, output);
      this.state.publish = state;
      if (state.failures) this.log(`publish: failed (${state.failures} in a row)`);
      for (const notice of notices) {
        this.log(`notice: ${notice}`);
        await this.notify('Status publish', notice);
      }
    }
    this.save();
  }
}

export function readRunnerState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { jobs: state.jobs ?? {}, publish: state.publish ?? { failures: 0, invalid: [] } };
  } catch {
    return { jobs: {}, publish: { failures: 0, invalid: [] } };
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function readLock(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? { pid, heartbeat: fs.statSync(file).mtimeMs } : null;
  } catch {
    return null;
  }
}

/** The heartbeat is here because Windows reuses process ids: a live pid proves little. */
export function lockHeld(holder, now = Date.now(), alive = isAlive) {
  return Boolean(holder) && alive(holder.pid) && now - holder.heartbeat <= HEARTBEAT_STALE_MS;
}

/** Only one runner at a time, whatever starts it: login, a person, or both. */
export function acquireLock(file, { pid = process.pid, now = Date.now(), alive = isAlive } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      return { ok: true, pid };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const holder = readLock(file);
    if (lockHeld(holder, now, alive)) return { ok: false, pid: holder.pid };
    fs.rmSync(file, { force: true });
  }
  return { ok: false, pid: null };
}

export function touchLock(file, now = Date.now()) {
  const when = new Date(now);
  fs.utimesSync(file, when, when);
}

export { HEARTBEAT_MS };
