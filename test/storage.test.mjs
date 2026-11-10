import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run, parseDf, laptopRows, remoteDfRows, rcloneRow, d1Row, r2Row, d1Plan, collectStorage, carryForward, explain, D1_LIMITS } from '../scripts/lib/storage-usage.mjs';
import { renderStorage, renderStorageAlert, storageLevel, bytes } from '../scripts/lib/storage-render.mjs';
import { build } from '../scripts/build.mjs';

// Recorded on 2026-10-20: `df -B1 --output=source,fstype,size,used,avail,target`
// on the laptop, with the rclone mounts under ~/mnt that must not count twice.
const LAPTOP_DF = `Filesystem                       Type             1B-blocks          Used          Avail Mounted on
tmpfs                            tmpfs           3348172800       3018752     3345154048 /run
/dev/nvme0n1p3                   ext4             755761152     154144768      546566144 /run/mnt/ubuntu-boot
/dev/nvme0n1p2                   vfat            5232640000    2031026176     3201613824 /var/lib/snapd/seed
/dev/dm-0                        ext4         1001001926656  710546014208   239532343296 /
/dev/loop3                       squashfs          46661632      46661632              0 /snap/core22/2045
/dev/dm-1                        ext4              20353024        258048       18259968 /var/lib/snapd/save
/dev/dm-0                        ext4         1001001926656  710546014208   239532343296 /var/snap/firefox/common/host-hunspell
homeserver:/media/disk-a fuse.rclone 12000102969344 1460226813952 10539876155392 /home/user/mnt/wd-elements
my-onedrive:                     fuse.rclone  1110249046016  713823567872   396425478144 /home/user/mnt/onedrive
`;

// homeserver, same command for / and /media/disk-a, 2026-10-20.
const PC_DF = `Filesystem     Type       1B-blocks          Used          Avail Mounted on
/dev/sda2      ext4    473334398976   73497399296   375717707776 /
/dev/sdb1      ntfs3 12000102969344 1460226813952 10539876155392 /media/disk-a
/dev/sdd1      fuseblk 1000169533440 394096349184 606073184256 /media/disk-b
`;
// The same with the drive unplugged: df answers for the empty mount point
// with the filesystem it sits on, the root disk.
const PC_DF_UNMOUNTED = `Filesystem     Type       1B-blocks          Used          Avail Mounted on
/dev/sda2      ext4    473334398976   73497399296   375717707776 /
/dev/sda2      ext4    473334398976   73497399296   375717707776 /
`;
const PC_PATHS = [{ path: '/', name: 'System disk' }, { path: '/media/disk-a', name: 'Data disk' }, { path: '/media/disk-b', name: 'Backup disk', kind: 'ntfs' }];

// `rclone about my-onedrive: --json`, 2026-10-20, and one with items in the bin.
const ONEDRIVE = '{\n\t"total": 1110249046016,\n\t"used": 713823564596,\n\t"trashed": 0,\n\t"free": 396425481420\n}\n';
const ONEDRIVE_TRASH = { total: 1104880336896, used: 900000000000, trashed: 120000000000, free: 84880336896 };
// `rclone about my-gdrive: --json`, 2026-10-20: Gmail and Photos are `other`.
const GDRIVE = { total: 2199023255552, used: 8788321646, trashed: 0, other: 27714351549, free: 2162520582357 };

// GET /accounts/{id}/d1/database (Acme, 2026-10-20, uuids cut), split over
// two pages to exercise paging.
const D1_PAGE_1 = { result: [
  { uuid: 'x', name: 'atlas', version: 'production', created_at: '2026-09-25T15:52:41.447Z', file_size: 233472, num_tables: 0, jurisdiction: null },
  { uuid: 'x', name: 'quill-sandbox', version: 'production', created_at: '2026-09-14T06:02:05.671Z', file_size: 35065856, num_tables: 0, jurisdiction: null },
], result_info: { count: 2, page: 1, per_page: 2, total_count: 3 }, success: true, errors: [] };
const D1_PAGE_2 = { result: [
  { uuid: 'x', name: 'quill', version: 'production', created_at: '2026-09-13T15:42:27.119Z', file_size: 405504, num_tables: 0, jurisdiction: null },
], result_info: { count: 1, page: 2, per_page: 2, total_count: 3 }, success: true, errors: [] };
const SUBSCRIPTIONS = { result: [{ rate_plan: { id: 'free', public_name: 'Cloudflare Free Plan' } }, { rate_plan: { id: 'workers_paid', public_name: 'Workers Paid' } }], success: true, errors: [] };

