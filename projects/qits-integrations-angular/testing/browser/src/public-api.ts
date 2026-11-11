/*
 * Public API of @qits/angular/testing/browser: the golden-master guard for browser specs (epic
 * qits-112), the screenshot freezes (ticket qits-1947) with their kinds and preset widths (ticket
 * qits-2046), and the outcome records (ticket qits-2001).
 * Browser-safe, unlike @qits/angular/testing, which reads node_modules.
 */
export * from './golden-master-guard';
export * from './describe-routes';
export {
  BLOB_PLACEHOLDER,
  DEFAULT_DROPPED_INLINE_STYLES,
  DEFAULT_RENAMED_CLASSES,
  FREEZE_ASSET_PREFIX,
  freezeShot,
  type DroppedInlineStyle,
  type FreezeShotOptions,
  type ShotFreeze,
} from './freeze-shot';
export * from './freeze-screenshots';
// Importing the entry also brings the `toMatchScreenshot` options' augmentation (kind, viewports,
// reason) into the program.
export {
  SCREENSHOT_KINDS,
  SCREENSHOT_VIEWPORTS,
  type ScreenshotKind,
  type ScreenshotViewport,
  type ScreenshotViewportSize,
} from './screenshot-options';
export * from './record-outcomes';
