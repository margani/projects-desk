// Finds the repository's own bin/cfapi. Appended, so a helper the user already
// has on PATH wins.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin');
process.env.PATH = `${process.env.PATH ?? ''}${path.delimiter}${bin}`;