// GET /accounts/{id}/r2/buckets with and without `cf-r2-jurisdiction: eu`,
// and the r2StorageAdaptiveGroups answer for the same account.
const R2_DEFAULT = { result: { buckets: [{ name: 'quill-releases', creation_date: '2026-09-16T21:57:07.569Z' }, { name: 'nova-pocketbase-backup', creation_date: '2026-08-16T08:22:08.648Z' }] }, result_info: { total_count: 2 }, success: true, errors: [] };
const R2_EU = { result: { buckets: [{ name: 'quill-sandbox-attachments', creation_date: '2026-09-14T06:02:05.671Z' }] }, result_info: { total_count: 1 }, success: true, errors: [] };
const R2_GRAPHQL = { data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [
  { dimensions: { bucketName: 'eu_quill-sandbox-attachments' }, max: { objectCount: 633, payloadSize: 322716389 } },
  { dimensions: { bucketName: 'quill-releases' }, max: { objectCount: 105, payloadSize: 1777527269 } },
  { dimensions: { bucketName: 'nova-pocketbase-backup' }, max: { objectCount: 12, payloadSize: 65016652 } },
] }] } }, errors: null };

const now = Date.parse('2026-10-20T12:00:00Z');

test('storage: df keeps real filesystems, once each, without tmpfs, squashfs or the rclone mounts', () => {
  assert.equal(parseDf(LAPTOP_DF).length, 9);
  const rows = laptopRows(LAPTOP_DF, { exclude: ['/home/user/mnt'] });
  assert.ok(rows.length > 0);
  assert.deepEqual(rows.map((r) => r.name), ['/run/mnt/ubuntu-boot', '/var/lib/snapd/seed', '/', '/var/lib/snapd/save']);
  const root = rows.find((r) => r.name === '/');
  assert.equal(root.kind, 'ext4');
  assert.equal(root.total, 1001001926656);
  assert.equal(root.used, 710546014208);
  assert.equal(root.free, 239532343296);
  // df's own Use%: 710.5 / (710.5 + 239.5) GB, not used / size.
  assert.equal(root.percent, 74.8);
  assert.throws(() => parseDf('ssh: connect to host homeserver port 22: No route to host'), /no header/);
});

test('storage: homeserver reports an unmounted drive as "not mounted", never as the root disk', () => {
  const ok = remoteDfRows(PC_DF, PC_PATHS, 'homeserver');
  assert.equal(ok.length, 3);
  // The 1 TB drive is NTFS through ntfs-3g; df only says fuseblk.
  assert.deepEqual([ok[2].name, ok[2].kind, ok[2].total], ['Backup disk', 'ntfs', 1000169533440]);
  assert.equal(ok[1].name, 'Data disk');
  assert.equal(ok[1].kind, 'ntfs3');
  assert.equal(ok[1].total, 12000102969344);
  assert.equal(ok[1].problem, null);

  const off = remoteDfRows(PC_DF_UNMOUNTED, PC_PATHS, 'homeserver');
  assert.equal(off[0].used, 73497399296);
  assert.equal(off[1].problem, 'not mounted');
  assert.equal(off[1].used, null, 'the root disk numbers must not appear under the drive name');
  // The mount point is gone altogether: df prints only the root line.
  const gone = remoteDfRows(PC_DF.split('\n').slice(0, 2).join('\n'), PC_PATHS, 'homeserver');
  assert.equal(gone[1].problem, 'not mounted');
});

