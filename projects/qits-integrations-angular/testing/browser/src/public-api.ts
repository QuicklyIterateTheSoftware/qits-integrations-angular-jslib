/*
 * Public API of @qits/angular/testing/browser: the golden-master guard for browser specs (epic
 * qits-112), the screenshot freezes (ticket qits-1947) and the outcome records (ticket qits-2001).
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
export * from './record-outcomes';
