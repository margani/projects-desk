// Installable app, views and a page per project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from '../scripts/build.mjs';

const status = (project, health = 'ok') => ({
  schema_version: 2,
  project,
  repo_url: `https://github.com/o/${project}`,
  urls: { sandbox: null, production: null },
  version: { sandbox: null, production: '1.0.0' },
  pending_release: { merged_prs: null, release_pr_url: null },
  open_issues: 1,
  owner_tasks: [{ title: `task for ${project}`, url: `https://github.com/o/${project}/issues/7` }],
  next_steps: [`step for ${project}`],
  health,
  health_reason: health === 'ok' ? null : 'needs a look',
  last_session: '2026-10-09T08:00:00+01:00',
  summary: null,
  links: [],
});

async function buildFor(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-app-'));
  await mkdir(path.join(dir, 'status'));
  for (const s of files) await writeFile(path.join(dir, 'status', `${s.project}.json`), JSON.stringify(s));
  await build({ statusDir: path.join(dir, 'status'), outDir: path.join(dir, 'dist'), log: () => {} });
  return { dist: path.join(dir, 'dist'), html: await readFile(path.join(dir, 'dist/index.html'), 'utf8') };
}

test('manifest, icons and service worker are built, and the manifest is fetched with the Access cookie', async () => {
  const { dist, html } = await buildFor([status('a')]);
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.length > 0);
  for (const icon of manifest.icons) assert.ok((await stat(path.join(dist, icon.src))).size > 0, icon.src);
  assert.ok((await stat(path.join(dist, 'sw.js'))).size > 0);
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">/);
  assert.match(html, /class="install"[^>]*hidden/, 'install button waits for the browser to offer installing');
});

test('the desktop app can hide its title bar, and docks get a rounded icon', async () => {
  const { dist, html } = await buildFor([status('a')]);
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.webmanifest'), 'utf8'));
  assert.deepEqual(manifest.display_override, ['window-controls-overlay']);
  assert.equal(manifest.display, 'standalone', 'fallback where the overlay is not supported');
  assert.match(html, /<div class="titlebar" aria-hidden="true"><\/div>/, 'a draggable strip replaces the title bar');
  assert.match(html, /@media \(display-mode: window-controls-overlay\)[^@]*app-region: drag/);
  const byPurpose = (p) => manifest.icons.filter((i) => i.purpose === p).map((i) => i.src);
  assert.ok(byPurpose('any').length > 0);
  assert.equal(byPurpose('maskable').length, 1);
  assert.ok(!byPurpose('any').includes(byPurpose('maskable')[0]), 'the cropped icon is not the rounded one');
  // A rounded card leaves the corners transparent: PNG colour type 6 is RGBA.
  for (const src of byPurpose('any')) {
    const png = await readFile(path.join(dist, src));
    assert.equal(png[25], 6, `${src} has an alpha channel`);
  }
});

test('one view per tab, and a page per project that the list links to', async () => {
  const { html } = await buildFor([status('a'), status('b', 'attention')]);
  const views = [...html.matchAll(/<section class="view[^"]*"[^>]*data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(views.length > 0);
  // The project list is part of the Overview. Claude is off here: no reading, no tab.
  assert.deepEqual(views, ['desktop', 'overview', 'activity', 'builds', 'storage', 'p/b', 'p/a']);
  const tabs = [...html.matchAll(/href="([^"]+)" data-tab=/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['#/', '#/overview', '#/activity', '#/builds', '#/storage']);
  const list = html.slice(html.indexOf('data-view="overview"'), html.indexOf('data-view="activity"'));
  assert.ok(list.includes('href="#/p/a"') && list.includes('href="#/p/b"'));
  assert.ok(list.indexOf('Needs you') < list.indexOf('id="projects-heading"'), 'the list follows the tasks');
  const page = html.slice(html.indexOf('data-view="p/b"'), html.indexOf('data-view="p/a"'));
  assert.ok(page.includes('task for b') && page.includes('step for b') && page.includes('needs a look'));
  assert.ok(!page.includes('task for a'), 'a page shows only its own project');
  assert.ok(page.includes('<a class="back" href="#/overview">← Overview</a>'));
  assert.ok(!html.includes('#/projects"'), 'nothing links to the old list');
});

test('the Claude tab exists only when a Claude reading does', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dash-claude-'));
  await mkdir(path.join(dir, 'status'));
  await writeFile(path.join(dir, 'status/a.json'), JSON.stringify(status('a')));
  const claudeFile = path.join(dir, 'claude.json');
  const page = async (name) => {
    const outDir = path.join(dir, name);
    await build({ statusDir: path.join(dir, 'status'), outDir, claudeFile, log: () => {} });
    return readFile(path.join(outDir, 'index.html'), 'utf8');
  };
  const off = await page('off');
  assert.ok(off.includes('data-view="storage"'), 'the page rendered');
  assert.ok(!off.includes('data-view="claude"'));
  assert.ok(!off.includes('href="#/claude"'));
  await writeFile(claudeFile, JSON.stringify({ generated_at: '2026-10-20T12:00:00Z', limits: null, projects: [] }));
  const on = await page('on');
  assert.ok(on.includes('data-view="claude"'));
  assert.ok(on.includes('href="#/claude"'));
});