test('storage: rclone about JSON gives total, used, free and trash; trash counts as used', () => {
  const r = rcloneRow(ONEDRIVE, { group: 'OneDrive', name: 'my-onedrive', kind: 'OneDrive' });
  assert.deepEqual(r, { group: 'OneDrive', name: 'my-onedrive', kind: 'OneDrive', total: 1110249046016, used: 713823564596, free: 396425481420, trashed: 0, percent: 64.3, problem: null });
  const t = rcloneRow(ONEDRIVE_TRASH, { group: 'OneDrive', name: 'onedrive-2', kind: 'OneDrive' });
  assert.equal(t.trashed, 120000000000);
  assert.equal(t.percent, 92.3);
  assert.throws(() => rcloneRow('{"used": 5}', { group: 'g', name: 'n', kind: 'k' }), /no total/);
  // Google Drive: Gmail and Photos share the quota, so they count as used (36.5 of 2,199 GB).
  const g = rcloneRow(GDRIVE, { group: 'Google Drive', name: 'my-gdrive', kind: 'Google Drive' });
  assert.equal(g.other, 27714351549);
  assert.equal(g.percent, 1.7);
  assert.match(renderStorage({ generated_at: '2026-10-20T12:00:00Z', sources: [g] }, Date.parse('2026-10-20T12:00:00Z')), /1\.7% used · 2\.16 TB free · 27\.7 GB in Gmail and Photos/);
});

test('storage: D1 per database and per account against the plan limit; R2 buckets in both jurisdictions', () => {
  assert.equal(d1Plan(SUBSCRIPTIONS.result), D1_LIMITS.workers_paid);
  assert.equal(d1Plan([{ rate_plan: { id: 'free' } }]), D1_LIMITS.free);
  assert.equal(d1Plan(null), null);
  const d1 = d1Row([...D1_PAGE_1.result, ...D1_PAGE_2.result], { name: 'Acme', plan: D1_LIMITS.workers_paid });
  assert.equal(d1.used, 233472 + 35065856 + 405504);
  assert.deepEqual(d1.items.map((i) => i.name), ['quill-sandbox', 'quill', 'atlas']);
  assert.equal(d1.limit.per_item, 10e9);
  assert.equal(d1.limit.account, 1e12);
  // The biggest database (35 MB of 10 GB = 0.35%) is closer to its limit than the account (36 MB of 1 TB).
  assert.equal(d1.percent, 0.4);
  // On the free plan the same database is 7% of its 500 MB.
  assert.equal(d1Row(D1_PAGE_1.result, { name: 'x', plan: D1_LIMITS.free }).percent, 7);

  const r2 = r2Row([...R2_DEFAULT.result.buckets.map((b) => ({ ...b, jurisdiction: 'default' })), ...R2_EU.result.buckets.map((b) => ({ ...b, jurisdiction: 'eu' }))],
    R2_GRAPHQL.data.viewer.accounts[0].r2StorageAdaptiveGroups, { name: 'Acme' });
  assert.deepEqual(r2.items.map((b) => [b.name, b.used]), [['quill-releases', 1777527269], ['quill-sandbox-attachments (EU)', 322716389], ['nova-pocketbase-backup', 65016652]]);
  assert.equal(r2.used, 1777527269 + 322716389 + 65016652);
  assert.equal(r2.objects, 750);
  assert.equal(r2.total, 10e9);
  assert.equal(r2.percent, 21.7);
});

