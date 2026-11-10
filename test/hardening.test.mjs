// Regression tests: Desktop windows stay in their box, the app
// probe stays within its limits, the status publish survives future file
// times, and rc.sh only takes plain project names. Fixtures only; nothing
// here touches the real status/ folder, tmux, claude or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeApp, collectApps, iconFromHtml } from '../scripts/lib/apps.mjs';

const root = new URL('..', import.meta.url).pathname;

test('the Desktop never shows another site inside the dashboard (windows removed 2026-10-31)', () => {
  const js = readFileSync(join(root, 'src/client.js'), 'utf8');
  assert.doesNotMatch(js, /iframe/, 'no app is framed, so no browser permission can pass to it');
});

const page = (body, headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });

test('app probe: a body that never ends still gives an answer within the timeout', async () => {
  const stalled = async () => page(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('<html><head>')); } }));
  const started = Date.now();
  const out = await Promise.race([
    probeApp({ project: 'slow', url: 'https://slow.example/' }, { fetchImpl: stalled, timeoutMs: 200 }),
    new Promise((r) => setTimeout(() => r('still pending'), 3000)),
  ]);
  assert.notEqual(out, 'still pending');
  assert.match(out.reason, /no answer in 0.2s/);
  assert.ok(Date.now() - started < 2000);
});

test('app probe: one slow app does not hold up the others', async () => {
  const fetchImpl = async (url) => (url.startsWith('https://slow.')
    ? page(new ReadableStream({ start() {} }))
    : page('<link rel="icon" href="/i.png">'));
  const entry = (project, url) => ({ ok: true, name: project, data: { project, urls: { production: url } } });
  const out = await Promise.race([
    collectApps([entry('slow', 'https://slow.example/'), entry('fine', 'https://fine.example/')], { fetchImpl, timeoutMs: 200 }),
    new Promise((r) => setTimeout(() => r('still pending'), 3000)),
  ]);
  assert.notEqual(out, 'still pending');
  assert.equal(out.apps.find((a) => a.project === 'fine').icon, 'https://fine.example/i.png');
});

test('app probe: icon parsing stays fast on a page made of unclosed link tags', () => {
  const hostile = '<link'.repeat(64000); // 320 kB; took 12-15 s before
  const started = Date.now();
  assert.equal(iconFromHtml(hostile, 'https://x.example/'), null);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.equal(iconFromHtml('<link rel="apple-touch-icon" href="/a.png">', 'https://x.example/'), 'https://x.example/a.png');
});

function publishFixture(mtimeOffset) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-test-'));
  mkdirSync(join(dir, 'status'));
  const file = join(dir, 'status', 'demo.json');
  writeFileSync(file, '{"project":"demo"}');
  const t = Date.now() / 1000 + mtimeOffset;
  utimesSync(file, t, t);
  const past = Date.now() / 1000 - 60;
  utimesSync(join(dir, 'status'), past, past);
  return dir;
}

// A stub stands in for the sync, so only the debounce is timed: on the
// Workers Builds machine the real node, started with HOME in a temp folder,
// took seconds to start and failed the time limit.
function stubBin(dir, tools) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

function publish(dir) {
  const started = Date.now();
  const bin = stubBin(dir, { node: 'exit 0' });
  const r = spawnSync('bash', [join(root, 'scripts/publish-status.sh')], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, STATUS_REPO: dir, DEBOUNCE_SECONDS: '1', XDG_STATE_HOME: join(dir, 'state') },
    encoding: 'utf8', timeout: 8000,
  });
  return { status: r.status, signal: r.signal, ms: Date.now() - started, out: r.stdout + r.stderr };
}

// The stall this guards against sleeps until the future time, so the run is
// killed at the spawn timeout. Its time is compared with a control run on the
// same machine, not a fixed limit: Workers Builds took 6.3 s for a run that
// finished normally.
test('status publish: a file time a day in the future does not stall the run', () => {
  const control = publish(publishFixture(-60));
  assert.equal(control.signal, null, `the control run was killed after ${control.ms} ms: ${control.out}`);
  assert.equal(control.status, 0, control.out);
  const r = publish(publishFixture(86400));
  assert.equal(r.signal, null, `the run was killed after ${r.ms} ms: ${r.out}`);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.ms < control.ms + 3000, `took ${r.ms} ms against ${control.ms} ms for the control: ${r.out}`);
});

