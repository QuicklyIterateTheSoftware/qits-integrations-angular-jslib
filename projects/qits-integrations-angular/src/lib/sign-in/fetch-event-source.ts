import { InjectionToken } from '@angular/core';

/** The part of `EventSource` a consumer uses, so a spec can hand it a fake. */
export interface EventSourceLike {
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
}

/**
 * The Server-Sent Events wire format (WHATWG HTML, "Parsing an event stream"): feed it text as it
 * arrives, in pieces of any size; it answers the messages that are complete. Lines end in LF, CR
 * or CRLF; `data:` lines join with LF; a blank line dispatches; `:` starts a comment; `id:` and
 * `retry:` are read past (nothing here resumes a stream).
 */
export class SseParser {
  private buffer = '';
  private started = false;
  private event = '';
  private data: string[] = [];

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
      const message =
        this.data.length > 0 ? { event: this.event, data: this.data.join('\n') } : undefined;
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
    return undefined;
  }
}

const OPEN = 1;
const CLOSED = 2;

/**
 * An `EventSource` stand-in that reads the stream with `fetch()`, so it can send
 * `Authorization: Bearer`, which `EventSource` cannot, and the edge accepts no token in the query
 * (`provideQitsBearerSignIn` makes {@link QITS_EVENT_SOURCE} open these).
 *
 * It does not reconnect by itself: when the stream ends, fails or is refused, it is `CLOSED` and
 * calls `onerror`, and its user reopens it (the landing app's `DomainEvents`, with a doubling wait). Like `EventSource`, only
 * unnamed (or `message`) frames reach `onmessage`.
 */
export class FetchEventSource implements EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;

  private readonly abort = new AbortController();

  constructor(
    readonly url: string,
    token: () => Promise<string | null>,
    fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {
    void this.run(token, fetchFn);
  }

  close(): void {
    this.readyState = CLOSED;
    this.abort.abort();
  }

  private async run(token: () => Promise<string | null>, fetchFn: typeof fetch): Promise<void> {
    try {
      const bearer = await token();
      if (this.readyState === CLOSED) return;
      const response = await fetchFn(this.url, {
        headers: {
          accept: 'text/event-stream',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        cache: 'no-store',
        signal: this.abort.signal,
      });
      if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`);
      this.readyState = OPEN;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of parser.push(decoder.decode(value, { stream: true }))) {
          if (this.readyState === CLOSED) return;
          if (message.event !== '' && message.event !== 'message') continue;
          this.onmessage?.(new MessageEvent('message', { data: message.data }));
        }
      }
    } catch {
      // Ended below either way.
    }
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onerror?.(new Event('error'));
  }
}