/** A fake exec answering from recorded responses, keyed by command and arguments. */
function fakeExec(overrides = {}) {
  const calls = [];
  const fail = (props) => Object.assign(new Error(props.message ?? 'Command failed'), props);
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pattern, answer] of Object.entries(overrides)) {
      if (key.includes(pattern)) {
        if (answer instanceof Error) throw answer;
        if (typeof answer === 'function') return answer();
        return { stdout: typeof answer === 'string' ? answer : JSON.stringify(answer) };
      }
    }
    if (cmd === 'df') return { stdout: LAPTOP_DF };
    if (cmd === 'ssh') return { stdout: PC_DF };
    if (cmd === 'rclone') return { stdout: ONEDRIVE };
    if (cmd === 'cfapi') {
      const p = args[1];
      if (p.includes('/d1/database')) return { stdout: JSON.stringify(/[?&]page=1(&|$)/.test(p) ? D1_PAGE_1 : D1_PAGE_2) };
      if (p.endsWith('/subscriptions')) return { stdout: JSON.stringify(SUBSCRIPTIONS) };
      if (p.includes('/r2/buckets')) return { stdout: JSON.stringify(args.includes('cf-r2-jurisdiction: eu') ? R2_EU : R2_DEFAULT) };
      if (p === '/graphql') return { stdout: JSON.stringify(R2_GRAPHQL) };
    }
    throw fail({ message: `unexpected call: ${key}` });
  };
  return { exec, calls, fail };
}

const ACCOUNTS = [{ id: 'a'.repeat(32), name: 'Personal' }, { id: 'b'.repeat(32), name: 'Acme Ltd' }];
const CONFIG = [
  { name: 'Laptop', kind: 'local', exclude_under: ['~/mnt'], skip_types: ['fuse.rclone'] },
  { name: 'homeserver', kind: 'ssh', host: 'homeserver', user: 'dev', paths: [{ path: '/', name: 'System disk' }, { path: '/mnt/data', name: 'Data disk' }] },
  { name: 'OneDrive', kind: 'rclone', kind_label: 'OneDrive', remotes: [{ remote: 'my-onedrive' }] },
  { name: 'Cloudflare D1', kind: 'd1', accounts: ACCOUNTS },
  { name: 'Cloudflare R2', kind: 'r2', accounts: ACCOUNTS },
  { name: 'Google Drive', kind: 'rclone', kind_label: 'Google Drive', remotes: [{ remote: 'my-gdrive' }] },
];

test('storage: the example config names every kind of source', async () => {
  const example = JSON.parse(await readFile(new URL('../storage-usage.config.example.json', import.meta.url), 'utf8')).sources;
  assert.ok(example.length > 0);
  assert.deepEqual([...new Set(example.map((s) => s.kind))].sort(), ['d1', 'local', 'r2', 'rclone', 'ssh']);
});

test('storage: the laptop df skips the rclone mounts, so a remote that hangs cannot hide the laptop disks', async () => {
  // 2026-11-05: homeserver's tunnel was full, rclone's statfs blocked, and every df
  // timed out; the ~/mnt rows are dropped anyway, so df must not ask those mounts at all.
  const hung = Object.assign(new Error('Command failed: df'), { killed: true, signal: 'SIGKILL', timedOut: 15000 });
  const { exec, calls } = fakeExec({ 'df ': (() => { throw hung; }) });
  const laptop = CONFIG.filter((s) => s.kind === 'local');
  assert.ok(laptop.length > 0);
  const answer = async (cmd, args, opts) => (cmd === 'df' && args.includes('fuse.rclone') && args[args.indexOf('fuse.rclone') - 1] === '-x')
    ? { stdout: LAPTOP_DF } : exec(cmd, args, opts);
  const rows = (await collectStorage(laptop, { now, exec: answer, home: '/home/user' })).sources;
  assert.ok(rows.length > 0);
  assert.equal(rows.find((r) => r.name === '/').used, 710546014208);
  assert.ok(rows.every((r) => !r.problem), JSON.stringify(rows));
  assert.equal(calls.length, 0, 'df was called without -x fuse.rclone');
  // A type that is not a plain name never reaches df's arguments.
  const bad = await collectStorage([{ name: 'L', kind: 'local', skip_types: ['fuse.rclone; rm'] }], { now, exec: answer, home: '/home/user' });
  assert.match(bad.sources[0].problem, /skip_types/);
});