// On a fresh install there are no status files yet, and the sync says so with
// exit 2. The 2-minute timer would count that as an outage and put "has not
// reached the dashboard" on the desktop after half an hour of nothing wrong.
test('status publish: no status files yet is not an outage', () => {
  const dir = publishFixture(-60);
  const log = join(dir, 'notices');
  const bin = stubBin(dir, {
    node: 'echo "No status files in status/"; exit 2',
    'notify-send': `echo "$*" >> "${log}"`,
  });
  for (let i = 0; i < 16; i++) {
    const r = spawnSync('bash', [join(root, 'scripts/publish-status.sh')], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, STATUS_REPO: dir, DEBOUNCE_SECONDS: '1', XDG_STATE_HOME: join(dir, 'state') },
      encoding: 'utf8', timeout: 8000,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  assert.equal(existsSync(log), false, 'no notice for an empty folder');
  assert.equal(existsSync(join(dir, 'state/projects-dashboard/sync-failures')), false, 'nothing counted as a failure');
});

// The timer retries every 2 minutes, so a notice per failure became 51 notices
// in one morning's DNS outage.
test('status publish: an outage gives one notice, after 15 failed passes, and a success starts over', () => {
  const dir = publishFixture(-60);
  const log = join(dir, 'notices');
  const online = join(dir, 'online');
  const bin = stubBin(dir, {
    node: `echo 'curl: (6) Could not resolve host: api.cloudflare.com'; test -e "${online}"`,
    'notify-send': `echo "$*" >> "${log}"`,
  });
  const notices = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const pass = (expected) => {
    const r = spawnSync('bash', [join(root, 'scripts/publish-status.sh')], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, STATUS_REPO: dir, DEBOUNCE_SECONDS: '1', XDG_STATE_HOME: join(dir, 'state') },
      encoding: 'utf8', timeout: 8000,
    });
    assert.equal(r.status, expected, r.stdout + r.stderr);
  };
  const fail = (times) => { for (let i = 0; i < times; i++) pass(1); };

  fail(14);
  assert.equal(notices().length, 0, 'a short outage is silent');
  fail(1);
  assert.equal(notices().length, 1, 'the 15th failure in a row notifies');
  assert.match(notices()[0], /Could not resolve host/, 'the notice names the reason');
  fail(5);
  assert.equal(notices().length, 1, 'the same outage never notifies twice');

  writeFileSync(online, '');
  pass(0);
  rmSync(online);
  fail(14);
  assert.equal(notices().length, 1, 'a success restarts the count');
  fail(1);
  assert.equal(notices().length, 2, 'a new long outage gets its own notice');
});

function rcFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rc-names-'));
  const work = join(dir, 'work');
  for (const name of ["odd'name", '--some-option', 'plain-name']) mkdirSync(join(work, name, '.git'), { recursive: true });
  return { dir, work };
}

function openable(name, { dir, work }) {
  // rc.sh refuses to load without tmux; the build machine has none.
  const bin = stubBin(dir, { tmux: 'exit 0' });
  const script = `set -uo pipefail
source <(sed -n '1,/^case "\${1:-}" in/p' "${join(root, 'scripts/rc.sh')}" | sed '$d')
if openable "$1"; then echo yes; else echo no; fi`;
  return spawnSync('bash', ['-c', script, 'x', name], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECTS_DIR: work, RC_STATUS_DIR: join(dir, 'status'), CLAUDE_CONFIG_DIR: dir }, encoding: 'utf8',
  }).stdout.trim() || 'rc.sh did not load';
}

test('rc.sh: only plain folder names can be opened', () => {
  const fx = rcFixture();
  assert.equal(openable('plain-name', fx), 'yes');
  assert.equal(openable("odd'name", fx), 'no', 'a quote would break out of the window command');
  assert.equal(openable('--some-option', fx), 'no', 'a leading dash would become a claude option');
});

test('rc-session.sh: the name is bound to --remote-control and a dash name is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-session-'));
  const run = (name) => spawnSync('bash', [join(root, 'scripts/rc-session.sh'), name, '--permission-mode', 'auto'], {
    cwd: dir, env: { ...process.env, RC_DRY_RUN: '1', CLAUDE_CONFIG_DIR: dir }, encoding: 'utf8',
  });
  const ok = run('demo');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /--remote-control=demo /);
  const bad = run('--some-option');
  assert.equal(bad.status, 64);
  assert.equal(bad.stdout, '');
});

test('status and usage data are never tracked in git; the page they feed is private (audit run-1)', () => {
  const r = spawnSync('git', ['-C', root, 'ls-files', 'status', 'usage'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const tracked = r.stdout.split('\n').filter((f) => /\.json$/.test(f));
  assert.deepEqual(tracked, [], 'status/*.json and usage/*.json belong in D1, not in the repository');
});
