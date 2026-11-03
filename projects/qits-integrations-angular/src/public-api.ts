export { initQitsIntegration } from './lib/init-qits-integration';
export type { QitsIntegrationOptions } from './lib/init-qits-integration';
export { provideQitsIntegration } from './lib/provide-qits-integration';
export type { QitsIntegrationFeature } from './lib/provide-qits-integration';
export { withFeatureCapture } from './lib/with-feature-capture';
export type { CaptureFeatureOptions } from './lib/capture-config';
export { captureNow } from './lib/capture-now';
export type { CaptureResult } from './lib/capture-now';
export { freezeDocument, freezeElement } from './lib/document-freeze';
export type { FrozenDocument } from './lib/document-freeze';
export { pickElement } from './lib/element-picker';
export { nearestAppComponent } from './lib/app-component';
export type { CaptureSelection } from './lib/capture-payload';
export { withQitsSnapshot } from './lib/with-qits-snapshot';
export { registerCaptureState } from './lib/capture-state';
export type { CaptureStateSupplier } from './lib/capture-state';
export { consume, NOTHING } from './lib/consume';
export type { Consumed, ConsumedPaths } from './lib/consume';
export { provideQitsBearerSignIn } from './lib/sign-in/provide-qits-bearer-sign-in';
export {
  CALLBACK_PATH,
  isPlatformUrl,
  platformDomainOf,
  QITS_SIGN_IN,
} from './lib/sign-in/sign-in-settings';
export type { QitsBearerSignInOptions, QitsSignInSettings } from './lib/sign-in/sign-in-settings';
export {
  EXPIRY_SKEW_MS,
  QITS_SIGN_IN_FETCH,
  QitsTokens,
  REFRESH_AHEAD_MS,
} from './lib/sign-in/qits-tokens';
export { QitsSession, qitsSignedInGuard } from './lib/sign-in/qits-session';
export { qitsBearerInterceptor } from './lib/sign-in/bearer-interceptor';
export { QitsBearerFetch } from './lib/sign-in/bearer-fetch';
export { QitsAuthCallbackPage, qitsAuthCallbackRoute } from './lib/sign-in/auth-callback.page';
export {
  BEARER_PROTOCOL,
  BearerWebSocket,
  QITS_WEB_SOCKET,
  WEB_SOCKET_CLOSED,
  WEB_SOCKET_CONNECTING,
  WEB_SOCKET_OPEN,
} from './lib/sign-in/bearer-web-socket';
export type { WebSocketFactory, WebSocketLike } from './lib/sign-in/bearer-web-socket';
export {
  FetchEventSource,
  QITS_EVENT_SOURCE,
  RECONNECT_MS,
  SseParser,
} from './lib/sign-in/fetch-event-source';
export type {
  EventSourceFactory,
  EventSourceLike,
  FetchEventSourceOptions,
  SseMessage,
} from './lib/sign-in/fetch-event-source';
export { base64Url, randomToken, s256Challenge } from './lib/sign-in/pkce';
