// Everything that differs between installations comes from files git ignores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDeskConfig, loadDeskConfig, readOptionalConfig, renderWrangler, root } from '../scripts/lib/config.mjs';
import { cfapi as runCfapi, saveToken } from '../bin/cfapi.mjs';

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
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/write-wrangler.mjs')], {
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
async function cfapi(args, { token = 'test-token-value', answer = '{"success":true}', fails = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'desk-cfapi-'));
  await mkdir(path.join(dir, 'config/cloudflare'), { recursive: true });
  if (token) await writeFile(path.join(dir, 'config/cloudflare/read.token'), token);
  const calls = [];
  let stdout = '';
  let stderr = '';
  const status = await runCfapi(args, {
    env: { XDG_CONFIG_HOME: path.join(dir, 'config') },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (fails) throw fails;
      return new Response(answer);
    },
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { status, calls, stdout, stderr, dir };
}

test('cfapi: the token goes only in the Authorization header, never in the address or output', async () => {
  const r = await cfapi(['GET', '/accounts']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, 'https://api.cloudflare.com/client/v4/accounts');
  assert.equal(r.calls[0].init.headers.Authorization, 'Bearer test-token-value');
  assert.ok(!r.calls[0].url.includes('test-token-value'));
  assert.ok(!r.stdout.includes('test-token-value') && !r.stderr.includes('test-token-value'));
  assert.equal(r.stdout, '{"success":true}\n');
});

test('cfapi: no token is exit 3, no path exit 2, a refused call exit 1', async () => {
  assert.equal((await cfapi(['GET', '/x'], { token: null })).status, 3);
  assert.equal((await cfapi([])).status, 2);
  assert.equal((await cfapi(['GET', '/x'], { answer: '{"success":false}' })).status, 1);
  assert.equal((await cfapi(['GET', '/x', '--unknown', 'y'])).status, 2);
});

test('cfapi: the exit codes are the same from a real process', () => {
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmpdir(), `desk-no-token-${process.pid}`) };
  delete env.CLOUDFLARE_API_TOKEN;
  const run = (args) => spawnSync(process.execPath, [path.join(root, 'bin/cfapi.mjs'), ...args], { env, encoding: 'utf8' });
  assert.equal(run([]).status, 2);
  const none = run(['GET', '/x']);
  assert.equal(none.status, 3);
  assert.match(none.stderr, /no read token/);
});

test('cfapi: the bash command still works for anything that calls bin/cfapi', { skip: process.platform === 'win32' && 'bash script' }, () => {
  assert.equal(spawnSync(path.join(root, 'bin/cfapi'), [], { encoding: 'utf8' }).status, 2);
});

test('cfapi: --edit takes the edit token, and the body and headers callers use arrive', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'desk-cfapi-'));
  await mkdir(path.join(dir, 'cloudflare'));
  await writeFile(path.join(dir, 'cloudflare/edit.token'), 'edit-value\n');
  const body = path.join(dir, 'body.json');
  await writeFile(body, '{"sql":"a\nb"}');
  const calls = [];
  const status = await runCfapi(['--edit', 'POST', '/d1', '--data-binary', `@${body}`, '-H', 'cf-r2-jurisdiction: eu'], {
    env: { XDG_CONFIG_HOME: dir },
    fetch: async (url, init) => { calls.push(init); return new Response('{}'); },
    stdout: { write() {} },
    stderr: { write() {} },
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer edit-value');
  assert.equal(calls[0].headers['cf-r2-jurisdiction'], 'eu');
  assert.equal(calls[0].body, '{"sql":"a\nb"}', '--data-binary keeps line ends');
});

test('cfapi: no network is exit 1, with a line the status publish can quote', async () => {
  const r = await cfapi(['GET', '/x'], { fails: Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^cfapi: could not reach api\.cloudflare\.com: ENOTFOUND/);
});

test('cfapi --save: stores the token privately and never prints it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'desk-cfapi-'));
  let out = '';
  const io = { env: { XDG_CONFIG_HOME: dir }, stdout: { write: (t) => { out += t; } }, stderr: { write: (t) => { out += t; } } };
  assert.equal(saveToken('edit', '  secret-value\r\n', io), 0);
  const file = path.join(dir, 'cloudflare/edit.token');
  assert.equal(await readFile(file, 'utf8'), 'secret-value\n');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!out.includes('secret-value'));
  assert.equal(saveToken('edit', 'two words', io), 1, 'a pasted sentence is not a token');
  assert.equal(saveToken('other', 'value', io), 2);
  assert.equal(await readFile(file, 'utf8'), 'secret-value\n', 'a refused save changes nothing');
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
