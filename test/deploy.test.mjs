// Deploys run on Cloudflare Workers Builds, not GitHub Actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('the Workers Builds commands exist, and the deploy refuses any branch but main', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.ci, /npm test/, 'the build command runs the tests');
  assert.match(pkg.scripts.ci, /npm run build/);
  const r = spawnSync('bash', [path.join(root, 'scripts/deploy.sh')], {
    env: { ...process.env, WORKERS_CI_BRANCH: 'some-feature' }, encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to deploy branch 'some-feature'/);
  const script = await readFile(path.join(root, 'scripts/deploy.sh'), 'utf8');
  assert.match(script, /cloudflareaccess\.com/, 'the deploy still checks the page is behind Access');
});

test('the deploy checks every custom domain for the Access login', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'deploy-domains-'));
  const file = path.join(dir, 'wrangler.jsonc');
  await writeFile(file, JSON.stringify({ routes: [{ pattern: 'a.example.dev', custom_domain: true }, { pattern: 'b.example.dev', custom_domain: true }, { pattern: 'c.example.dev/*', zone_name: 'example.dev' }] }));
  const r = spawnSync('node', [path.join(root, 'scripts/custom-domains.mjs'), file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const hosts = r.stdout.trim().split('\n');
  assert.ok(hosts.length > 0);
  assert.deepEqual(hosts, ['a.example.dev', 'b.example.dev'], 'every custom domain, and only those');
  const script = await readFile(path.join(root, 'scripts/deploy.sh'), 'utf8');
  assert.match(script, /node scripts\/custom-domains\.mjs/, 'the deploy reads its hosts from wrangler.jsonc');
  assert.doesNotMatch(script, /curl[^\n]*https:\/\/[a-z]/, 'no host is hard-coded in the check');
});

test('the deploy waits up to 10 minutes for a new custom domain to connect', async () => {
  const script = await readFile(path.join(root, 'scripts/deploy.sh'), 'utf8');
  const tries = Number(script.match(/for i in \$\(seq 1 (\d+)\)/)?.[1]);
  const wait = Number(script.match(/not reachable yet[^\n]*sleep (\d+)/)?.[1]);
  assert.ok(tries > 0 && wait > 0, 'found the retry loop');
  assert.ok(tries * wait >= 600, `waits ${tries * wait}s; projects.example.dev needed more than 180s`);
});
