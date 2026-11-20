// Pulling status files from other machines: a fake `run` stands in for ssh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullRemoteStatus, remoteMachines, parseRemote } from '../scripts/lib/remote-status.mjs';

const config = { machines: { laptop: { ssh: 'laptop-alias', projects_dir: 'work' } } };
const remoteOut = (files) => files.map(([p, mtime, text]) => `@@FILE ${p} ${mtime}\n${text}\n@@END\n`).join('');
const folder = () => mkdtempSync(join(tmpdir(), 'remote-status-'));
const ok = (stdout) => async () => ({ code: 0, stdout, stderr: '' });

test('remote status: every configured remote machine is read, not the local one, and no project map is needed', () => {
  assert.deepEqual(remoteMachines({ machines: { laptop: {}, claude: {}, other: {} } }), ['laptop', 'other']);
  assert.deepEqual(remoteMachines({ machines: { a: {} } }, 'a'), []);
  assert.deepEqual(remoteMachines({}), []);
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
  assert.match(calls[0][1].at(-1), /\$HOME\/work\/projects-dashboard\/status"\/\*\.json/);
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

test('remote status: every project on the machine is pulled, from every machine, the newest wins', async () => {
  const dir = folder();
  const cfg = { machines: { laptop: { ssh: 'a' }, desk: { ssh: 'b' } } };
  const out = { a: remoteOut([['one', 2000, '{"m":"a"}'], ['two', 2000, '{}']]), b: remoteOut([['one', 3000, '{"m":"b"}']]) };
  const log = await pullRemoteStatus(cfg, dir, { run: async (_c, args) => ({ code: 0, stdout: out[args.at(-2)], stderr: '' }) });
  assert.deepEqual(log, ['PULLED one from laptop', 'PULLED two from laptop', 'PULLED one from desk']);
  assert.equal(readFileSync(join(dir, 'one.json'), 'utf8'), '{"m":"b"}\n');
});

test('remote status: a name that is not a plain project name is ignored; no files is no error', async () => {
  const dir = folder();
  const log = await pullRemoteStatus(config, dir, { run: ok(remoteOut([['../evil', 2000, '{}']])) });
  assert.deepEqual(log, []);
  assert.deepEqual(readdirSync(dir), []);
});

test('remote status: the remote output is parsed marker by marker', () => {
  const files = parseRemote(remoteOut([['a', 1, '{\n  "x": 1\n}'], ['b', 2, '{}']]));
  assert.deepEqual(files.map((f) => [f.project, f.mtime]), [['a', 1], ['b', 2]]);
  assert.equal(JSON.parse(files[0].text).x, 1);
});

test('remote status: machines are asked in parallel, so two that are off cost one timeout, not two (#37)', async () => {
  const two = { machines: { a: {}, b: {} } };
  let running = 0, peak = 0;
  const run = async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 30)); running--; return { code: 255, stdout: '', stderr: '' }; };
  const log = await pullRemoteStatus(two, folder(), { run });
  assert.equal(peak, 2);
  assert.equal(log.length, 2);
  assert.match(log[0], /^REMOTE a:/);
  assert.match(log[1], /^REMOTE b:/);
});
