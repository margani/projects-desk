#!/usr/bin/env node
// Claude Code `Stop` hook: reads the hook input on stdin, answers on stdout.
// Set up as described in docs/STOP_GATE.md.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghWith, runGate } from './lib/stop-gate.mjs';

try {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const answer = await runGate(JSON.parse(text), {
    gh: ghWith(process.env.STOP_GATE_GH || 'gh'),
    owner: process.env.STOP_GATE_OWNER,
    stateDir: process.env.STOP_GATE_STATE_DIR || join(homedir(), '.local', 'state', 'claude-stop-gate'),
    statusDir: fileURLToPath(new URL('../status', import.meta.url)),
    projectDir: process.env.CLAUDE_PROJECT_DIR,
  });
  if (answer) process.stdout.write(JSON.stringify(answer));
} catch (error) {
  process.stdout.write(JSON.stringify({ systemMessage: `stop-gate: open issues were not checked (${error.message})` }));
}
