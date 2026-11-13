/*
 * Public API of @qits/angular/pwa: the installable offline shell (ticket qits-2152). A separate
 * entry because it imports @angular/service-worker, an optional peer the main entry must never
 * force on every consumer.
 */
export * from './provide-qits-pwa';
export * from './qits-pwa-updates';
export * from './qits-pwa-update-prompt';
