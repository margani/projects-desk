// What keeps the computer side working on Windows and macOS as well as Linux.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../scripts/lib/repo-bin.mjs';
import { activityRoots } from '../scripts/lib/collect.mjs';
import { collectStorage, run } from '../scripts/lib/storage-usage.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');

test('launch: on Windows cfapi goes straight to Node, and everything else is unchanged', () => {
  const [file, args] = launch('cfapi', ['GET', '/x'], 'win32');
  assert.equal(file, process.execPath);
  assert.equal(path.basename(args[0]), 'cfapi.mjs');
  assert.deepEqual(args.slice(1), ['GET', '/x']);
  assert.deepEqual(launch('git', ['log'], 'win32'), ['git', ['log']]);
  assert.deepEqual(launch('cfapi', ['GET', '/x'], 'linux'), ['cfapi', ['GET', '/x']]);
});

test('activity roots: split like PATH, so a Windows drive letter survives', () => {
  assert.deepEqual(activityRoots('C:\\code;D:\\work', 'H', ';'), ['C:\\code', 'D:\\work']);
  assert.deepEqual(activityRoots('/a:/b', 'H', ':'), ['/a', '/b']);
  assert.deepEqual(activityRoots(undefined, 'home'), [path.join('home', 'projects')]);
});

test('every child process hides its console window, or Windows flashes one each run', () => {
  const dirs = ['scripts', 'scripts/lib', 'bin'];
  const files = dirs.flatMap((d) => readdirSync(path.join(root, d)).filter((f) => f.endsWith('.mjs')).map((f) => `${d}/${f}`));
  const spawners = files.filter((f) => /from 'node:child_process'/.test(read(f)));
  assert.ok(spawners.length >= 6, `found ${spawners.length}`);
  assert.deepEqual(spawners.filter((f) => !read(f).includes('windowsHide')), []);
});

test('no script builds its own file:// address, which never matches on Windows and silently skips the script', () => {
  const dirs = ['scripts', 'scripts/lib', 'bin'];
  const files = dirs.flatMap((d) => readdirSync(path.join(root, d)).filter((f) => f.endsWith('.mjs')).map((f) => `${d}/${f}`));
  assert.ok(files.length >= 20, `found ${files.length}`);
  assert.deepEqual(files.filter((f) => read(f).includes('`file://')), []);
});

test('storage run: hidden on every system, and detached only where process groups exist', async () => {
  let seen;
  const execFileImpl = (file, args, options, done) => { seen = { file, options }; setImmediate(done, null, 'ok', ''); return { pid: 1 }; };
  await run('tool', [], { timeout: 1000, execFileImpl });
  assert.equal(seen.options.windowsHide, true);
  assert.equal(seen.options.detached, process.platform !== 'win32');
});

test('storage: the local disk comes from statfs off Linux, and df is never run there', async () => {
  const exec = () => assert.fail('df is GNU only');
  const statfs = async (target) => {
    assert.equal(target, 'C:\\Users\\a');
    return { bsize: 1000, blocks: 100, bfree: 40, bavail: 30 };
  };
  const out = await collectStorage([{ name: 'Laptop', kind: 'local' }], { now: 0, exec, statfs, home: 'C:\\Users\\a', platform: 'win32' });
  assert.equal(out.sources.length, 1);
  const row = out.sources[0];
  assert.equal(row.name, 'C:\\');
  assert.equal(row.problem, null);
  assert.deepEqual([row.total, row.used, row.free], [100_000, 60_000, 30_000]);
  assert.ok(Math.abs(row.percent - (60 / 90) * 100) < 1e-9);
});

test('storage: a path that cannot be read is a problem row, not a crash', async () => {
  const statfs = async () => { throw new Error('nope'); };
  const out = await collectStorage([{ name: 'Laptop', kind: 'local', paths: ['/missing'] }], { now: 0, statfs, home: '/h', platform: 'darwin' });
  assert.equal(out.sources.length, 1);
  assert.match(out.sources[0].problem, /nope/);
});

test('CI proves all three systems', () => {
  const yml = read('.github/workflows/checks.yml');
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) assert.ok(yml.includes(os), os);
  assert.match(yml, /fail-fast: false/);
});

test('Windows checkouts keep LF, so the bash scripts and fixtures stay the same', () => {
  assert.match(read('.gitattributes'), /^\* text=auto eol=lf$/m);
});

test('package.json: Node 22 or newer, because node --test expands the glob itself on Windows', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.engines.node, '>=22');
  assert.ok(!/\bbash\b/.test(pkg.scripts.deploy), 'npm run deploy works without bash');
});

test('setup guide: PowerShell blocks never run npm or npx by name', () => {
  // Plain `npm` resolves to npm.ps1, which Windows blocks by default.
  const blocks = [...read('docs/SETUP.md').matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 4, `found ${blocks.length} PowerShell blocks`);
  for (const block of blocks) {
    assert.doesNotMatch(block, /(^|[\s;&(])(npm|npx)(?!\.cmd)\s/m, block);
    assert.doesNotMatch(block, /\.ps1\b/, block);
  }
});
