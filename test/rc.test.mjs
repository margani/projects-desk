// scripts/rc.sh decides from a session's file and its screen whether it may
// be closed, and which folders are projects. These run its
// functions against a fake tmux, sessions folder and projects folder, never
// the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RC = fileURLToPath(new URL('../scripts/rc.sh', import.meta.url));
// tmux sessions are the one part with no Windows or macOS version.
const linuxOnly = { skip: process.platform !== 'linux' && 'tmux sessions are Linux only' };
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

test('rc.sh: a dim placeholder or suggestion in the prompt is not a draft; typed text is', linuxOnly, () => {
  assert.equal(rc('draft demo', { screen: promptScreen(`${ESC}[2mTry "refactor <filepath>"${ESC}[0m`) }), '');
  assert.equal(rc('draft demo', { screen: promptScreen(`${ESC}[2m/wrap${ESC}[0m`) }), '');
  assert.equal(rc('draft demo', { screen: promptScreen('') }), '');
  assert.equal(rc('draft demo', { screen: promptScreen('half a message') }), 'halfamessage');
});

test('rc.sh: a hub whose first Remote Control connection failed is recognised, so open can reconnect it', linuxOnly, () => {
  const failed = `● Remote Control disconnected — Session creation failed — see debug log\n  — run /remote-control to reconnect\n`;
  assert.equal(rc('rc_disconnected demo && echo yes || echo no', { screen: failed }), 'yes');
  assert.equal(rc('rc_disconnected demo && echo yes || echo no', { screen: promptScreen('') }), 'no');
});

test('rc.sh: boot opens the hub and every RC_KEEP_OPEN project, and one failing does not stop the rest', linuxOnly, () => {
  const out = rc('cmd_open() { echo "open $1"; [ "$1" != files ]; }; cmd_boot; echo "exit $?"', { env: { RC_KEEP_OPEN: 'nova files orion' } });
  assert.equal(out, 'open hub\nopen nova\nopen files\nopen orion\nexit 1');
});

