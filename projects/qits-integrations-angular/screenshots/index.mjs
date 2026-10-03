/**
 * @qits/angular/screenshots: reference screenshots that no screenshot test uses (epic qits-112).
 * Node-only, plain ESM, no build.
 *
 *   // vitest config of the browser tests
 *   import { screenshotReferences } from '@qits/angular/screenshots';
 *   export default defineConfig({ plugins: [screenshotReferences()], … });
 *
 *   // then, after the run
 *   qits-angular screenshots --check
 */
export { screenshotReferences } from './plugin.mjs';
export { findOrphans, pruneOrphans } from './orphans.mjs';
export { DEFAULT_RECORD, readRecord } from './record.mjs';
