// Deploys run on Cloudflare Workers Builds, not GitHub Actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHosts, deploy } from '../scripts/lib/deploy.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('no GitHub workflow runs on push or deploys', async () => {
  const dir = path.join(root, '.github/workflows');
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, 'the PR checks workflow still exists');
  for (const f of files) {
    const yml = await readFile(path.join(dir, f), 'utf8');
    assert.doesNotMatch(yml, /^\s*push:/m, `${f} must not run on every status push`);
    assert.doesNotMatch(yml, /wrangler|CLOUDFLARE_API_TOKEN/, `${f} must not deploy`);
  }
});

const hostFetch = (answers) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[new URL(url).host];
    if (answer instanceof Error) throw answer;
    return new Response(null, { status: answer.status ?? 302, headers: answer.location ? { location: answer.location } : {} });
  };
  return { fetch, calls };
};
const ACCESS = { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x?kid=1' };
const quiet = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l), error: (l) => lines.push(l), sleep: async () => {} };
};

test('the Workers Builds commands exist, and the deploy refuses any branch but main', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.ci, /npm test/, 'the build command runs the tests');
  assert.match(pkg.scripts.ci, /npm run build/);
  const env = { ...process.env, WORKERS_CI_BRANCH: 'some-feature' };
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/deploy.mjs')], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to deploy branch 'some-feature'/);
});

test('Workers Builds still deploys through scripts/deploy.sh, with the same refusal', { skip: process.platform === 'win32' && 'bash script' }, () => {
  const env = { ...process.env, WORKERS_CI_BRANCH: 'some-feature' };
  const r = spawnSync('bash', [path.join(root, 'scripts/deploy.sh')], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to deploy branch 'some-feature'/);
});

test('custom-domains.mjs lists every custom domain, and only those', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'deploy-domains-'));
  const file = path.join(dir, 'wrangler.jsonc');
  await writeFile(file, JSON.stringify({ routes: [{ pattern: 'a.example.dev', custom_domain: true }, { pattern: 'b.example.dev', custom_domain: true }, { pattern: 'c.example.dev/*', zone_name: 'example.dev' }] }));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/custom-domains.mjs'), file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const hosts = r.stdout.trim().split(/\r?\n/);
  assert.ok(hosts.length > 0);
  assert.deepEqual(hosts, ['a.example.dev', 'b.example.dev'], 'every custom domain, and only those');
});

test('the deploy check passes only when every host answers with an Access login', async () => {
  const good = hostFetch({ 'a.example.dev': ACCESS, 'b.example.dev': ACCESS });
  assert.equal(await checkHosts(['a.example.dev', 'b.example.dev'], { ...quiet(), fetch: good.fetch }), true);
  assert.deepEqual(good.calls.map((c) => c.url), ['https://a.example.dev/', 'https://b.example.dev/']);
  assert.ok(good.calls.every((c) => c.init.redirect === 'manual'), 'a followed redirect would hide the answer');

  const second = quiet();
  const open = hostFetch({ 'a.example.dev': ACCESS, 'b.example.dev': { status: 200 } });
  assert.equal(await checkHosts(['a.example.dev', 'b.example.dev'], { ...second, fetch: open.fetch }), false, 'the second domain is public');
  assert.match(second.lines.join('\n'), /b\.example\.dev answered HTTP 200 without an Access login/);

  const lookalike = hostFetch({ 'a.example.dev': { location: 'https://evil.example/cloudflareaccess.com/' } });
  assert.equal(await checkHosts(['a.example.dev'], { ...quiet(), fetch: lookalike.fetch }), false);
});

test('the deploy check fails when there is no host to check', async () => {
  const q = quiet();
  assert.equal(await checkHosts([], { ...q, fetch: async () => assert.fail('nothing to request') }), false);
  assert.match(q.lines.join('\n'), /no custom domain was checked/);
});

test('the deploy waits up to 10 minutes for a new custom domain to connect', async () => {
  let waited = 0;
  let tries = 0;
  const q = quiet();
  const fetch = async () => { tries++; throw new Error('no certificate yet'); };
  const passed = await checkHosts(['a.example.dev'], { ...q, fetch, sleep: async (ms) => { waited += ms; } });
  assert.equal(passed, false);
  assert.ok(tries > 0);
  assert.ok(waited >= 600_000, `waits ${waited / 1000}s; a new domain needed more than 180s`);
  assert.match(q.lines.join('\n'), /did not respond after 10 minutes/);

  let attempts = 0;
  const late = async () => {
    if (++attempts < 4) throw new Error('not yet');
    return new Response(null, { status: 302, headers: { location: ACCESS.location } });
  };
  assert.equal(await checkHosts(['a.example.dev'], { ...quiet(), fetch: late }), true, 'connecting late still passes');
  assert.equal(attempts, 4);
});

async function deployRun(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'deploy-run-'));
  await mkdir(path.join(dir, 'dist'));
  if (options.built !== false) await writeFile(path.join(dir, 'dist/inline.mjs'), '');
  const ran = [];
  const errors = [];
  const code = await deploy({
    root: dir,
    env: options.env ?? {},
    node: (args) => { ran.push(args.join(' ')); return options.nodeStatus?.(args) ?? 0; },
    hosts: async () => ['a.example.dev'],
    checks: { ...quiet(), fetch: async () => { ran.push('check'); return new Response(null, { status: 302, headers: { location: ACCESS.location } }); } },
    error: (l) => errors.push(l),
  });
  return { code, ran, errors };
}

test('the deploy writes the config, deploys, and only then checks Access', async () => {
  const ok = await deployRun();
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.ran, ['scripts/write-wrangler.mjs', 'node_modules/wrangler/bin/wrangler.js deploy', 'check']);
  const main = await deployRun({ env: { WORKERS_CI_BRANCH: 'main' } });
  assert.equal(main.code, 0);
  const failed = await deployRun({ nodeStatus: (args) => (args[1] === 'deploy' ? 1 : 0) });
  assert.equal(failed.code, 1);
  assert.ok(!failed.ran.includes('check'));
  const unbuilt = await deployRun({ built: false });
  assert.equal(unbuilt.code, 1);
  assert.deepEqual(unbuilt.ran, []);
  assert.match(unbuilt.errors.join(), /dist\/inline\.mjs is missing/);
});