test('rc.sh: only an idle session with an empty prompt may be closed', linuxOnly, () => {
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

test('rc.sh: idle hours come from the last status change; the limit is 24 hours', linuxOnly, () => {
  const sessions = { 201: { status: 'idle', statusUpdatedAt: Date.now() - 73 * 3600 * 1000 } };
  assert.equal(rc('idle_hours 201', { sessions }), '73');
  assert.equal(rc('echo "$IDLE_HOURS"'), '24', 'the default');
});

test('rc.sh: nothing is kept open by default, and RC_KEEP_OPEN names whole projects', linuxOnly, () => {
  assert.equal(rc('echo "[$KEEP_OPEN]"'), '[]');
  const env = { RC_KEEP_OPEN: 'orion notes' };
  assert.equal(rc('keep_open orion && echo keep || echo close', { env }), 'keep');
  assert.equal(rc('keep_open notes && echo keep || echo close', { env }), 'keep');
  assert.equal(rc('keep_open ori && echo keep || echo close', { env }), 'close', 'whole names only');
});

test('rc.sh: a project has a status file or earlier conversations; open also takes a new repo', linuxOnly, () => {
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
test('rc-session.sh: starts a new conversation unless RC_RESUME=1 asks to resume the last one', linuxOnly, () => {
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
  assert.match(fresh.stdout, /-n demo --remote-control=demo --permission-mode auto/);
  const resumed = run({ RC_RESUME: '1' });
  assert.equal(resumed.status, 0);
  assert.match(resumed.stdout, /--resume abc123 -n demo --remote-control=demo /);
});

test('rc.sh: open starts fresh; open --resume passes RC_RESUME=1 to the window', linuxOnly, () => {
  const fresh = rc(`session_cmd demo ''`, {});
  assert.doesNotMatch(fresh, /RC_RESUME/);
  assert.match(fresh, /rc-session\.sh demo --permission-mode/);
  const resumed = rc(`session_cmd demo 1`, {});
  assert.match(resumed, /RC_RESUME=1 .*rc-session\.sh demo --permission-mode/);
});

// --- other machines (#27) -----------------------------------------------------
// rc.sh itself runs, with a fake ssh that records what it was asked and answers
// per host from files, and a fake tmux that has no windows (nothing local is open).
function machines({ config, sshReply = {}, args }) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-machines-'));
  for (const d of ['bin', 'sessions', 'status', 'work']) mkdirSync(join(dir, d));
  mkdirSync(join(dir, 'work', 'demo'));
  writeFileSync(join(dir, 'work', 'demo', 'CLAUDE.md'), '');
  writeFileSync(join(dir, 'status', 'demo.json'), '{}');
  writeFileSync(join(dir, 'bin', 'tmux'), '#!/bin/sh\nexit 1\n');
  // argv: ssh -o .. -o .. -- <alias> <remote command>
  writeFileSync(join(dir, 'bin', 'ssh'), `#!/bin/bash
while [ "$1" != -- ]; do shift; done; shift
host="$1"; shift
echo "$host $*" >> "${dir}/ssh.log"
tar -tf - >> "${dir}/ssh.stdin" 2>/dev/null
[ -f "${dir}/reply-$host" ] || exit 255
cat "${dir}/reply-$host"
exit 0
`);
  for (const f of ['tmux', 'ssh']) chmodSync(join(dir, 'bin', f), 0o755);
  writeFileSync(join(dir, 'desk.config.json'), JSON.stringify(config));
  for (const [host, text] of Object.entries(sshReply)) writeFileSync(join(dir, `reply-${host}`), text);
  const r = spawnSync('bash', [RC, ...args], {
    env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, CLAUDE_CONFIG_DIR: dir, RC_STATUS_DIR: join(dir, 'status'), PROJECTS_DIR: join(dir, 'work'), RC_CONFIG: join(dir, 'desk.config.json'), RC_SSH_TIMEOUT: '2' },
    encoding: 'utf8',
  });
  let log = '';
  try { log = execFileSync('cat', [join(dir, 'ssh.log')], { encoding: 'utf8' }); } catch { /* ssh was never called */ }
  let stdinTar = '';
  try { stdinTar = execFileSync('cat', [join(dir, 'ssh.stdin')], { encoding: 'utf8' }); } catch { /* nothing was streamed */ }
  return { ...r, log, stdinTar };
}
const twoMachines = { machines: { 'hm-pc': { ssh: 'laptop', projects_dir: 'projects/personal' } } };

test('rc.sh: close --on runs the same script on that machine over ssh, from its own checkout', linuxOnly, () => {
  const r = machines({ config: twoMachines, sshReply: { laptop: 'demo closed\n' }, args: ['close', '--on', 'hm-pc', 'demo'] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /^laptop .*RC_MACHINE=hm-pc PROJECTS_DIR="\$HOME"\/projects\/personal RC_STATUS_DIR="\$HOME"\/projects\/personal\/projects-dashboard\/status "\$d"\/scripts\/rc\.sh close demo\b/);
  // the scripts are streamed, not cloned: the remote command unpacks them first
  assert.match(r.log, /tar -xf - -C/);
  assert.match(r.log, /PATH="\$HOME\/\.local\/bin:\$PATH"/);
  assert.equal(r.stdinTar.includes('scripts/rc.sh') && r.stdinTar.includes('scripts/rc-session.sh'), true);
  assert.doesNotMatch(r.log, /--on/);
});

test('rc.sh: open without --on stays on this machine, whatever the config says', linuxOnly, () => {
  const r = machines({ config: { ...twoMachines, project_machines: { nosuch: 'hm-pc' } }, sshReply: { laptop: 'closed\n' }, args: ['open', 'nosuch'] });
  assert.equal(r.log, '');
  assert.match(r.stderr, /no project folder 'nosuch'/);
});

test('rc.sh: a machine that is off gives a clear message and a nonzero exit, never a hang', linuxOnly, () => {
  const r = machines({ config: twoMachines, args: ['close', '--on', 'hm-pc', 'demo'] });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /machine hm-pc \(laptop\) is unreachable/);
});

test('rc.sh: a session of the same project on another machine does not stop open here', linuxOnly, () => {
  const r = machines({ config: twoMachines, sshReply: { laptop: 'open\n' }, args: ['open', 'nosuch'] });
  assert.equal(r.log, '');
  assert.doesNotMatch(r.stderr, /already open on/);
});

test('rc.sh: an unknown machine is refused', linuxOnly, () => {
  const r = machines({ config: twoMachines, args: ['list', '--on', 'nowhere'] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /machine 'nowhere' is not in/);
});

test('rc.sh: list shows a machine column and one row for a machine that is off', linuxOnly, () => {
  const r = machines({ config: twoMachines, args: ['list'] });
  assert.match(r.stdout, /^MACHINE\s+AGENT\s+PROJECT\s+STATE/m);
  assert.match(r.stdout, /^claude\s+claude\s+demo\s+closed/m);
  assert.match(r.stdout, /^hm-pc\s+unreachable:/m);
});

test('config: machines are checked, and a leftover project_machines is ignored', async () => {
  const { checkDeskConfig } = await import('../scripts/lib/config.mjs');
  const base = { d1: { account: 'a'.repeat(32), database: '11111111-1111-4111-8111-111111111111' }, domains: ['desk.example.com'] };
  assert.deepEqual(checkDeskConfig({ ...base, ...twoMachines }), []);
  assert.deepEqual(checkDeskConfig(base), []);
  assert.deepEqual(checkDeskConfig({ ...base, project_machines: { demo: 'typo' } }), []);
  assert.deepEqual(checkDeskConfig({ ...base, agy: { model: 'some-model.id-1' } }), []);
  assert.match(checkDeskConfig({ ...base, agy: { model: '--dangerously-skip-permissions' } }).join(), /agy\.model must be a plain model id/);
  assert.match(checkDeskConfig({ ...base, agy: 'x' }).join(), /agy must be an object/);
  assert.match(checkDeskConfig({ ...base, machines: { 'a b': {} } }).join(), /not a plain machine name/);
  assert.match(checkDeskConfig({ ...base, machines: { x: { ssh: '-oProxyCommand=evil' } } }).join(), /plain ssh host alias/);
});

test('rc.sh: a session on another machine is named "<project> on <machine>", on this one just the project', linuxOnly, () => {
  // session_cmd builds the window's command; the name it hands to rc-session.sh
  // is what Remote Control lists, so the same project on two computers must differ.
  const run = (machine) => spawnSync('bash', ['-c', `REPO=/r MODE=auto LOCAL_MACHINE=${machine}; eval "$(sed -n '/^session_cmd() {/,/^}/p' "${RC}")"; session_cmd cv`], { encoding: 'utf8' });
  assert.match(run('hm-pc').stdout, /rc-session\.sh cv\\ on\\ hm-pc --permission-mode auto/);
  assert.match(run('claude').stdout, /rc-session\.sh cv --permission-mode auto/);
});

// --- agy (Google Antigravity CLI), #43 ----------------------------------------
const AGY_PAGE = `Remote control on for this session.\n  Open\n  https://antigravity.google.com/r/888e3f3f-4de2-4732-8f59-74bd1e53b690-v2\n  on another device to take over.\n`;
// A PATH without any real agy, so "not installed" is what the script sees.
const noAgyPath = 'PATH="$(dirname "$(command -v tmux)"):/usr/bin:/bin"';

test('rc.sh: agy missing or signed out fails with a pointer to the README, and never installs or signs in', linuxOnly, () => {
  const missing = rc(`${noAgyPath}; ( agy_ready ) 2>&1; echo "exit $?"`);
  assert.match(missing, /agy is not installed.*README\.md, "Sessions with agy"/);
  assert.match(missing, /exit 1$/);
  // `agy models` is the sign-in probe: it sends no prompt and exits 1 when signed out.
  const out = rc('agy() { echo "agy $*" >> "$PROJECTS_DIR/calls"; [ "$SIGNED" = 1 ]; }; ( SIGNED=0 agy_ready ) 2>&1; echo "exit $?"; SIGNED=1 agy_ready && echo ready; cat "$PROJECTS_DIR/calls"');
  assert.match(out, /agy is not signed in.*README\.md, "Sessions with agy"/);
  assert.match(out, /^ready$/m);
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('agy ')), ['agy models', 'agy models'], 'only the probe ran');
});

test('rc.sh: the agy model comes from desk.config.json, none is hard-coded', linuxOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-agycfg-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ agy: { model: 'some-model-id' } }));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({}));
  assert.equal(rc(`CONFIG=${dir}/a.json; agy_model`), 'some-model-id');
  assert.equal(rc(`CONFIG=${dir}/b.json; agy_model || true`), '');
  const noModel = rc(`CONFIG=${dir}/b.json; agy_ready() { :; }; ( cmd_open_agy demo ) 2>&1; echo "exit $?"`, { folders: { demo: ['.git'] } });
  assert.match(noModel, /no model for agy: set "agy"/);
  assert.doesNotMatch(readFileSync(RC, 'utf8'), /claude-opus-4|gemini-3|claude-sonnet-4/);
});

