// Everything that differs between installations comes from files git ignores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDeskConfig, loadDeskConfig, readOptionalConfig, renderWrangler, root } from '../scripts/lib/config.mjs';

const good = {
  worker_name: 'desk-test',
  d1: { account: 'a'.repeat(32), database: '11111111-1111-4111-8111-111111111111', name: 'desk-test' },
  domains: ['desk.example.dev'],
};
const envOf = (cfg) => ({ DESK_CONFIG_JSON: JSON.stringify(cfg) });

test('config: a complete config passes; the example, still holding placeholders, does not', async () => {
  assert.deepEqual(checkDeskConfig(good), []);
  const example = JSON.parse(await readFile(path.join(root, 'desk.config.example.json'), 'utf8'));
  const problems = checkDeskConfig(example).join('\n');
  assert.match(problems, /d1\.account/);
  assert.match(problems, /d1\.database/);
});

test('config: every missing or malformed field is named', () => {
  assert.equal(checkDeskConfig(null).length, 3);
  assert.match(checkDeskConfig({ ...good, domains: [] }).join(), /at least one custom domain/);
  assert.match(checkDeskConfig({ ...good, domains: ['https://a.example/x'] }).join(), /plain host names/);
  assert.match(checkDeskConfig({ ...good, claude: 'yes' }).join(), /claude must be true or false/);
});

test('config: the Claude reading is off unless the config says true', () => {
  assert.equal(loadDeskConfig({ env: envOf(good) }).claude, false);
  assert.equal(loadDeskConfig({ env: envOf({ ...good, claude: true }) }).claude, true);
});

test('config: a missing file says what to do, and a bad one what is wrong', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'desk-config-'));
  assert.throws(() => loadDeskConfig({ env: {}, file: path.join(dir, 'none.json') }), /copy desk\.config\.example\.json/);
  assert.throws(() => loadDeskConfig({ env: envOf({ ...good, domains: [] }) }), /desk\.config\.json: domains must name/);
  const file = path.join(dir, 'desk.config.json');
  await writeFile(file, JSON.stringify(good));
  assert.equal(loadDeskConfig({ env: {}, file }).d1.database, good.d1.database);
});

test('config: no setting can open a workers.dev or preview URL past Access', () => {
  const cfg = renderWrangler({ ...good, workers_dev: true, preview_urls: true });
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.deepEqual(cfg.routes, [{ pattern: 'desk.example.dev', custom_domain: true }]);
  assert.equal(cfg.account_id, good.d1.account);
});

test('config: write-wrangler stops with exit 2 on a bad config', () => {
  const r = spawnSync('node', [path.join(root, 'scripts/write-wrangler.mjs')], {
    env: { ...process.env, DESK_CONFIG_JSON: JSON.stringify({ ...good, domains: [] }) }, encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /domains must name/);
});

test('config: a collector without its file gets the fallback; a broken file is an error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'desk-optional-'));
  assert.deepEqual(readOptionalConfig('x.json', { sources: [] }, { dir }), { sources: [] });
  await writeFile(path.join(dir, 'y.json'), '{');
  assert.throws(() => readOptionalConfig('y.json', {}, { dir }), /y\.json/);
});

test('config: private settings are ignored by git and only their examples are tracked', async () => {
  const ignored = (await readFile(path.join(root, '.gitignore'), 'utf8')).split('\n');
  const names = ['desk.config', 'github-usage.config', 'activity.config', 'users.config', 'storage-usage.config'];
  for (const n of names) {
    assert.ok(ignored.includes(`${n}.json`), `${n}.json is not ignored`);
    await readFile(path.join(root, `${n}.example.json`), 'utf8');
  }
  assert.ok(ignored.includes('wrangler.jsonc'));
});

/** bin/cfapi with a stand-in curl that records what it was given. */
async function cfapi(args, { token = 'test-token-value', answer = '{"success":true}' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'desk-cfapi-'));
  await mkdir(path.join(dir, 'bin'));
  await mkdir(path.join(dir, 'config/cloudflare'), { recursive: true });
  if (token) await writeFile(path.join(dir, 'config/cloudflare/read.token'), token);
  const log = path.join(dir, 'log');
  await writeFile(path.join(dir, 'bin/curl'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > '${log}'
while (($#)); do [[ $1 == -H && $2 == @* ]] && cat "\${2#@}" >> '${log}.headers'; shift; done
printf '%s' '${answer}'
`);
  await chmod(path.join(dir, 'bin/curl'), 0o755);
  const env = { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(dir, 'config') };
  delete env.CLOUDFLARE_API_TOKEN;
  const r = spawnSync(path.join(root, 'bin/cfapi'), args, { env, encoding: 'utf8' });
  const read = (f) => readFile(f, 'utf8').catch(() => '');
  return { ...r, argv: await read(log), headers: await read(`${log}.headers`) };
}

test('cfapi: the token goes in a header file, never in curl arguments or output', async () => {
  const r = await cfapi(['GET', '/accounts']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.argv, /accounts/);
  assert.match(r.headers, /Bearer test-token-value/);
  assert.ok(!r.argv.includes('test-token-value'));
  assert.ok(!r.stdout.includes('test-token-value') && !r.stderr.includes('test-token-value'));
});

test('cfapi: no token is exit 3, no path exit 2, a refused call exit 1', async () => {
  assert.equal((await cfapi(['GET', '/x'], { token: null })).status, 3);
  assert.equal((await cfapi([])).status, 2);
  assert.equal((await cfapi(['GET', '/x'], { answer: '{"success":false}' })).status, 1);
});

test('the Worker bundle loads nothing that needs a file system at start-up', async () => {
  // import.meta.url is undefined in a bundled Worker, so a module computing a
  // path from it at load time makes the Worker fail before its first request.
  const seen = new Set();
  const walk = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await readFile(file, 'utf8');
    for (const [, rel] of text.matchAll(/(?:from|import)\s+'(\.[^']+\.mjs)'/g)) {
      if (!rel.includes('dist/')) await walk(path.resolve(path.dirname(file), rel));
    }
  };
  await walk(path.join(root, 'src/worker.mjs'));
  assert.ok(seen.has(path.join(root, 'scripts/lib/render.mjs')), 'the walk followed the imports');
  for (const name of ['config.mjs', 'repo-bin.mjs']) {
    assert.ok(!seen.has(path.join(root, 'scripts/lib', name)), `${name} is reachable from the Worker`);
  }
});
