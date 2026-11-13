/*
 * Public API of @qits/angular/testing/browser: the golden-master guard for browser specs (epic
 * qits-112), the screenshot freezes (ticket qits-1947) with their kinds and preset widths (ticket
 * qits-2046), and the outcome records (ticket qits-2001). `visibleDataMarks()` (ticket qits-2141)
 * reads the visible `data-qits-*` marks a shot shows, beside the outcome triggers. The offline
 * helpers (ticket qits-2151) take a page's offline, pending and conflict shots.
 * Browser-safe, unlike @qits/angular/testing, which reads node_modules.
 */
export * from './golden-master-guard';
export * from './describe-routes';
export {
  BLOB_PLACEHOLDER,
  DEFAULT_DROPPED_INLINE_STYLES,
  DEFAULT_EMPTIED_ELEMENTS,
  DEFAULT_RENAMED_CLASSES,
  FREEZE_ASSET_PREFIX,
  freezeShot,
  type DroppedInlineStyle,
  type FreezeShotOptions,
  type ShotFreeze,
} from './freeze-shot';
export * from './freeze-screenshots';
// Importing the entry also brings the `toMatchScreenshot` options' augmentation (kind, viewports,
// colorSchemes, reason) into the program.
export {
  COLOR_SCHEMES,
  SCREENSHOT_KINDS,
  SCREENSHOT_VIEWPORTS,
  type ColorScheme,
  type ScreenshotKind,
  type ScreenshotViewport,
  type ScreenshotViewportSize,
} from './screenshot-options';
export * from './record-outcomes';
export {
  conflictAnswer,
  goOffline,
  goOnline,
  OFFLINE_OPT_OUT_COMMAND,
  offlineShotsNotTaken,
  SEEDED_CACHED_AT,
  seedOfflineStore,
  shotConnectivity,
  STALE_VERSION_PROBLEM,
  type OfflineOptOutPayload,
  type OfflineShotsOptOut,
  type SeedOfflineStoreOptions,
  type ShotCachedRead,
  type ShotConnectivity,
  type ShotNetwork,
  type ShotOutboxEntry,
  type ShotOutboxState,
} from './offline-shots';
export { visibleDataMarks, type VisibleDataMark } from './visible-data-marks';
