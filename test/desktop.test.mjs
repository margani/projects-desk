// The Desktop: the first page, an icon per app, windows for apps that allow framing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from '../scripts/build.mjs';
import { appList, frameVerdict, iconFromHtml, probeApp, checkApps } from '../scripts/lib/apps.mjs';

const status = (project, production) => ({
  schema_version: 2, project, repo_url: `https://github.com/o/${project}`,
  urls: { sandbox: null, production }, version: { sandbox: null, production: '1.0.0' },
  pending_release: { merged_prs: null, release_pr_url: null }, open_issues: 0, owner_tasks: [], next_steps: [],
  health: 'ok', health_reason: null, last_session: '2026-10-30T08:00:00+00:00', summary: null, links: [],
});
const ok = (d) => ({ ok: true, name: d.project, data: d });

async function buildFor(files, apps) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-desk-'));
  await mkdir(path.join(dir, 'status'));
  for (const s of files) await writeFile(path.join(dir, 'status', `${s.project}.json`), JSON.stringify(s));
  const appsFile = path.join(dir, 'apps.json');
  if (apps) await writeFile(appsFile, JSON.stringify(apps));
  await build({ statusDir: path.join(dir, 'status'), appsFile, usageFile: path.join(dir, 'none.json'), storageFile: path.join(dir, 'none.json'), outDir: path.join(dir, 'dist'), log: () => {} });
  return readFile(path.join(dir, 'dist/index.html'), 'utf8');
}

test('apps: projects with a production site, not GitHub release pages, not the dashboard itself', () => {
  const list = appList([
    ok(status('zeta', 'https://zeta.example.dev')), ok(status('ops', 'https://github.com/o/ops/releases/tag/v1')),
    ok(status('projects-dashboard', 'https://projects.example.dev')), ok(status('none', null)),
    ok(status('alpha', 'https://alpha.example')), { ok: false, name: 'broken' },
  ]);
  assert.deepEqual(list.map((a) => a.project), ['alpha', 'zeta']);
});

const HOSTS = ['projects.example.dev'];

test('frame verdict: X-Frame-Options and frame-ancestors refuse; no header or a matching source allows', () => {
  const h = (o) => new Headers(o);
  assert.equal(frameVerdict(h({}), HOSTS).framable, true);
  assert.deepEqual(frameVerdict(h({ 'x-frame-options': 'DENY' }), HOSTS), { framable: false, reason: 'X-Frame-Options: DENY' });
  assert.equal(frameVerdict(h({ 'x-frame-options': 'sameorigin' }), HOSTS).framable, false);
  assert.equal(frameVerdict(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), HOSTS).framable, false);
  assert.equal(frameVerdict(h({ 'content-security-policy': "frame-ancestors 'self'" }), HOSTS).framable, false);
  assert.equal(frameVerdict(h({ 'content-security-policy': 'frame-ancestors *' }), HOSTS).framable, true);
  assert.equal(frameVerdict(h({ 'content-security-policy': "frame-ancestors 'self' https://*.example.dev" }), HOSTS).framable, true);
  assert.equal(frameVerdict(h({ 'content-security-policy': "frame-ancestors https://example.com" }), HOSTS).framable, false, 'the dashboard host is not allowed');
  assert.equal(frameVerdict(h({ 'content-security-policy': "default-src 'self'" }), HOSTS).framable, true, 'no frame-ancestors');
});

test('icon: apple-touch-icon first, then rel=icon, resolved to https', () => {
  const base = 'https://app.example/sub/page';
  assert.equal(iconFromHtml('<link rel="icon" href="/f.svg"><link rel="apple-touch-icon" href="icons/a.png">', base), 'https://app.example/sub/icons/a.png');
  assert.equal(iconFromHtml("<link href='/f.png' rel='shortcut icon'>", base), 'https://app.example/f.png');
  assert.equal(iconFromHtml('<link rel="stylesheet" href="/s.css">', base), null);
  assert.equal(iconFromHtml('<link rel="icon" href="http://plain.example/f.png">', base), null, 'no mixed content');
  assert.equal(iconFromHtml('<link rel="icon" href="javascript:alert(1)">', base), null);
});