test('the installed Android app colours its navigation bar dark, like the page in dark mode', async () => {
  // The WebAPK's navigation bar is painted from the manifest colours, which have
  // no dark variant; the light values left a white bar under the dark page.
  const { dist, html } = await buildFor([status('a')]);
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.webmanifest'), 'utf8'));
  const dark = html.match(/<meta name="theme-color" content="(#[0-9a-f]{6})" media="\(prefers-color-scheme: dark\)">/);
  assert.ok(dark, 'the page has a dark theme-color');
  assert.equal(manifest.theme_color, dark[1]);
  assert.equal(manifest.background_color, dark[1], 'the bar followed background_color on the owner\'s phone');
  assert.match(html, new RegExp(`--bg: light-dark\\(#[0-9a-f]{6}, ${dark[1]}\\)`), 'the dark page background is the same colour');
});

test('every project page has a small split-view menu; the pinned column starts empty', async () => {
  const { html } = await buildFor([status('a'), status('b', 'attention')]);
  const menus = [...html.matchAll(/<details class="side-menu">[\s\S]*?<\/details>/g)].map((m) => m[0]);
  assert.equal(menus.length, 2);
  for (const name of ['a', 'b']) {
    const at = html.indexOf(`data-view="p/${name}"`);
    const head = html.slice(at, html.indexOf('</header>', at));
    const menu = head.match(/<details class="side-menu">[\s\S]*?<\/details>/);
    assert.ok(menu, `${name}'s menu sits on its own page`);
    assert.match(menu[0], new RegExp(`<button type="button" data-side-act="pin" data-project="${name}">Pin to left</button>`));
    // Swap and Close only make sense once a project is pinned; client.js shows them.
    assert.match(menu[0], /<button type="button" data-side-act="swap" hidden>Swap sides<\/button>/);
    assert.match(menu[0], /<button type="button" data-side-act="close" hidden>Close<\/button>/);
    assert.ok(!/class="pin"/.test(head), 'no separate pin button any more');
  }
  assert.match(html, /<div class="split">\s*<!--[^>]*-->\s*<aside class="pinned" aria-label="Pinned project" hidden><\/aside>\s*<main class="page">/);
  assert.match(html, /<\/main>\s*<\/div>/);
  // Phones and narrow windows never see it.
  assert.match(html, /\.side-menu, \.pinned \{ display: none; \}\s*@media \(min-width: 1100px\)/);
  // Both halves on the page background: the column has no card of its own.
  const col = html.match(/body\.split \.pinned \{[^}]*\}/)[0];
  assert.ok(!/background/.test(col), 'the pinned column has no background of its own');
});

test('in split view both halves scroll in boxes of the same height, not one in the window', async () => {
  const { html } = await buildFor([status('a')]);
  const body = html.match(/body\.split \{[^}]*\}/);
  assert.ok(body, 'a body.split rule');
  assert.match(body[0], /height: 100dvh/);
  assert.match(body[0], /overflow: hidden/);
  // One rule for both panes, so their height and scrolling cannot drift apart.
  const panes = html.match(/body\.split \.pinned, body\.split \.page \{[^}]*\}/);
  assert.ok(panes, 'one rule for both panes');
  assert.match(panes[0], /overflow: auto/);
  assert.match(panes[0], /min-height: 0/);
  assert.ok(!/position: sticky/.test(html.match(/body\.split \.pinned \{[^}]*\}/)[0]), 'the left pane no longer sticks in a scrolling window');
});
