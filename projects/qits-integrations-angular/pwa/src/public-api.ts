/*
 * Public API of @qits/angular/pwa: the installable offline shell (ticket qits-2152). A separate
 * entry because it imports @angular/service-worker, which is not a declared peer (qits-2208) —
 * the main entry must never force it on every consumer, and an app importing this entry adds it
 * itself, at the same version as its @angular/core.
 */
export * from './provide-qits-pwa';
export * from './qits-pwa-updates';
export * from './qits-pwa-update-prompt';
