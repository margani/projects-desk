#!/usr/bin/env node
// Calls the Cloudflare API with a saved token, never printing it.
//   cfapi GET /accounts                               read token
//   cfapi --edit POST /accounts/<id>/... -d '{...}'   edit token
//   cfapi --save read|edit                            save a token typed on stdin
// Tokens: ~/.config/cloudflare/{read,edit}.token. CLOUDFLARE_API_TOKEN is used
// when the file is missing. Prints the JSON response; exits 1 if success is
// false, 2 on bad usage, 3 if there is no token.
//
// In Node rather than bash with curl and jq, so that one copy runs on Windows,
// macOS and Linux. fetch also keeps the token off every command line, where
// any process on the machine could read it with ps.
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const USAGE = 'usage: cfapi [--edit] METHOD /path [-d data] [--data-binary @file] [-H "name: value"]\n       cfapi --save read|edit';

export function tokenFile(kind, env = process.env) {
  const config = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), '.config');
  return path.join(config, 'cloudflare', `${kind}.token`);
}

function readToken(kind, env) {
  try {
    const saved = readFileSync(tokenFile(kind, env), 'utf8').trim();
    if (saved) return saved;
  } catch { /* no file: the environment variable may have one */ }
  return env.CLOUDFLARE_API_TOKEN ?? '';
}

/** curl's meaning: `-d @file` drops line ends, `--data-binary @file` keeps them. */
function bodyFrom(value, binary) {
  if (!value.startsWith('@')) return value;
  const text = readFileSync(value.slice(1), 'utf8');
  return binary ? text : text.replace(/[\r\n]/g, '');
}

function parseOptions(args) {
  const options = { headers: {}, body: undefined };
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (value === undefined) return null;
    if (flag === '-d' || flag === '--data') options.body = bodyFrom(value, false);
    else if (flag === '--data-binary') options.body = bodyFrom(value, true);
    else if (flag === '-H' || flag === '--header') {
      const at = value.indexOf(':');
      if (at < 1) return null;
      options.headers[value.slice(0, at).trim()] = value.slice(at + 1).trim();
    } else return null;
  }
  return options;
}

/** Runs one call and returns the exit code. Everything it touches can be injected. */
export async function cfapi(argv, { env = process.env, fetch: request = fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  const say = (text) => stderr.write(`${text}\n`);
  const args = [...argv];
  let kind = 'read';
  if (args[0] === '--edit') { kind = 'edit'; args.shift(); }
  if (args.length < 2) { say(USAGE); return 2; }
  const [method, apiPath, ...rest] = args;
  let options;
  try {
    options = parseOptions(rest);
  } catch (err) {
    say(`cfapi: ${err.message}`);
    return 1;
  }
  if (!options) { say(USAGE); return 2; }
  const token = readToken(kind, env);
  if (!token) { say(`no ${kind} token: save one in ${tokenFile(kind, env)} (see docs/SETUP.md)`); return 3; }

  let text;
  try {
    const response = await request(`${API}${apiPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${token}` },
      body: options.body,
    });
    text = await response.text();
  } catch (err) {
    // The status publish quotes this line in its one notice per outage.
    say(`cfapi: could not reach api.cloudflare.com: ${err.cause?.code ?? err.message}`);
    return 1;
  }
  stdout.write(`${text}\n`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    say('cfapi: the answer is not JSON');
    return 1;
  }
  return body?.success === false ? 1 : 0;
}

/** Saves a token from text read on stdin. Prints where, never the value. */
export function saveToken(kind, input, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (kind !== 'read' && kind !== 'edit') { stderr.write(`${USAGE}\n`); return 2; }
  const token = input.trim();
  if (!token || /\s/.test(token)) { stderr.write('cfapi: that is not a token (empty, or it has spaces in it). Nothing was saved.\n'); return 1; }
  const file = tokenFile(kind, env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  // writeFile's mode only applies to a new file, and an older one may be open to others.
  chmodSync(file, 0o600);
  stdout.write(`Saved the ${kind} token in ${file}\n`);
  return 0;
}

async function readStdinLine() {
  process.stderr.write('Paste the token, then press Enter: ');
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.includes('\n')) break;
  }
  return text.split('\n')[0];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  process.stdin.setEncoding('utf8');
  process.exitCode = argv[0] === '--save' ? saveToken(argv[1], await readStdinLine()) : await cfapi(argv);
}
