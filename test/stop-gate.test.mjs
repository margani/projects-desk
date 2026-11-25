import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepos, isClosing, runGate } from '../scripts/lib/stop-gate.mjs';

const CLOSING = 'All merged.\n\nTask done; start the next one in a fresh session (/clear).';
const temp = () => mkdtempSync(join(tmpdir(), 'stop-gate-'));

function checkout(dir, remote) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { windowsHide: true });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote], { windowsHide: true });
  return dir;
}

const issue = (number, { assignees = [], labels = [] } = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/demo/app/issues/${number}`,
  assignees: assignees.map((login) => ({ login })),
  labels: labels.map((name) => ({ name })),
});

/** A fake gh. `state.issues` may be changed between calls. */
function fakeGh(state) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(' '));
    if (state.fail) throw new Error('could not resolve host');
    if (args[0] === 'api') return 'boss\n';
    if (args[0] === 'repo') return JSON.stringify({ viewerPermission: state.permission ?? 'ADMIN' });
    return JSON.stringify(state.issues);
  };
  return { gh, calls };
}

function setup(issues) {
  const base = temp();
  const project = checkout(join(base, 'app'), 'git@github.com:demo/app.git');
  const state = { issues };
  const { gh, calls } = fakeGh(state);
  const run = (over = {}) => runGate(
    { session_id: 's1', cwd: project, last_assistant_message: CLOSING, stop_hook_active: false, ...over },
    { gh, stateDir: join(base, 'state'), statusDir: join(base, 'status'), projectDir: project },
  );
  return { base, project, state, calls, run };
}

test('closing messages are recognised', () => {
  for (const text of [
    CLOSING,
    'Done.\nTask done; start the next one in a fresh session (`/clear`).',
    '**Task done; start the next one in a fresh session (/clear).**',
    'Everything is merged. Task done, start a new session.',
    'Summary above.\n\nTask done.',
    'I am not waiting for anything.',
    'I am waiting for nothing.',
  ]) assert.equal(isClosing(text), true, text);
});

test('ordinary replies are not closings', () => {
  for (const text of [
    '',
    undefined,
    'You can use /clear to empty the context.',
    'The task is not done yet; two tests fail.',
    'Task 3 is done, starting task 4 now.',
    'The hook looks for "Task done; start the next one in a fresh session (/clear)." at the end.',
    '> Task done; start the next one in a fresh session (/clear).',
    '```\nTask done; start the next one in a fresh session (/clear).\n```',
    'Task done; start the next one in a fresh session (/clear).\n\nWait, one more thing.\nI will look.\nThe build is red.\nFixing it now.',
  ]) assert.equal(isClosing(text), false, String(text));
});

test('blocks a closing while an issue is open, and lists it', async () => {
  const { run } = setup([issue(7)]);
  const out = await run();
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /https:\/\/github\.com\/demo\/app\/issues\/7/);
  assert.match(out.reason, /Issue 7/);
});

test('an ordinary reply does not call GitHub at all', async () => {
  const { run, calls } = setup([issue(7)]);
  assert.equal(await run({ last_assistant_message: 'Here is the answer.' }), null);
  assert.deepEqual(calls, []);
});

test('issues waiting on someone else do not block', async () => {
  const { run, calls } = setup([
    issue(1, { assignees: ['boss'] }),
    issue(2, { labels: ['needs-owner'] }),
    issue(3, { labels: ['awaiting-release'] }),
    issue(4, { labels: ['other-session'] }),
  ]);
  assert.equal(await run(), null);
  assert.ok(calls.some((c) => c.startsWith('issue list')));
});

test('an issue listed in the status file owner_tasks does not block', async () => {
  const { base, run } = setup([issue(5)]);
  mkdirSync(join(base, 'status'));
  writeFileSync(join(base, 'status', 'app.json'), JSON.stringify({
    repo_url: 'https://github.com/demo/app',
    owner_tasks: [{ title: 'Decide', url: 'https://github.com/demo/app/issues/5' }],
  }));
  assert.equal(await run(), null);
});

test('gives up after three blocks without progress, with a visible warning', async () => {
  const { run } = setup([issue(7), issue(8)]);
  for (let i = 0; i < 3; i += 1) assert.equal((await run({ stop_hook_active: i > 0 })).decision, 'block', `block ${i + 1}`);
  const out = await run({ stop_hook_active: true });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /still open/);
});

test('closing an issue counts as progress and resets the count', async () => {
  const { run, state } = setup([issue(7), issue(8)]);
  for (let i = 0; i < 3; i += 1) await run();
  state.issues = [issue(8)];
  assert.equal((await run()).decision, 'block');
});

test('a session is never blocked more than fifteen times in a row', async () => {
  const { run, state } = setup([]);
  let blocks = 0;
  for (let n = 1; n <= 30; n += 1) {
    state.issues = [issue(n)];
    if ((await run()).decision === 'block') blocks += 1;
  }
  assert.equal(blocks, 15);
});

test('fails open with a warning when gh fails', async () => {
  const { run, state } = setup([issue(7)]);
  state.fail = true;
  const out = await run();
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /not checked.*could not resolve host/);
});

test('fails open with a warning when the loop count cannot be saved', async () => {
  const { base, project } = setup([]);
  writeFileSync(join(base, 'blocked'), 'a file where the state folder should be');
  const { gh } = fakeGh({ issues: [issue(7)] });
  const out = await runGate(
    { session_id: 's1', cwd: project, last_assistant_message: CLOSING, stop_hook_active: true },
    { gh, stateDir: join(base, 'blocked'), statusDir: join(base, 'status'), projectDir: project },
  );
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /could not/);
});

test('a repository the user cannot push to is not gated', async () => {
  const { run, state } = setup([issue(7)]);
  state.permission = 'READ';
  assert.equal(await run(), null);
});

test('a project folder that is not a checkout uses the child with its name', async () => {
  const root = join(temp(), 'game');
  checkout(join(root, 'game'), 'https://github.com/demo/game.git');
  checkout(join(root, 'other'), 'https://github.com/demo/other.git');
  assert.deepEqual(await findRepos(root, join(root, 'no-status')), ['demo/game']);
});

test('without a child of its name every child on GitHub counts', async () => {
  const root = join(temp(), 'group');
  checkout(join(root, 'a'), 'https://github.com/demo/a');
  checkout(join(root, 'b'), 'ssh://git@github.com/demo/b.git');
  checkout(join(root, 'c'), 'git@gitlab.com:demo/c.git');
  mkdirSync(join(root, 'notes'));
  assert.deepEqual((await findRepos(root, join(root, 'no-status'))).sort(), ['demo/a', 'demo/b']);
});

test('a folder with no checkout uses the status file repo_url', async () => {
  const base = temp();
  mkdirSync(join(base, 'tool'));
  mkdirSync(join(base, 'status'));
  writeFileSync(join(base, 'status', 'tool.json'), JSON.stringify({ repo_url: 'https://github.com/demo/tool' }));
  assert.deepEqual(await findRepos(join(base, 'tool'), join(base, 'status')), ['demo/tool']);
});

test('a folder holding many checkouts is not a project', async () => {
  const root = join(temp(), 'all');
  for (let i = 0; i < 7; i += 1) checkout(join(root, `p${i}`), `https://github.com/demo/p${i}`);
  assert.deepEqual(await findRepos(root, join(root, 'no-status')), []);
});

