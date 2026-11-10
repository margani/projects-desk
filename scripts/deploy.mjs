#!/usr/bin/env node
// `npm run deploy`, on Windows, macOS and Linux. See scripts/lib/deploy.mjs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploy } from './lib/deploy.mjs';

process.exitCode = await deploy({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