test('storage: one failed source keeps its rows with the problem, and every other source still reads', async () => {
  const timedOut = Object.assign(new Error('Command failed: ssh'), { killed: true, signal: 'SIGKILL', timedOut: 25000 });
  const expired = Object.assign(new Error('Command failed: rclone about my-onedrive: --json'), {
    code: 1, stderr: '2026/10/20 12:00:00 Failed to about: couldn\'t fetch token: invalid_grant: maybe token expired? for someone@example.com - try "rclone config reconnect my-onedrive:"',
  });
  const { exec, calls } = fakeExec({ 'ssh ': timedOut, 'about my-onedrive:': expired });
  const sources = [...CONFIG, { name: 'Dropbox', kind: 'rclone', kind_label: 'Dropbox', enabled: false, note: 'not connected — needs a sign-in', remotes: [{ remote: 'dropbox', name: 'Dropbox' }] }];
  const out = await collectStorage(sources, { now, exec, home: '/home/user' });
  assert.equal(out.generated_at, '2026-10-20T12:00:00Z');
  const rows = out.sources;
  assert.ok(rows.length > 0);
  const by = (group, name) => rows.find((r) => r.group === group && r.name === name);

  // homeserver did not answer: both of its rows say so, with no numbers.
  assert.equal(by('homeserver', 'System disk').problem, 'homeserver: no answer after 25 s');
  assert.equal(by('homeserver', 'Data disk').used, null);
  // An expired OneDrive sign-in is named, and the email in rclone's error is not copied.
  const od = by('OneDrive', 'my-onedrive');
  assert.equal(od.problem, 'my-onedrive: sign-in expired; reconnect the rclone remote');
  assert.ok(!JSON.stringify(out).includes('@'), 'no email address in usage/storage.json');
  // The rest are read as usual.
  assert.equal(by('Laptop', '/').used, 710546014208);
  assert.equal(by('Google Drive', 'my-gdrive').free, 396425481420);
  assert.equal(by('Cloudflare D1', 'Personal').items.length, 3, 'both D1 pages read');
  assert.equal(by('Cloudflare D1', 'Acme Ltd').limit.plan, 'Workers Paid');
  assert.equal(by('Cloudflare R2', 'Personal').objects, 750);
  // Google Drive is read like the OneDrive remotes.
  assert.equal(by('Google Drive', 'my-gdrive').total, 1110249046016);
  // A source switched off: its row says what is missing and nothing is called.
  const off = by('Dropbox', 'Dropbox');
  assert.equal(off.disabled, true);
  assert.equal(off.problem, 'not connected — needs a sign-in');
  assert.ok(!calls.some((c) => c.args.includes('dropbox:')));

  // Every call carries a timeout.
  assert.ok(calls.length >= 10);
  for (const c of calls) assert.ok(c.opts?.timeout > 0, `${c.cmd} ${c.args[0]} has no timeout`);
  // ssh as user dev, without ever prompting.
  const ssh = calls.find((c) => c.cmd === 'ssh');
  assert.ok(ssh.args.includes('dev@homeserver') && ssh.args.includes('BatchMode=yes'));
});

test('storage: a Cloudflare error and an offline host become one line each', async () => {
  const denied = Object.assign(new Error('Command failed: cfapi'), {
    code: 1, stdout: JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
  });
  const { exec } = fakeExec({ '/d1/database': denied, 'ssh ': Object.assign(new Error('Command failed: ssh'), { code: 255, stderr: 'ssh: connect to host homeserver port 22: No route to host\r\n' }) });
  const rows = (await collectStorage(CONFIG, { now, exec, home: '/home/user' })).sources;
  const d1 = rows.filter((r) => r.group === 'Cloudflare D1');
  assert.equal(d1.length, 2);
  for (const r of d1) assert.equal(r.problem, 'Cloudflare API: 10000: Authentication error');
  assert.equal(rows.find((r) => r.group === 'homeserver').problem, 'homeserver: host offline or unreachable');
  assert.ok(rows.find((r) => r.group === 'Cloudflare R2').used > 0, 'R2 still read');
  assert.equal(explain({ timedOut: 45000 }, 'onedrive-2'), 'onedrive-2: no answer after 45 s');
  // An error that names the account keeps its text but not the address.
  assert.equal(explain({ stderr: 'Failed to about: drive quota read refused for owner jane.doe@example.co.uk\n' }, 'gdrive'), 'gdrive: Failed to about: drive quota read refused for owner …');
});

