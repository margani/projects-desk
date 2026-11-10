// scripts/rc.sh decides from a session's file and its screen whether it may
// be closed, and which folders are projects. These run its
// functions against a fake tmux, sessions folder and projects folder, never
// the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const RC = new URL('../scripts/rc.sh', import.meta.url).pathname;
const ESC = '\x1b';

// Runs `snippet` with rc.sh's functions loaded (everything before the
// command dispatch), with:
// - a tmux that prints `screen` for capture-pane and `windows` as the
//   claude-rc windows,
// - one session file per entry of `sessions`,
// - project folders from `folders` (name -> markers: 'status' for a status
//   file, 'conversation' for an earlier Claude conversation, '.git', or a
//   file name to create in it).
function rc(snippet, { screen = '', sessions = {}, folders = {}, windows = ['demo'], env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-test-'));
  const work = join(dir, 'work');
  for (const d of ['bin', 'sessions', 'status', 'projects', 'work']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'screen'), screen);
  writeFileSync(join(dir, 'windows'), windows.join('\n') + '\n');
  writeFileSync(join(dir, 'bin', 'tmux'), `#!/bin/sh
case "$1" in
  capture-pane) cat "${dir}/screen" ;;
  list-windows)
    case "$*" in
      *window_id*) awk '{ print "@" NR " " $0 }' "${dir}/windows" ;;
      *) cat "${dir}/windows" ;;
    esac ;;
esac
`);
  chmodSync(join(dir, 'bin', 'tmux'), 0o755);
  for (const [pid, body] of Object.entries(sessions)) writeFileSync(join(dir, 'sessions', `${pid}.json`), JSON.stringify(body));
  for (const [name, markers] of Object.entries(folders)) {
    const folder = join(work, name);
    mkdirSync(folder);
    for (const m of markers) {
      if (m === 'status') writeFileSync(join(dir, 'status', `${name}.json`), '{}');
      else if (m === 'conversation') {
        // Claude Code's folder for it: the path with every other character as "-".
        const t = join(dir, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'));
        mkdirSync(t);
        writeFileSync(join(t, 'conversation.jsonl'), '{}\n');
      } else if (m === '.git') mkdirSync(join(folder, '.git'));
      else writeFileSync(join(folder, m), '');
    }
  }
  const script = `set -uo pipefail
source <(sed -n '1,/^case "\${1:-}" in/p' "${RC}" | sed '$d')
${snippet}`;
  return execFileSync('bash', ['-c', script], {
    env: {
      ...process.env,
      PATH: `${dir}/bin:${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: dir,
      RC_STATUS_DIR: join(dir, 'status'),
      PROJECTS_DIR: work,
      RC_IDLE_HOURS: '',
      RC_KEEP_OPEN: '',
      ...env,
    },
    encoding: 'utf8',
  }).trim();
}

const promptScreen = (line) => `some output\n${'─'.repeat(20)}\n${ESC}[39m❯ ${line}\n${'─'.repeat(20)}\n  ⏵⏵ auto mode on\n`;

test('rc.sh: a dim placeholder or suggestion in the prompt is not a draft; typed text is', () => {
  assert.equal(rc('draft demo', { screen: promptScreen(`${ESC}[2mTry "refactor <filepath>"${ESC}[0m`) }), '');
  assert.equal(rc('draft demo', { screen: promptScreen(`${ESC}[2m/wrap${ESC}[0m`) }), '');
  assert.equal(rc('draft demo', { screen: promptScreen('') }), '');
  assert.equal(rc('draft demo', { screen: promptScreen('half a message') }), 'halfamessage');
});

test('rc.sh: only an idle session with an empty prompt may be closed', () => {
  const at = Date.now();
  const sessions = {
    101: { status: 'idle', statusUpdatedAt: at },
    102: { status: 'busy', statusUpdatedAt: at },
    103: { status: 'shell', statusUpdatedAt: at },
    104: { status: 'waiting', statusUpdatedAt: at },
  };
  const empty = promptScreen(`${ESC}[2mTry "fix lint errors"${ESC}[0m`);
  assert.equal(rc('working 101 demo', { screen: empty, sessions }), '');
  assert.match(rc('working 102 demo', { screen: empty, sessions }), /busy/);
  assert.match(rc('working 103 demo', { screen: empty, sessions }), /background command/);
  assert.match(rc('working 104 demo', { screen: empty, sessions }), /status waiting/);
  assert.match(rc('working 101 demo', { screen: promptScreen('not sent yet'), sessions }), /unsent text/);
  // A session without a file cannot be judged, so it is not closed either.
  assert.match(rc('working 999 demo', { screen: empty, sessions }), /status unknown/);
});

test('rc.sh: idle hours come from the last status change; the limit is 24 hours', () => {
  const sessions = { 201: { status: 'idle', statusUpdatedAt: Date.now() - 73 * 3600 * 1000 } };
  assert.equal(rc('idle_hours 201', { sessions }), '73');
  assert.equal(rc('echo "$IDLE_HOURS"'), '24', 'the default');
});

test('rc.sh: nothing is kept open by default, and RC_KEEP_OPEN names whole projects', () => {
  assert.equal(rc('echo "[$KEEP_OPEN]"'), '[]');
  const env = { RC_KEEP_OPEN: 'orion notes' };
  assert.equal(rc('keep_open orion && echo keep || echo close', { env }), 'keep');
  assert.equal(rc('keep_open notes && echo keep || echo close', { env }), 'keep');
  assert.equal(rc('keep_open ori && echo keep || echo close', { env }), 'close', 'whole names only');
});

test('rc.sh: a project has a status file or earlier conversations; open also takes a new repo', () => {
  const folders = {
    withstatus: ['status'],
    talked: ['conversation'], // an empty folder, but worked on
    newrepo: ['.git', 'CLAUDE.md'], // never listed, opened only by name
    notes: ['readme.txt'],
    _restore: ['conversation'],
    __pycache__: [],
    hub: ['CLAUDE.md', 'conversation'],
    opened: [],
  };
  assert.equal(rc(`projects | tr '\\n' ' '`, { folders, windows: ['hub'] }), 'talked withstatus');
  // A session already open in claude-rc is listed even without either.
  assert.equal(rc(`projects | tr '\\n' ' '`, { folders, windows: ['hub', 'opened', 'gone'] }), 'opened talked withstatus');
  const openable = (p) => rc(`openable '${p}' && echo yes || echo no`, { folders });
  assert.equal(openable('withstatus'), 'yes');
  assert.equal(openable('talked'), 'yes');
  assert.equal(openable('newrepo'), 'yes');
  for (const p of ['notes', '_restore', '__pycache__', 'hub', 'missing', '../work/withstatus', '']) {
    assert.equal(openable(p), 'no', p);
  }
});

// Resumed sessions with long histories re-read hundreds of thousands of
// cached tokens on every turn, so a project now opens a fresh conversation;
// its CLAUDE.md, memory and status file give it context.
test('rc-session.sh: starts a new conversation unless RC_RESUME=1 asks to resume the last one', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rc-fresh-')));
  const work = join(dir, 'work');
  mkdirSync(work);
  const t = join(dir, 'projects', work.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'abc123.jsonl'), '{"type":"user","message":"hi"}\n');
  const run = (env) => spawnSync('bash', [join(dirname(RC), 'rc-session.sh'), 'demo', '--permission-mode', 'auto'], {
    cwd: work, env: { ...process.env, RC_DRY_RUN: '1', CLAUDE_CONFIG_DIR: dir, RC_RESUME: '', ...env }, encoding: 'utf8',
  });
  const fresh = run({});
  assert.equal(fresh.status, 0);
  assert.doesNotMatch(fresh.stdout, /--resume/);
  assert.match(fresh.stdout, /--remote-control=demo --permission-mode auto/);
  const resumed = run({ RC_RESUME: '1' });
  assert.equal(resumed.status, 0);
  assert.match(resumed.stdout, /--resume abc123 --remote-control=demo /);
});

test('rc.sh: open starts fresh; open --resume passes RC_RESUME=1 to the window', () => {
  const fresh = rc(`session_cmd demo ''`, {});
  assert.doesNotMatch(fresh, /RC_RESUME/);
  assert.match(fresh, /rc-session\.sh demo --permission-mode/);
  const resumed = rc(`session_cmd demo 1`, {});
  assert.match(resumed, /RC_RESUME=1 .*rc-session\.sh demo --permission-mode/);
});
