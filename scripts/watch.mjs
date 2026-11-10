#!/usr/bin/env node
// Copies status files into D1 and collects usage, on a computer without
// systemd: Windows, macOS, or Linux with no user session.
//   node scripts/watch.mjs               run here, until stopped
//   node scripts/watch.mjs --background  start it in the background
//   node scripts/watch.mjs --once        publish the status files now
//   node scripts/watch.mjs --status      is it running, and how did the last runs go
//   node scripts/watch.mjs --stop        stop it
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JOBS, TICK_MS, HEARTBEAT_MS, Runner, startJob, stateDirFrom, acquireLock, readLock, lockHeld,
  touchLock, readRunnerState, isAlive,
} from './lib/runner.mjs';

const self = fileURLToPath(import.meta.url);
// DESK_ROOT points a trial at a copy instead of this checkout.
const root = process.env.DESK_ROOT ? path.resolve(process.env.DESK_ROOT) : path.resolve(path.dirname(self), '..');
const stateDir = stateDirFrom();
const lockFile = path.join(stateDir, 'watch.lock');
const logFile = path.join(stateDir, 'watch.log');
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const heldBy = () => { const holder = readLock(lockFile); return lockHeld(holder) ? holder.pid : null; };

async function waitFor(condition, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) if (condition()) return true;
  return condition();
}

function foreground() {
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = acquireLock(lockFile);
  if (!lock.ok) {
    console.log(`Already running (process ${lock.pid}).`);
    return;
  }
  const release = () => {
    if (readLock(lockFile)?.pid === process.pid) fs.rmSync(lockFile, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', release);
  process.on('SIGTERM', release);
  const runner = new Runner({ root, stateDir });
  runner.log(`runner started, process ${process.pid}, node ${process.version}`);
  let lastHeartbeat = Date.now();
  const beat = () => {
    if (readLock(lockFile)?.pid !== process.pid) {
      // Another runner took over a lock that looked stale after a long sleep.
      runner.log('another runner holds the lock now; this one stops');
      process.exit(0);
    }
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      touchLock(lockFile);
      lastHeartbeat = Date.now();
    }
    runner.tick();
  };
  beat();
  setInterval(beat, TICK_MS);
}

async function background() {
  const running = heldBy();
  if (running) {
    console.log(`Already running (process ${running}).`);
    return 0;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const child = spawn(process.execPath, [self], { detached: true, windowsHide: true, stdio: 'ignore', cwd: root });
  child.unref();
  if (await waitFor(() => heldBy() !== null, 10_000)) {
    console.log(`Running in the background (process ${heldBy()}). Log: ${logFile}`);
    return 0;
  }
  console.error(`It did not start. Log: ${logFile}`);
  return 1;
}

async function once() {
  const { code, output } = await startJob(JOBS[0], { root });
  if (output.trim()) console.log(output.trim());
  return code === 0 || code === 2 ? 0 : 1;
}

function status() {
  const running = heldBy();
  console.log(running ? `Running (process ${running}).` : 'Not running.');
  const state = readRunnerState(path.join(stateDir, 'runner.json'));
  for (const job of JOBS) {
    const seen = state.jobs[job.name];
    console.log(seen?.lastStart ? `${job.name}: last started ${new Date(seen.lastStart).toLocaleString()}, exit ${seen.lastCode ?? '(still running)'}` : `${job.name}: has not run`);
  }
  if (state.publish.failures) console.log(`Publish has failed ${state.publish.failures} times in a row.`);
  console.log(`Log: ${logFile}`);
  return 0;
}

async function stop() {
  const holder = readLock(lockFile);
  if (!lockHeld(holder)) {
    fs.rmSync(lockFile, { force: true });
    console.log('Not running.');
    return 0;
  }
  process.kill(holder.pid);
  if (!await waitFor(() => !isAlive(holder.pid), 10_000)) {
    console.error(`Process ${holder.pid} did not stop.`);
    return 1;
  }
  // On Windows the process ends at once, with no chance to remove this itself.
  fs.rmSync(lockFile, { force: true });
  console.log('Stopped.');
  return 0;
}

const modes = { '--background': background, '--once': once, '--status': status, '--stop': stop };
const mode = process.argv[2];
if (mode === undefined) foreground();
else if (modes[mode]) process.exitCode = await modes[mode]();
else {
  console.error(`usage: node scripts/watch.mjs [${Object.keys(modes).join(' | ')}]`);
  process.exitCode = 2;
}
