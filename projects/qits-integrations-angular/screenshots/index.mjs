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
 *
 * `screenshotReferences({ freezes: true })` also writes every passing screenshot as HTML (ticket
 * qits-1947), with `freezeScreenshots()` from `@qits/angular/testing/browser` in the setup file.
 * With `recordOutcomes()` there too, the manifest carries the outcomes the tests reached, and
 * `--check` names the declared outcomes no test reaches or no screenshot shows (ticket qits-2003).
 */
export { completeForFreezes, screenshotReferences } from './plugin.mjs';
export { DEFAULT_FREEZE_DIRECTORY, DEFAULT_ROUTE_SPECS, freezeSlug } from './freezes.mjs';
export { findOrphans, pruneOrphans } from './orphans.mjs';
export { declaredOutcomes, libraryOutcomes, outcomeGaps } from './outcomes.mjs';
export { DEFAULT_RECORD, readRecord } from './record.mjs';
