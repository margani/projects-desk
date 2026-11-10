// The computer side without systemd: schedule, one notice per outage, the lock,
// autostart files, and a real background round trip on whatever system runs this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JOBS, DEBOUNCE_MS, FAILURES_BEFORE_NOTICE, Runner, isDue, latestOccurrence, publishOutcome, noticeCommand,
  notifyDesktop, acquireLock, readLock, lockHeld, stateDirFrom,
} from '../scripts/lib/runner.mjs';
import { windowsStartupDir, windowsStartupScript, launchdPlist } from '../scripts/lib/autostart.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const MINUTE = 60_000;
const temp = () => mkdtempSync(path.join(tmpdir(), 'desk-runner-'));
const at = (day, hour, minute) => new Date(2026, 10, day, hour, minute).getTime();
const job = (name) => JOBS.find((j) => j.name === name);

test('schedule: the jobs match the systemd timers', () => {
  assert.equal(job('publish').every, 2 * MINUTE);
  assert.equal(job('usage').every, 10 * MINUTE);
  assert.deepEqual(job('activity').daily, [6, 30]);
  assert.deepEqual(job('users').daily, [6, 40]);
  for (const { script } of JOBS) assert.ok(existsSync(path.join(root, script)), script);
});

test('schedule: an interval job is due after its interval, or if the clock went back', () => {
  const usage = job('usage');
  assert.equal(isDue(usage, at(10, 12, 0), at(10, 12, 9)), false);
  assert.equal(isDue(usage, at(10, 12, 0), at(10, 12, 10)), true);
  assert.equal(isDue(usage, at(10, 12, 0), at(10, 11, 0)), true);
});

test('schedule: a daily job runs once per day, and catches up after the laptop slept through it', () => {
  const activity = job('activity');
  assert.equal(latestOccurrence(at(10, 6, 29), [6, 30]), at(9, 6, 30));
  assert.equal(latestOccurrence(at(10, 6, 30), [6, 30]), at(10, 6, 30));
  assert.equal(isDue(activity, at(9, 7, 0), at(10, 6, 29)), false, 'not before its time');
  assert.equal(isDue(activity, at(9, 7, 0), at(10, 6, 31)), true, 'at its time');
  assert.equal(isDue(activity, at(10, 6, 31), at(10, 22, 0)), false, 'once a day');
  assert.equal(isDue(activity, at(5, 7, 0), at(10, 23, 0)), true, 'woke up days later');
});

test('publish: an outage gives exactly one notice, on the 15th failure, and a success starts over', () => {
  let state = { failures: 0, invalid: [] };
  const run = (code, output = '') => {
    const result = publishOutcome(state, code, output);
    state = result.state;
    return result.notices;
  };
  const failure = 'something\ncfapi: could not reach api.cloudflare.com: ENOTFOUND\n';
  const notices = Array.from({ length: 40 }, () => run(1, failure));
  assert.equal(notices.flat().length, 1, 'one notice in 40 failed passes');
  assert.equal(notices.findIndex((n) => n.length > 0) + 1, FAILURES_BEFORE_NOTICE);
  assert.match(notices.flat()[0], /about 30 minutes \(cfapi: could not reach api\.cloudflare\.com: ENOTFOUND\)/);
  assert.match(notices.flat()[0], /no more notices until it works again/);
  assert.deepEqual(run(0), []);
  assert.equal(state.failures, 0);
  assert.equal(Array.from({ length: 15 }, () => run(1)).flat().length, 1, 'a new outage gets its own notice');
});

test('publish: exit 2 (no status files yet) is not an outage', () => {
  const { state, notices } = publishOutcome({ failures: 14, invalid: [] }, 2, '');
  assert.equal(state.failures, 0);
  assert.deepEqual(notices, []);
});

test('publish: a broken file gets one notice per version of it', () => {
  const first = publishOutcome({ failures: 0, invalid: [] }, 0, 'INVALID a.json aaa: bad\nINVALID b.json bbb: bad\n');
  assert.equal(first.notices.length, 1);
  assert.match(first.notices[0], /a\.json b\.json/);
  const again = publishOutcome(first.state, 0, 'INVALID a.json aaa: bad\nINVALID b.json bbb: bad\n');
  assert.deepEqual(again.notices, []);
  const changed = publishOutcome(again.state, 0, 'INVALID a.json ccc: bad\nINVALID b.json bbb: bad\n');
  assert.equal(changed.notices.length, 1);
  assert.match(changed.notices[0], /a\.json/);
  assert.doesNotMatch(changed.notices[0], /b\.json/);
});