test('rc.sh: the agy link and trust prompt are read from the window, its own tmux session', linuxOnly, () => {
  assert.equal(rc('agy_link demo', { screen: AGY_PAGE }), 'https://antigravity.google.com/r/888e3f3f-4de2-4732-8f59-74bd1e53b690-v2');
  assert.equal(rc('agy_link demo', { screen: 'nothing yet' }), '');
  assert.equal(rc('agy_trust_prompt demo && echo yes', { screen: '> Yes, I trust this folder\n  No, exit\n' }), 'yes');
  assert.equal(rc('echo "$AGY_SESSION $SESSION"'), 'agy-rc claude-rc');
});

test('rc.sh: open takes --agent; agy cannot resume and an unknown agent is refused', linuxOnly, () => {
  assert.equal(rc('cmd_open_agy() { echo "agy $1"; }; cmd_open --agent agy demo'), 'agy demo');
  assert.match(rc('( cmd_open --agent agy --resume demo ) 2>&1; true'), /--resume is for Claude Code only/);
  assert.match(rc('( cmd_open --agent gpt demo ) 2>&1; true'), /unknown agent 'gpt'/);
});

test('rc.sh: list shows an AGENT column and where/close see agy windows; idle-close never does', linuxOnly, () => {
  const out = rc('cmd_list', { windows: ['demo'], folders: { demo: ['status'] } });
  assert.match(out, /^MACHINE\s+AGENT\s+PROJECT\s+STATE/m);
  assert.match(out, /^claude\s+agy\s+demo\s+exited/m, 'the fake tmux has the window in agy-rc too, with no agy process');
  // Without --force a close refuses: agy gives no way to tell it is working.
  const closing = rc('agy_pid() { echo 4242; }; ( cmd_close demo ) 2>&1; echo "exit $?"', { windows: ['demo'] });
  assert.match(closing, /runs agy.*close --force demo/);
  assert.match(closing, /exit 2$/);
  // A project open under both agents: --agent agy must never touch the Claude session.
  const both = rc('claude_pid() { echo 77; }; agy_pid() { echo 4242; }; close_agy() { echo "agy closed $1 force=$2"; }; ( cmd_close --force --agent agy demo ) 2>&1; ( cmd_close --agent gpt demo ) 2>&1 || true', { windows: ['demo'], sessions: { 77: { status: 'idle', statusUpdatedAt: Date.now() } } });
  assert.match(both, /^agy closed demo force=1$/m);
  assert.match(both, /unknown agent 'gpt'/);
  assert.equal(rc('agy_pid() { echo 4242; }; cmd_where demo'), 'open');
  // close-idle walks `projects`, which only knows the claude-rc windows and files.
  assert.doesNotMatch(readFileSync(RC, 'utf8').match(/cmd_close_idle\(\) \{[\s\S]*?\n\}/)[0], /agy/);
});

test('rc.sh: a remote run keeps the agent name out of the project argument', linuxOnly, () => {
  const r = machines({ config: twoMachines, sshReply: { laptop: 'ok\n' }, args: ['open', '--agent', 'agy', 'demo', '--on', 'hm-pc'] });
  assert.equal(r.status, 0);
  assert.match(r.log, /open --agent agy demo/);
});
