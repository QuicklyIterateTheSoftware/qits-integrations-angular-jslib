import { InjectionToken } from '@angular/core';

/**
 * The part of `WebSocket` a consumer uses, named so a spec can hand over a fake: a socket is opened
 * by the browser and never goes through `HttpClient`, so `HttpTestingController` has nothing to
 * intercept. One handler each is all anything sets.
 *
 * `close()` takes no code on purpose: only the server's close code is read, and a 1000 from the
 * server (the command is gone) is something the client must not be able to fake.
 */
export interface WebSocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

/** `WebSocket.CONNECTING`, `OPEN` and `CLOSED`, without reading the global (absent on the server). */
export const WEB_SOCKET_CONNECTING = 0;
export const WEB_SOCKET_OPEN = 1;
export const WEB_SOCKET_CLOSED = 3;

/** Opens a socket at an absolute `ws://` or `wss://` URL, offering `protocols` if given. */
export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocketLike;

/**
 * How a consumer opens a WebSocket on a platform host. Without `provideQitsBearerSignIn`, the
 * browser's own; with it, a {@link BearerWebSocket}, which offers the bearer as a subprotocol.
 */
export const QITS_WEB_SOCKET = new InjectionToken<WebSocketFactory>('QITS_WEB_SOCKET', {
  providedIn: 'root',
  factory: () => (url, protocols) => new WebSocket(url, protocols) as WebSocketLike,
});

/**
 * The subprotocol that marks the bearer offer. qits-edge (qits-1246; epic qits-543 widens it from
 * the loopback to every origin under the platform domain) moves the next offered protocol, the
 * token, into `Authorization: Bearer`, strips both from what it forwards, and answers the
 * handshake with `Sec-WebSocket-Protocol: qits.bearer`.
 */
export const BEARER_PROTOCOL = 'qits.bearer';

/**
 * A WebSocket that signs in with the bearer, since a browser WebSocket cannot send a header
 * (`provideQitsBearerSignIn` makes {@link QITS_WEB_SOCKET} open these). It offers
 * `['qits.bearer', <access token>, ...protocols]`.
 *
 * The token is fetched first (`QitsTokens.accessToken()`, which refreshes one that is about to
 * end), so the real socket opens a moment later; until then this is `CONNECTING`, and `send()`
 * is not allowed, as on a real one. A `close()` before then opens nothing and reports the close.
 * Without a token it fails as a refused handshake does: `onerror`, then `onclose` (1006). It does
 * not reconnect by itself; its user does.
 */
export class BearerWebSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private socket: WebSocketLike | null = null;
  private closed = false;

  constructor(
    readonly url: string,
    token: () => Promise<string | null>,
    open: WebSocketFactory,
    readonly protocols: readonly string[] = [],
  ) {
    void this.run(token, open);
  }

  get readyState(): number {
    if (this.socket) return this.socket.readyState;
    return this.closed ? WEB_SOCKET_CLOSED : WEB_SOCKET_CONNECTING;
  }

  send(data: string): void {
    if (!this.socket) throw new Error('The socket is not open yet.');
    this.socket.send(data);
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
      return;
    }
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(closeEvent());
  }

  private async run(token: () => Promise<string | null>, open: WebSocketFactory): Promise<void> {
    const bearer = await token().catch(() => null);
    if (this.closed) return;
    if (!bearer) {
      this.closed = true;
      this.onerror?.(new Event('error'));
      this.onclose?.(closeEvent());
      return;
    }
    const socket = open(this.url, [BEARER_PROTOCOL, bearer, ...this.protocols]);
    socket.onopen = (event) => this.onopen?.(event);
    socket.onmessage = (event) => this.onmessage?.(event);
    socket.onerror = (event) => this.onerror?.(event);
    socket.onclose = (event) => this.onclose?.(event);
    this.socket = socket;
  }
}

/** What a handshake that never completed closes with: 1006, not clean. */
function closeEvent(): CloseEvent {
  return new CloseEvent('close', { code: 1006, wasClean: false });
}
