import { InjectionToken } from '@angular/core';

/**
 * The part of `EventSource` a consumer uses, so a spec can hand it a fake. `onopen` is optional so
 * a fake that never opens need not carry it; the browser's `EventSource` and {@link FetchEventSource}
 * both have it.
 */
export interface EventSourceLike {
  onopen?: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  close(): void;
}

/** Opens an event source on an absolute URL. */
export type EventSourceFactory = (url: string) => EventSourceLike;

/**
 * How a consumer opens an event stream on a platform host. Without `provideQitsBearerSignIn`, the
 * browser's `EventSource` with credentials; with it, a {@link FetchEventSource} that sends the
 * bearer.
 */
export const QITS_EVENT_SOURCE = new InjectionToken<EventSourceFactory>('QITS_EVENT_SOURCE', {
  providedIn: 'root',
  factory: () => (url) => new EventSource(url, { withCredentials: true }),
});

/** One dispatched Server-Sent Events message. */
export interface SseMessage {
  /** The `event:` field; '' when the frame named none, which `EventSource` calls `message`. */
  readonly event: string;
  readonly data: string;
  /** The last event ID as of this message (`MessageEvent.lastEventId`). */
  readonly lastEventId: string;
}

/**
 * The Server-Sent Events wire format (WHATWG HTML, "Parsing an event stream"): feed it text as it
 * arrives, in pieces of any size; it answers the messages that are complete. Lines end in LF, CR
 * or CRLF; `data:` lines join with LF; a blank line dispatches; `:` starts a comment.
 *
 * `id:` and `retry:` are kept for a reconnect: {@link lastEventId} is the id as of the last
 * dispatch (a blank line, with or without data; an `id` holding NUL is ignored), which the next
 * connection sends as `Last-Event-ID`; {@link retry} is the last `retry:` that was all digits, in
 * milliseconds, or null when none came.
 */
export class SseParser {
  private buffer = '';
  private started = false;
  private event = '';
  private data: string[] = [];
  private idBuffer: string;

  /** The last event ID: '' until a dispatched frame carried one. */
  lastEventId: string;

  /** The reconnection time the stream asked for, in milliseconds; null until it asks. */
  retry: number | null = null;