test('notice: the text never becomes part of a script', () => {
  const nasty = `x'; Remove-Item C:\\ "$(boom)`;
  const windows = noticeCommand('title', nasty, 'win32');
  assert.equal(windows.cmd, 'powershell.exe');
  assert.ok(!windows.args.join(' ').includes(nasty), 'it travels in the environment');
  assert.equal(windows.env.DESK_NOTICE_BODY, nasty);
  const mac = noticeCommand('title', nasty, 'darwin');
  assert.equal(mac.args.at(-1), nasty, 'a separate argument');
  assert.ok(!mac.args.slice(0, -2).join(' ').includes(nasty));
  const linux = noticeCommand('title', nasty, 'linux');
  assert.equal(linux.cmd, 'notify-send');
  assert.equal(linux.args.at(-1), nasty);
});

test('notice: one that cannot be shown does not stop the runner', async () => {
  const failing = () => { throw new Error('no such program'); };
  assert.equal(await notifyDesktop('t', 'b', { spawnImpl: failing }), false);
});

test('notice: Windows accepts the toast command', { skip: process.platform !== 'win32' && 'needs Windows' }, async () => {
  assert.equal(await notifyDesktop('projects-desk test', 'A check from CI'), true);
});

function makeRunner({ now, results = () => ({ code: 0, output: '' }), jobs = JOBS }) {
  const dir = temp();
  mkdirSync(path.join(dir, 'status'));
  const started = [];
  const notices = [];
  const pending = new Map();
  const options = {
    root: dir, stateDir: path.join(dir, 'state'), jobs, now: () => now.value,
    start: (j) => {
      started.push(j.name);
      if (results === 'hold') return new Promise((resolve) => pending.set(j.name, resolve));
      return Promise.resolve(results(j));
    },
    notify: async (title, body) => { notices.push(body); },
  };
  return { runner: new Runner(options), options, started, notices, pending, dir };
}

test('runner: the first tick runs every job, and a restart remembers what already ran', async () => {
  const now = { value: at(10, 12, 0) };
  const { runner, options, started } = makeRunner({ now });
  await runner.tick();
  assert.deepEqual(started.slice().sort(), JOBS.map((j) => j.name).sort());
  const count = started.length;
  await runner.tick();
  assert.equal(started.length, count, 'nothing is due straight after');
  now.value += MINUTE;
  await new Runner(options).tick();
  assert.equal(started.length, count, 'a restarted runner does not repeat them');
});

test('runner: a job still running is not started again', async () => {
  const now = { value: at(10, 12, 0) };
  const { runner, started, pending } = makeRunner({ now, results: 'hold', jobs: [job('publish')] });
  const first = runner.tick();
  now.value += 10 * MINUTE;
  runner.tick();
  assert.deepEqual(started, ['publish']);
  pending.get('publish')({ code: 0, output: '' });
  await first;
  // Not awaited: this second run is held open too.
  runner.tick();
  assert.deepEqual(started, ['publish', 'publish']);
});

test('runner: a status change is published after 30 quiet seconds, without waiting for the poll', async () => {
  const now = { value: at(10, 12, 0) };
  const { runner, started, dir } = makeRunner({ now, jobs: [job('publish')] });
  await runner.tick();
  assert.equal(started.length, 1);
  now.value += 5_000;
  writeFileSync(path.join(dir, 'status/a.json'), '{}');
  await runner.tick();
  assert.equal(started.length, 1, 'not at once');
  now.value += DEBOUNCE_MS - 5_000;
  await runner.tick();
  assert.equal(started.length, 1, 'still inside the quiet period');
  now.value += 5_000;
  await runner.tick();
  assert.equal(started.length, 2);
});

test('runner: a change made during a publish is published afterwards', async () => {
  const now = { value: at(10, 12, 0) };
  const { runner, started, dir, pending } = makeRunner({ now, results: 'hold', jobs: [job('publish')] });
  const first = runner.tick();
  writeFileSync(path.join(dir, 'status/a.json'), '{}');
  now.value += 5_000;
  runner.tick();
  pending.get('publish')({ code: 0, output: '' });
  await first;
  now.value += DEBOUNCE_MS;
  runner.tick();
  assert.equal(started.length, 2);
});

test('runner: files that never stop changing still publish on the 2-minute poll', async () => {
  const now = { value: at(10, 12, 0) };
  const { runner, started, dir } = makeRunner({ now, jobs: [job('publish')] });
  await runner.tick();
  for (let i = 0; i < 8; i++) {
    now.value += 15_000;
    writeFileSync(path.join(dir, `status/${i}.json`), '{}');
    await runner.tick();
  }
  assert.equal(started.length, 2);
});

test('runner: a long outage reaches the desktop once, and the count survives a restart', async () => {
  const now = { value: at(10, 12, 0) };
  const results = () => ({ code: 1, output: 'cfapi: could not reach api.cloudflare.com: ENOTFOUND' });
  const made = makeRunner({ now, results, jobs: [job('publish')] });
  let runner = made.runner;
  for (let i = 0; i < 30; i++) {
    await runner.tick();
    now.value += 2 * MINUTE;
    if (i === 7) runner = new Runner(made.options);
  }
  assert.equal(made.started.length, 30);
  assert.equal(made.notices.length, 1);
});

