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
 * Each freeze records the `kind` its shot gave and the preset `viewport` it was taken at (ticket
 * qits-2046), and, with `freezeScreenshots({ colorSchemes })`, the colour scheme it was taken in
 * (ticket qits-2083), which `--check` holds every page and layout shot to; with
 * `freezeScreenshots({ offline: true })`, the page's connectivity (ticket qits-2151), which `--check`
 * holds every route with offline resources to (`offlineGaps()`).
 */
export { completeForFreezes, screenshotReferences } from './plugin.mjs';
export {
  COLOR_SCHEMES,
  DEFAULT_FREEZE_DIRECTORY,
  DEFAULT_ROUTE_SPECS,
  FREEZE_COLOR_SCHEME_COMMAND,
  NETWORKS,
  OFFLINE_OPT_OUT_COMMAND,
  OUTBOX_STATES,
  RESET_COLOR_SCHEME,
  SCREENSHOT_KINDS,
  SCREENSHOT_VIEWPORTS,
  colorSchemeGaps,
  freezeFile,
  freezeSlug,
  offlineGaps,
} from './freezes.mjs';
export { findOrphans, pruneOrphans } from './orphans.mjs';
export {
  declaredOutcomes,
  forwardRoutes,
  libraryOutcomes,
  outcomeGaps,
  pageRoutes,
} from './outcomes.mjs';
export { DEFAULT_RECORD, readRecord } from './record.mjs';
