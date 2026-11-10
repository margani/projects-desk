#!/usr/bin/env node
// Starts scripts/watch.mjs at every login, and now, on Windows and macOS.
// Linux has scripts/install-watcher.sh and systemd instead.
//   node scripts/install-autostart.mjs            install
//   node scripts/install-autostart.mjs --remove   stop it and remove it
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STARTUP_FILE, LAUNCHD_LABEL, windowsStartupDir, windowsStartupScript, launchdPlist } from './lib/autostart.mjs';

const watch = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watch.mjs');
const cwd = path.resolve(path.dirname(watch), '..');
const node = process.execPath;
const remove = process.argv[2] === '--remove';
const watcher = (mode) => spawnSync(node, [watch, mode], { stdio: 'inherit', windowsHide: true }).status ?? 1;

function windows() {
  const appData = process.env.APPDATA;
  if (!appData) { console.error('APPDATA is not set, so the Startup folder cannot be found.'); return 1; }
  const dir = windowsStartupDir(appData);
  const file = path.join(dir, STARTUP_FILE);
  if (remove) {
    fs.rmSync(file, { force: true });
    console.log(`Removed ${file}`);
    return watcher('--stop');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, windowsStartupScript({ node, watch }));
  console.log(`It will start at every login: ${file}`);
  return watcher('--background');
}

function mac() {
  const file = path.join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  if (remove) {
    spawnSync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    fs.rmSync(file, { force: true });
    console.log(`Removed ${file}`);
    return watcher('--stop');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, launchdPlist({ node, watch, cwd, pathVariable: process.env.PATH ?? '' }));
  console.log(`It will start at every login: ${file}`);
  // Drop an earlier copy first: bootstrap refuses a label that is already loaded.
  spawnSync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
  try {
    execFileSync('launchctl', ['bootstrap', domain, file], { stdio: 'inherit' });
    return 0;
  } catch {
    console.log('launchctl could not load it now, so it is started directly. It will still start at login.');
    return watcher('--background');
  }
}

const installers = { win32: windows, darwin: mac };
const install = installers[process.platform];
if (install) process.exitCode = install();
else {
  console.log('On Linux, use scripts/install-watcher.sh (systemd). Without systemd, run: node scripts/watch.mjs --background');
}