test('lock: a second runner is refused while the first is alive', () => {
  const file = path.join(temp(), 'watch.lock');
  assert.deepEqual(acquireLock(file, { pid: 111, alive: () => true }), { ok: true, pid: 111 });
  assert.deepEqual(acquireLock(file, { pid: 222, alive: () => true }), { ok: false, pid: 111 });
  assert.equal(readLock(file).pid, 111);
});

test('lock: a dead holder or a stopped heartbeat frees it', () => {
  const file = path.join(temp(), 'watch.lock');
  acquireLock(file, { pid: 111, alive: () => true });
  assert.equal(acquireLock(file, { pid: 222, alive: () => false }).ok, true, 'holder died');
  const stale = new Date(Date.now() - 10 * MINUTE);
  utimesSync(file, stale, stale);
  assert.equal(lockHeld(readLock(file), Date.now(), () => true), false, 'a reused process id with no heartbeat');
  assert.equal(acquireLock(file, { pid: 333, alive: () => true }).ok, true);
  assert.equal(readLock(file).pid, 333);
});

test('state folder: DESK_STATE_DIR, then XDG_STATE_HOME', () => {
  assert.equal(stateDirFrom({ DESK_STATE_DIR: 'x' }), 'x');
  assert.equal(stateDirFrom({ XDG_STATE_HOME: 'y' }), path.join('y', 'projects-dashboard'));
  assert.match(stateDirFrom({}), /projects-dashboard$/);
});

test('autostart on Windows: a .cmd in the per-user Startup folder, with % escaped', () => {
  assert.equal(windowsStartupDir('C:\\Users\\A\\AppData\\Roaming'), 'C:\\Users\\A\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
  const text = windowsStartupScript({ node: 'C:\\Program Files\\nodejs\\node.exe', watch: 'C:\\Users\\100%\\desk\\scripts\\watch.mjs' });
  assert.ok(text.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\100%%\\desk\\scripts\\watch.mjs" --background'));
  assert.ok(text.includes('\r\n'), 'cmd.exe line ends');
  assert.match(text, /chcp 65001/);
});

test('autostart on macOS: the plist is escaped and starts at login', () => {
  const text = launchdPlist({ node: '/opt/node', watch: '/Users/a&b/watch.mjs', cwd: '/Users/a&b', pathVariable: '/bin:/usr/bin' });
  assert.ok(text.includes('<string>/Users/a&amp;b/watch.mjs</string>'));
  assert.ok(!text.includes('a&b'));
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test('background: starts, runs its jobs, reports, refuses a second copy and stops, on this system', async () => {
  const dir = temp();
  mkdirSync(path.join(dir, 'scripts'));
  mkdirSync(path.join(dir, 'status'));
  for (const { name, script } of JOBS) {
    writeFileSync(path.join(dir, script), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(dir, `ran-${name}`))}, 'yes');`);
  }
  const stateDir = path.join(dir, 'state');
  const env = { ...process.env, DESK_ROOT: dir, DESK_STATE_DIR: stateDir };
  const watch = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/watch.mjs'), ...args], { env, encoding: 'utf8', windowsHide: true });
  const started = watch('--background');
  try {
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /Running in the background/);
    const ran = JOBS.map((j) => path.join(dir, `ran-${j.name}`));
    for (const end = Date.now() + 20_000; Date.now() < end && !ran.every(existsSync);) await new Promise((r) => { setTimeout(r, 100); });
    assert.deepEqual(ran.filter((f) => !existsSync(f)), [], 'every job ran');
    assert.match(watch('--status').stdout, /^Running \(process \d+\)/);
    assert.match(watch('--background').stdout, /Already running/);
    assert.match(readFileSync(path.join(stateDir, 'watch.log'), 'utf8'), /publish: finished, exit 0/);
  } finally {
    const stopped = watch('--stop');
    assert.equal(stopped.status, 0, stopped.stderr);
  }
  assert.match(watch('--status').stdout, /^Not running/);
  assert.equal(existsSync(path.join(stateDir, 'watch.lock')), false);
});

test('--once: publishes now and reports the result', () => {
  const dir = temp();
  mkdirSync(path.join(dir, 'scripts'));
  const env = { ...process.env, DESK_ROOT: dir, DESK_STATE_DIR: path.join(dir, 'state') };
  const once = (code) => {
    writeFileSync(path.join(dir, 'scripts/sync-status.mjs'), `console.log('hello'); process.exit(${code});`);
    return spawnSync(process.execPath, [path.join(root, 'scripts/watch.mjs'), '--once'], { env, encoding: 'utf8', windowsHide: true });
  };
  const ok = once(0);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /hello/);
  assert.equal(once(2).status, 0, 'no status files yet is fine');
  assert.equal(once(1).status, 1);
});