test('storage: a call that hangs is killed at its timeout and says so', async () => {
  const started = Date.now();
  const err = await run('sleep', ['5'], { timeout: 300 }).then(() => null, (e) => e);
  assert.ok(err, 'sleep 5 must not finish inside 300 ms');
  assert.equal(err.timedOut, 300);
  assert.ok(Date.now() - started < 3000);
  assert.equal(explain(err, 'onedrive-3'), 'onedrive-3: no answer after 0.3 s');

  // A shell whose child is still running: the whole group goes.
  const t0 = Date.now();
  const err2 = await run('sh', ['-c', 'sleep 5; true'], { timeout: 300 }).then(() => null, (e) => e);
  assert.ok(err2, 'must not finish inside 300 ms');
  assert.equal(err2.timedOut, 300);
  assert.ok(Date.now() - t0 < 3000, `settled after ${Date.now() - t0} ms`);
});

test('storage: a child that never exits still gives up at the timeout', async () => {
  // Like a process stuck on a hung FUSE mount: signals do nothing, it never
  // calls back. A hosted build waited 5 s for a killed `sleep 5`.
  const killed = [];
  const stuck = () => ({ pid: 999_999_999, kill: (sig) => killed.push(sig) });
  const t0 = Date.now();
  const err = await run('df', [], { timeout: 200, execFileImpl: stuck }).then(() => null, (e) => e);
  assert.ok(err, 'must reject');
  assert.equal(err.timedOut, 200);
  assert.ok(Date.now() - t0 < 1500, `settled after ${Date.now() - t0} ms`);
  assert.deepEqual(killed, ['SIGKILL'], 'no process group: the child itself is killed');
  // An answer that arrives after the timeout is ignored, not a second settle.
  let late;
  const slow = (cmd, args, opts, cb) => { late = cb; return { pid: 999_999_998, kill() {} }; };
  const p = run('df', [], { timeout: 50, execFileImpl: slow });
  await assert.rejects(p, /timed out/);
  late(null, 'Filesystem', '');
});

const sample = {
  generated_at: '2026-10-20T11:00:00Z',
  sources: [
    { group: 'Laptop', name: '/', kind: 'ext4', total: 1001e9, used: 710e9, free: 240e9, trashed: null, percent: 74.8, problem: null },
    { group: 'Laptop', name: '/data', kind: 'ext4', total: 500e9, used: 410e9, free: 90e9, trashed: null, percent: 82, problem: null },
    { group: 'OneDrive', name: 'onedrive-2', kind: 'OneDrive', total: 1105e9, used: 900e9, free: 85e9, trashed: 120e9, percent: 92.3, problem: null },
    { group: 'homeserver', name: 'Data disk', kind: 'disk', total: null, used: null, free: null, trashed: null, percent: null, problem: 'homeserver: host offline or unreachable' },
    { group: 'Google Drive', name: 'Google Drive', kind: 'Google Drive', total: null, used: null, free: null, trashed: null, percent: null, problem: 'not connected — needs a one-time Google sign-in', disabled: true },
  ],
};