test('probe: Access login means a tab; a framable page gets its icon; a dead host is reported', async () => {
  const fake = (routes) => async (url) => {
    const r = routes[url];
    if (!r) throw new Error('ECONNREFUSED');
    return { url: r.url ?? url, ok: (r.status ?? 200) < 400, headers: new Headers(r.headers ?? {}), text: async () => r.body ?? '' };
  };
  const access = await probeApp({ project: 'a', url: 'https://a.example/' }, { fetchImpl: fake({ 'https://a.example/': { url: 'https://team.cloudflareaccess.com/login', headers: { 'content-type': 'text/html' } } }) });
  assert.deepEqual([access.framable, access.reason, access.icon], [false, 'behind Cloudflare Access', null]);
  const open = await probeApp({ project: 'b', url: 'https://b.example/' }, { fetchImpl: fake({ 'https://b.example/': { headers: { 'content-type': 'text/html' }, body: '<link rel="icon" href="/i.png">' } }) });
  assert.deepEqual([open.framable, open.icon], [true, 'https://b.example/i.png']);
  const fav = await probeApp({ project: 'c', url: 'https://c.example/' }, { fetchImpl: fake({ 'https://c.example/': { headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' } }, 'https://c.example/favicon.ico': { headers: { 'content-type': 'image/x-icon' } } }) });
  assert.deepEqual([fav.framable, fav.icon], [false, 'https://c.example/favicon.ico']);
  const dead = await probeApp({ project: 'd', url: 'https://d.example/' }, { fetchImpl: fake({}) });
  assert.equal(dead.framable, null);
  assert.match(dead.reason, /unreachable/);
  assert.equal(checkApps({ apps: [] }), 'no apps or generated_at');
});

test('the Desktop is the first view and the default tab; every app is a link to a new tab', async () => {
  const apps = { generated_at: '2026-10-31T10:00:00Z', apps: [
    { project: 'win', url: 'https://win.example.dev', framable: true, reason: null, icon: 'https://win.example.dev/i.png' },
    { project: 'shut', url: 'https://shut.example.dev', framable: false, reason: "frame-ancestors 'none'", icon: null },
    { project: 'moved', url: 'https://old.example', framable: true, reason: null, icon: null },
    { project: 'evil', url: 'https://evil.example', framable: true, reason: null, icon: 'javascript:alert(1)' },
  ] };
  const html = await buildFor([status('win', 'https://win.example.dev'), status('shut', 'https://shut.example.dev'), status('moved', 'https://new.example'), status('evil', 'https://evil.example'), status('later', 'https://later.example')], apps);
  const first = /<section class="view[^"]*"[^>]*data-view="([^"]+)"/.exec(html)[1];
  assert.equal(first, 'desktop');
  assert.match(html, /<a href="#\/" data-tab="desktop" aria-current="page">/);
  assert.match(html, /data-view="overview"[^>]*hidden/);
  const desk = html.slice(html.indexOf('data-view="desktop"'), html.indexOf('data-view="overview"'));
  const icon = (name) => new RegExp(`<a class="desk-app" href="[^"]+" target="_blank" rel="noopener" data-app="${name}/${name}" title=`).exec(desk);
  assert.ok(icon('win') && icon('shut') && icon('moved') && icon('later') && icon('evil'), 'every app is a new-tab link');
  assert.ok(!desk.includes('data-frame') && !desk.includes('desk-windows'), 'no windows on the Desktop');
  assert.ok(!desk.includes('src="https://old.example'), 'a probe of an older URL gives no icon');
  assert.ok(desk.includes('src="https://win.example.dev/i.png"'));
  assert.ok(!desk.includes('javascript:'), 'an unsafe icon URL is dropped');
  assert.ok(desk.includes('class="desk-letter"'), 'letter tile under or instead of the image');
  assert.ok(!desk.includes('data-app="projects-dashboard'));
});

test('the page script defaults to the Desktop and never frames an app', async () => {
  const js = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.match(js, /\|\| 'desktop';/);
  assert.doesNotMatch(js, /iframe/, 'apps open in a new tab, never inside the dashboard');
  assert.doesNotMatch(js, /preventDefault\(\);\s*open\(/);
});

const withApps = (project, production, apps) => ({ ...status(project, production), schema_version: 5, closed_issues: 0, activity: null, apps });

test('apps: a project can list several Desktop apps, each with its own name, address and icon', async () => {
  const { validateStatus } = await import('../scripts/lib/schema.mjs');
  const media = withApps('media', 'https://photos.example', [
    { name: 'Photos', url: 'https://photos.example/' },
    { name: 'Music', url: 'https://music.example/app/', icon: 'https://music.example/icon.png' },
    { name: 'Download', url: 'https://download.example/' },
  ]);
  assert.deepEqual(validateStatus(media, 'media'), []);
  assert.deepEqual(validateStatus({ ...withApps('x', null, undefined) }, 'x').filter((p) => /apps/.test(p)), [], 'apps stays optional');
  const bad = validateStatus(withApps('x', null, [{ name: '', url: 'javascript:alert(1)', icon: 'http://plain.example/i.png', extra: 1 }, { name: 'A', url: 'https://a.example' }, { name: 'A', url: 'https://b.example' }]), 'x');
  for (const want of [/apps\[0\]\.name/, /apps\[0\]\.url/, /apps\[0\]\.icon/, /apps\[0\]\.extra/, /repeats "A"/]) assert.ok(bad.some((p) => want.test(p)), String(want));

  const list = appList([ok(media), ok(withApps('hidden', 'https://hidden.example', [])), ok(status('plain', 'https://plain.example'))]);
  assert.deepEqual(list.map((a) => `${a.project}/${a.name}`), ['media/Photos', 'media/Music', 'media/Download', 'plain/plain'], 'listed order within a project; [] hides it');

  const html = await buildFor([media, status('plain', 'https://plain.example')], { generated_at: '2026-10-31T10:00:00Z', apps: [
    { project: 'media', name: 'Music', url: 'https://music.example/app/', framable: true, reason: null, icon: 'https://probe.example/other.png' },
    { project: 'media', name: 'Photos', url: 'https://photos.example/', framable: false, reason: 'behind Cloudflare Access', icon: 'https://photos.example/i.png' },
  ] });
  const desk = html.slice(html.indexOf('data-view="desktop"'), html.indexOf('data-view="overview"'));
  assert.match(desk, /href="https:\/\/music\.example\/app\/" target="_blank" rel="noopener" data-app="media\/Music"/);
  assert.match(desk, /data-app="media\/Photos" title/);
  assert.ok(desk.includes('<span class="desk-name">Download</span>'));
  assert.ok(desk.includes('src="https://music.example/icon.png"'), 'the status file icon wins over the probed one');
  assert.ok(desk.includes('src="https://photos.example/i.png"'), 'without one, the probed icon is used');
});
