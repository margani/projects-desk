// Pulling status files from other machines: a fake `run` stands in for ssh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullRemoteStatus, remoteProjects, parseRemote } from '../scripts/lib/remote-status.mjs';

const config = { machines: { laptop: { ssh: 'laptop-alias', repo: 'work/desk' } }, project_machines: { demo: 'laptop', other: 'laptop', here: 'claude' } };
const remoteOut = (files) => files.map(([p, mtime, text]) => `@@FILE ${p} ${mtime}\n${text}\n@@END\n`).join('');
const folder = () => mkdtempSync(join(tmpdir(), 'remote-status-'));
const ok = (stdout) => async () => ({ code: 0, stdout, stderr: '' });

test('remote status: only projects configured on a remote machine are asked for', () => {
  assert.deepEqual([...remoteProjects(config)], [['laptop', ['demo', 'other']]]);
  assert.deepEqual([...remoteProjects({ project_machines: { demo: 'nowhere' }, machines: {} })], []);
  assert.deepEqual([...remoteProjects({})], []);
});

test('remote status: a newer remote file is pulled and keeps its mtime', async () => {
  const dir = folder();
  const calls = [];
  const log = await pullRemoteStatus(config, dir, { run: async (cmd, args) => { calls.push([cmd, args]); return ok(remoteOut([['demo', 2000, '{"a":1}']]))(); } });
  assert.deepEqual(log, ['PULLED demo from laptop']);
  assert.equal(readFileSync(join(dir, 'demo.json'), 'utf8'), '{"a":1}\n');
  assert.equal(Math.floor(statSync(join(dir, 'demo.json')).mtimeMs / 1000), 2000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'ssh');
  assert.ok(calls[0][1].includes('BatchMode=yes') && calls[0][1].includes('laptop-alias'));
  assert.deepEqual(readdirSync(dir), ['demo.json']);
});

test('remote status: a local file that is newer is left alone (the project was opened here)', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'demo.json'), '{"local":true}');
  utimesSync(join(dir, 'demo.json'), 5000, 5000);
  const log = await pullRemoteStatus(config, dir, { run: ok(remoteOut([['demo', 2000, '{"a":1}']])) });
  assert.deepEqual(log, []);
  assert.equal(readFileSync(join(dir, 'demo.json'), 'utf8'), '{"local":true}');
});

test('remote status: a file that is not JSON keeps the last good copy and says so', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'demo.json'), '{"good":true}');
  utimesSync(join(dir, 'demo.json'), 1000, 1000);
  const log = await pullRemoteStatus(config, dir, { run: ok(remoteOut([['demo', 2000, '{broken']])) });
  assert.match(log[0], /^REMOTE laptop: demo\.json is not JSON/);
  assert.equal(readFileSync(join(dir, 'demo.json'), 'utf8'), '{"good":true}');
});

test('remote status: a machine that is off keeps the last copies, reports once, and does not throw', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'demo.json'), '{"good":true}');
  const log = await pullRemoteStatus(config, dir, { run: async () => ({ code: 255, stdout: '', stderr: 'timed out' }) });
  assert.equal(log.length, 1);
  assert.match(log[0], /^REMOTE laptop: unreachable or failed \(exit 255\)/);
  assert.equal(readFileSync(join(dir, 'demo.json'), 'utf8'), '{"good":true}');
});

test('remote status: a project the machine was not asked about is ignored; a missing file is no error', async () => {
  const dir = folder();
  const log = await pullRemoteStatus(config, dir, { run: ok(remoteOut([['stranger', 2000, '{}']])) });
  assert.deepEqual(log, []);
  assert.equal(existsSync(join(dir, 'stranger.json')), false);
  assert.equal(existsSync(join(dir, 'demo.json')), false);
});

test('remote status: the remote output is parsed marker by marker', () => {
  const files = parseRemote(remoteOut([['a', 1, '{\n  "x": 1\n}'], ['b', 2, '{}']]));
  assert.deepEqual(files.map((f) => [f.project, f.mtime]), [['a', 1], ['b', 2]]);
  assert.equal(JSON.parse(files[0].text).x, 1);
});