test('storage: bars turn amber at 80% and red at 90%; a failed row shows its problem', () => {
  assert.equal(storageLevel(79.9), 'ok');
  assert.equal(storageLevel(80), 'near');
  assert.equal(storageLevel(90), 'full');
  assert.equal(storageLevel(null), null);
  assert.equal(bytes(12000102969344), '12 TB');
  assert.equal(bytes(10e9), '10 GB');
  assert.equal(bytes(1110249046016), '1.11 TB');
  assert.equal(bytes(1104880336896), '1.10 TB');
  assert.equal(bytes(233472), '233 KB');

  const html = renderStorage(sample, now);
  assert.ok(html.includes('<h2 id="storage-heading" tabindex="-1">Storage</h2>'));
  // One row: from its opening div to the next row's.
  const row = (name) => {
    const at = html.indexOf(`<span class="meter-name">${name}`);
    assert.ok(at > 0, `${name} row rendered`);
    const start = html.lastIndexOf('<div class="meter storage-row"', at);
    const end = html.indexOf('<div class="meter storage-row"', at);
    return html.slice(start, end < 0 ? undefined : end);
  };
  assert.match(row('/data'), /data-level="near"/);
  assert.match(row('/data'), /Filling up/);
  assert.match(row('onedrive-2'), /data-level="over"/);
  assert.match(row('onedrive-2'), /Almost full/);
  assert.match(row('onedrive-2'), /92\.3% used · 85 GB free · 120 GB in trash/);
  assert.match(row('onedrive-2'), /900 GB of 1\.10 TB/);
  assert.match(html, /data-level="ok"[\s\S]*?710 GB of 1 TB/);
  assert.match(row('/data'), /<span class="storage-kind">ext4<\/span>/);
  assert.ok(!row('onedrive-2').includes('storage-kind'), 'the OneDrive card does not repeat OneDrive');
  assert.match(row('Data disk'), /data-level="error"[\s\S]*Not read[\s\S]*homeserver: host offline or unreachable/);
  assert.match(row('Google Drive'), /data-level="off"[\s\S]*not connected — needs a one-time Google sign-in/);

  // Acme has 9 buckets; the list showed only a closed "Buckets · 9".
  const nine = { group: 'Cloudflare R2', name: 'Acme', kind: 'R2', total: 10e9, used: 9e6, free: 10e9 - 9e6, percent: 0.1, objects: 9, limit: { free_tier: 10e9 }, problem: null,
    items: Array.from({ length: 9 }, (_, i) => ({ name: `bucket-${i}`, used: 1e6, objects: 1, percent: null })) };
  const r2 = renderStorage({ generated_at: sample.generated_at, sources: [nine] }, now);
  assert.match(r2, /<details class="repo-usage" open>\s*<summary>Buckets · 9<\/summary>/);
  for (let i = 0; i < 9; i++) assert.ok(r2.includes(`>bucket-${i}</span>`));

  const alert = renderStorageAlert(sample);
  assert.match(alert, /OneDrive onedrive-2: 92\.3% used · Laptop \/data: 82% used/);
  assert.ok(!alert.includes('WD Elements'), 'an unread source is shown on Builds, not on the Overview');
  assert.equal(renderStorageAlert({ sources: [sample.sources[0]] }), '');
  assert.equal(renderStorage(null, now), '');
});

test('storage: the build renders usage/storage.json on its own tab, and a broken file never fails it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'storage-'));
  const statusDir = path.join(dir, 'status');
  await mkdir(statusDir);
  await writeFile(path.join(statusDir, 'demo.json'), JSON.stringify({ schema_version: 5, project: 'demo', health: 'ok', last_updated: '2026-10-20T10:00:00Z' }));
  const storageFile = path.join(dir, 'storage.json');
  await writeFile(storageFile, JSON.stringify(sample));
  const log = [];
  await build({ statusDir, usageFile: path.join(dir, 'none.json'), storageFile, outDir: path.join(dir, 'dist'), now, log: (l) => log.push(l) });
  const html = await readFile(path.join(dir, 'dist/index.html'), 'utf8');
  // Its own tab and view, not part of Builds.
  assert.ok(html.includes('href="#/storage" data-tab="storage"'));
  const view = html.slice(html.indexOf('data-view="storage"'), html.indexOf('</section>', html.indexOf('id="storage-heading"') + 1));
  assert.ok(view.includes('id="storage-heading"'));
  const builds = html.slice(html.indexOf('data-view="builds"'), html.indexOf('data-view="storage"'));
  assert.ok(builds.length > 0 && !builds.includes('storage-heading'), 'Builds no longer carries the panel');
  assert.ok(html.slice(0, html.indexOf('data-view="activity"')).includes('href="#/storage"><span class="meter-flag">Storage</span>'));

  await writeFile(storageFile, '{"sources": 3}');
  await build({ statusDir, usageFile: path.join(dir, 'none.json'), storageFile, outDir: path.join(dir, 'dist'), now, log: (l) => log.push(l) });
  assert.ok(log.some((l) => l.includes('INVALID  storage usage file')));
  const broken = await readFile(path.join(dir, 'dist/index.html'), 'utf8');
  assert.ok(!broken.includes('storage-heading'));
  assert.ok(broken.includes('No storage numbers yet'), 'the tab still opens and says why it is empty');
});

