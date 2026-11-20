// install-watcher.sh --only-users / --skip-users (#39): systemctl and friends are shims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const realScripts = new URL('../scripts', import.meta.url).pathname;
const skip = process.platform === 'win32' ? 'bash script, Linux only' : false;

function run(args) {
  const home = mkdtempSync(join(tmpdir(), 'iw-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  // A throwaway checkout: the script refuses to run without desk.config.json, which CI does not have.
  const repo = join(home, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(join(realScripts, 'install-watcher.sh'), join(repo, 'scripts/install-watcher.sh'));
  cpSync(join(realScripts, 'systemd'), join(repo, 'scripts/systemd'), { recursive: true });
  for (const f of ['publish-status.sh', 'rc.sh']) writeFileSync(join(repo, 'scripts', f), '');
  writeFileSync(join(repo, 'desk.config.json'), '{}');
  for (const cmd of ['systemctl', 'node', 'gh', 'git', 'flock']) {
    writeFileSync(join(bin, cmd), `#!/bin/sh\necho "${cmd} $*" >> "${home}/calls"\n`);
    chmodSync(join(bin, cmd), 0o755);
  }
  const r = spawnSync('bash', [join(repo, 'scripts/install-watcher.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, 'cfg') },
  });
  const unit = (n) => existsSync(join(home, 'cfg/systemd/user', n));
  const calls = existsSync(join(home, 'calls')) ? readFileSync(join(home, 'calls'), 'utf8') : '';
  return { r, unit, calls };
}

test('install-watcher: --only-users installs just the users timer, and needs no gh', { skip }, () => {
  const { r, unit, calls } = run(['--only-users']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(unit('projects-dashboard-users.timer') && unit('projects-dashboard-users.service'));
  assert.ok(!unit('projects-dashboard-publish.timer') && !unit('projects-dashboard-usage.timer') && !unit('projects-dashboard-activity.timer'));
  assert.match(calls, /systemctl --user enable --now projects-dashboard-users.timer/);
});

test('install-watcher: --skip-users leaves the users timer out and removes it', { skip }, () => {
  const { r, unit, calls } = run(['--skip-users']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(unit('projects-dashboard-usage.timer') && unit('projects-dashboard-activity.timer'));
  assert.ok(!unit('projects-dashboard-users.timer') && !unit('projects-dashboard-users.service'));
  assert.match(calls, /disable --now projects-dashboard-users.timer/);
  assert.doesNotMatch(calls, /enable --now projects-dashboard-users.timer/);
});

test('install-watcher: --only-users cannot be mixed with other options, and unknown ones are refused', { skip }, () => {
  assert.equal(run(['--only-users', '--skip-users']).r.status, 2);
  assert.equal(run(['--bogus']).r.status, 2);
});
