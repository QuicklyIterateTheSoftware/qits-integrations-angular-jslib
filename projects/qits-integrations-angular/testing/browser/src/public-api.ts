/*
 * Public API of @qits/angular/testing/browser: the golden-master guard for browser specs (epic
 * qits-112) and the screenshot freezes (ticket qits-1947). Browser-safe, unlike
 * @qits/angular/testing, which reads node_modules.
 */
export * from './golden-master-guard';
export * from './describe-routes';
export { FREEZE_ASSET_PREFIX, freezeShot, type ShotFreeze } from './freeze-shot';
export * from './freeze-screenshots';
