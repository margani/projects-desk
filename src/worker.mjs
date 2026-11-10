// Entry point for wrangler. dist/inline.mjs is written by scripts/build.mjs,
// which Workers Builds runs before it deploys.
import { css, js } from '../dist/inline.mjs';
import { createWorker } from '../scripts/lib/worker.mjs';

export default createWorker({ css, js });
