// Finds the repository's own bin/cfapi. Appended, so a helper the user already
// has on PATH wins.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin');
process.env.PATH = `${process.env.PATH ?? ''}${path.delimiter}${bin}`;

/**
 * What to execute for `cmd args`. Windows cannot execute the bin/cfapi bash
 * script, and Node will not run a .cmd without a shell, so there cfapi goes
 * straight to Node.
 */
export function launch(cmd, args, platform = process.platform) {
  if (cmd === 'cfapi' && platform === 'win32') return [process.execPath, [path.join(bin, 'cfapi.mjs'), ...args]];
  return [cmd, args];
}