const SCRIPT = fileURLToPath(new URL('../scripts/stop-gate.mjs', import.meta.url));
const cli = (input, env = {}) => spawnSync(process.execPath, [SCRIPT], {
  input, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true,
});

test('the command prints nothing for an ordinary reply', () => {
  const r = cli(JSON.stringify({ last_assistant_message: 'Hello.', cwd: tmpdir() }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('the command fails open on input it cannot read', () => {
  const r = cli('not json');
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).systemMessage, /not checked/);
});

test('the command blocks with a real gh process', { skip: process.platform === 'win32' && 'needs a shell script as gh' }, () => {
  const base = temp();
  const project = checkout(join(base, 'app'), 'https://github.com/demo/app');
  const gh = join(base, 'gh');
  writeFileSync(gh, `#!/bin/sh
case "$1" in
  api) echo boss ;;
  repo) echo '{"viewerPermission":"ADMIN"}' ;;
  *) echo '${JSON.stringify([issue(9)])}' ;;
esac
`);
  chmodSync(gh, 0o755);
  const r = cli(JSON.stringify({ session_id: 'cli', cwd: project, last_assistant_message: CLOSING }), {
    CLAUDE_PROJECT_DIR: project, STOP_GATE_GH: gh, STOP_GATE_STATE_DIR: join(base, 'state'),
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /issues\/9/);
});