test('storage: a source that fails keeps its last reading with its time; "not mounted" is not carried', () => {
  const gdrive = { ...rcloneRow(GDRIVE, { group: 'Google Drive', name: 'my-gdrive', kind: 'Google Drive' }) };
  const wd = { group: 'homeserver', name: 'Backup disk', kind: 'ntfs', total: 1e12, used: 4e11, free: 6e11, trashed: null, percent: 40, problem: null };
  const disk = { group: 'homeserver', name: 'System disk', kind: 'ext4', total: 4e11, used: 3e11, free: 1e11, trashed: null, percent: 75, problem: null };
  const previous = { generated_at: '2026-10-20T11:50:00Z', sources: [gdrive, wd, disk] };
  const failedRow = (group, name, problem) => ({ group, name, kind: 'x', total: null, used: null, free: null, trashed: null, percent: null, problem });
  const current = { generated_at: '2026-10-20T12:00:00Z', sources: [
    failedRow('Google Drive', 'my-gdrive', 'my-gdrive: no answer after 45 s'),
    failedRow('homeserver', 'Backup disk', 'not mounted'),
    { ...disk, used: 3.1e11 },
    failedRow('OneDrive', 'new-remote', 'new-remote: no answer after 45 s'),
  ] };
  const out = carryForward(current, previous);
  assert.equal(out.generated_at, '2026-10-20T12:00:00Z');
  assert.equal(out.sources.length, 4);
  const [g, w, d, n] = out.sources;
  assert.equal(g.used, GDRIVE.used, 'the last Google Drive numbers are kept');
  assert.equal(g.total, GDRIVE.total);
  assert.equal(g.read_at, '2026-10-20T11:50:00Z');
  assert.equal(g.problem, 'my-gdrive: no answer after 45 s');
  assert.equal(w.used, null, 'an unplugged drive is shown as not mounted, not with old numbers');
  assert.equal(d.used, 3.1e11, 'a fresh reading wins');
  assert.equal(d.read_at, undefined);
  assert.equal(n.used, null, 'nothing to carry: still Not read');
  // Failing twice keeps the time of the reading, not of the last run.
  const again = carryForward({ generated_at: '2026-10-20T12:10:00Z', sources: [failedRow('Google Drive', 'my-gdrive', 'my-gdrive: no answer after 45 s')] }, out);
  assert.equal(again.sources[0].read_at, '2026-10-20T11:50:00Z');
  assert.equal(carryForward(current, null), current);

  const html = renderStorage(out, now);
  const at = html.indexOf('<span class="meter-name">my-gdrive');
  const row = html.slice(html.lastIndexOf('<div class="meter storage-row"', at), html.indexOf('<div class="meter storage-row"', at));
  assert.match(row, /data-level="ok"/);
  assert.match(row, /8\.79 GB of 2\.20 TB/);
  assert.match(row, /Last reading<\/span><time datetime="2026-10-20T11:50:00Z" data-rel[^>]*>10 minutes ago<\/time> · my-gdrive: no answer after 45 s/);
  assert.ok(!row.includes('Not read<'), 'no empty Not read row');
});