  /** `lastEventId`: the id a previous connection ended on, so a frame without `id:` keeps it. */
  constructor(lastEventId = '') {
    this.lastEventId = lastEventId;
    this.idBuffer = lastEventId;
  }

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    if (!this.started && this.buffer.length > 0) {
      this.started = true;
      if (this.buffer.startsWith('\uFEFF')) this.buffer = this.buffer.slice(1);
    }
    const messages: SseMessage[] = [];
    for (;;) {
      const end = this.buffer.search(/\r\n|\r|\n/);
      if (end < 0) break;
      // A lone CR at the end may be the first half of a CRLF still on its way.
      if (this.buffer[end] === '\r' && end === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + (this.buffer.startsWith('\r\n', end) ? 2 : 1));
      const message = this.line(line);
      if (message) messages.push(message);
    }
    return messages;
  }

  private line(line: string): SseMessage | undefined {
    if (line === '') {
      this.lastEventId = this.idBuffer;
      const message =
        this.data.length > 0
          ? { event: this.event, data: this.data.join('\n'), lastEventId: this.lastEventId }
          : undefined;
      this.event = '';
      this.data = [];
      return message;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.idBuffer = value;
    else if (field === 'retry' && /^[0-9]+$/.test(value)) this.retry = Number(value);
    return undefined;
  }
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/** How long a dropped stream waits before it reconnects, until the stream sends `retry:`. */
export const RECONNECT_MS = 3000;

/** What {@link FetchEventSource} needs besides the URL and the token, all optional. */
export interface FetchEventSourceOptions {
  /**
   * A token to retry with after `used` got a 401 (`QitsTokens.retryToken`). Without it a 401 is
   * final, like any other refusal.
   */
  readonly retryToken?: (used: string | null) => Promise<string | null>;
  /** The wait before a reconnect until the stream sends `retry:`; {@link RECONNECT_MS}. */
  readonly reconnectMs?: number;
}

/** Why one connection ended: the stream dropped (reconnect), or the server refused it (final). */
type Ended = 'dropped' | 'refused' | 'closed';

/**
 * An `EventSource` stand-in that reads the stream with `fetch()`, so it can send
 * `Authorization: Bearer`, which `EventSource` cannot, and the edge accepts no token in the query
 * (`provideQitsBearerSignIn` makes {@link QITS_EVENT_SOURCE} open these). It behaves like the
 * browser's `EventSource` where consumers lean on it:
 *
 * - `CONNECTING` until the answer is a 2xx with a body; then `OPEN` and `onopen`.
 * - A stream that drops or ends, or a network failure, is `CONNECTING` again, then `onerror`, then
 *   a new connection after the reconnection time ({@link RECONNECT_MS}, or the stream's last
 *   `retry:`), with a fresh token and `Last-Event-ID` when the stream sent ids. An `onerror` that
 *   calls `close()` stops it.
 * - A non-2xx answer (or a 204) is final: `CLOSED`, then `onerror`, and nothing reopens it. A 401
 *   first gets one retry with `options.retryToken` (the provider passes `QitsTokens.retryToken`);
 *   only when that is refused too, or there is no token to retry with, does it give up.
 * - `close()` stops everything: the open request, a pending reconnect, every callback.
 *
 * Like `EventSource`, only unnamed (or `message`) frames reach `onmessage`.
 */
export class FetchEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = CONNECTING;

  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEventId = '';
  private reconnectMs: number;
  private readonly retryToken: FetchEventSourceOptions['retryToken'];

  constructor(
    readonly url: string,
    private readonly token: () => Promise<string | null>,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
    options: FetchEventSourceOptions = {},
  ) {
    this.retryToken = options.retryToken;
    this.reconnectMs = options.reconnectMs ?? RECONNECT_MS;
    void this.connect();
  }

  close(): void {
    this.readyState = CLOSED;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
  }

  private async connect(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    const ended = await this.read(abort.signal);
    if (ended === 'closed' || this.readyState === CLOSED || this.abort !== abort) return;
    this.abort = null;
    if (ended === 'refused') {
      this.readyState = CLOSED;
      this.onerror?.(new Event('error'));
      return;
    }
    this.readyState = CONNECTING;
    this.onerror?.(new Event('error'));
    if (this.readyState !== CONNECTING) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.readyState === CONNECTING) void this.connect();
    }, this.reconnectMs);
  }

  /** One connection, from the request to the end of the body. */
  private async read(signal: AbortSignal): Promise<Ended> {
    try {
      let used = await this.token();
      if (signal.aborted) return 'closed';
      let response = await this.request(used, signal);
      if (response.status === 401 && this.retryToken) {
        used = await this.retryToken(used);
        if (signal.aborted) return 'closed';
        void response.body?.cancel().catch(() => undefined);
        if (!used) return 'refused';
        response = await this.request(used, signal);
      }
      if (!response.ok || response.status === 204) return 'refused';
      if (!response.body) return 'dropped';
      if (signal.aborted) return 'closed';
      this.readyState = OPEN;
      this.onopen?.(new Event('open'));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser(this.lastEventId);
      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        const messages = parser.push(decoder.decode(value, { stream: true }));
        if (parser.retry !== null) this.reconnectMs = parser.retry;
        for (const message of messages) {
          if (signal.aborted) return 'closed';
          if (message.event !== '' && message.event !== 'message') continue;
          this.onmessage?.(
            new MessageEvent('message', { data: message.data, lastEventId: message.lastEventId }),
          );
        }
        this.lastEventId = parser.lastEventId;
      }
    } catch {
      // A network failure or an abort: the stream dropped, unless it was closed.
    }
    return signal.aborted ? 'closed' : 'dropped';
  }

  private request(bearer: string | null, signal: AbortSignal): Promise<Response> {
    return this.fetchFn(this.url, {
      headers: {
        accept: 'text/event-stream',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(this.lastEventId ? { 'last-event-id': this.lastEventId } : {}),
      },
      cache: 'no-store',
      signal,
    });
  }
}
