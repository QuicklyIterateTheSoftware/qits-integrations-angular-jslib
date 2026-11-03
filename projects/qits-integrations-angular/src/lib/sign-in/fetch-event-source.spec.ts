import { FetchEventSource, RECONNECT_MS, SseParser } from './fetch-event-source';

describe('SseParser', () => {
  it('dispatches a message on a blank line, joining data lines', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\ndata: second\n\n')).toEqual([
      { event: '', data: '{"a":1}\nsecond', lastEventId: '' },
    ]);
  });

  it('waits for the rest of a message split across chunks, CRLF split included', () => {
    const parser = new SseParser();
    expect(parser.push('data: hel')).toEqual([]);
    expect(parser.push('lo\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual([{ event: '', data: 'hello', lastEventId: '' }]);
  });

  it('reads comments past, keeps the event name, the id and the retry', () => {
    const parser = new SseParser();
    expect(parser.push(':keep-alive\nid: 7\nretry: 1000\nevent: ping\ndata:x\n\n')).toEqual([
      { event: 'ping', data: 'x', lastEventId: '7' },
    ]);
    expect(parser.lastEventId).toBe('7');
    expect(parser.retry).toBe(1000);
  });

  it('dispatches nothing for a frame without data, and drops a leading BOM', () => {
    const parser = new SseParser();
    expect(parser.push('﻿event: empty\n\ndata: y\r\r\n')).toEqual([
      { event: '', data: 'y', lastEventId: '' },
    ]);
  });

  it('takes the id at dispatch, keeps it across frames, and ignores a NUL id and a bad retry', () => {
    const parser = new SseParser('3');
    expect(parser.lastEventId).toBe('3');
    expect(parser.push('id: 4\n')).toEqual([]);
    expect(parser.lastEventId).toBe('3');
    expect(parser.push('\ndata: a\n\nid: x\0y\nretry: 5s\ndata: b\n\n')).toEqual([
      { event: '', data: 'a', lastEventId: '4' },
      { event: '', data: 'b', lastEventId: '4' },
    ]);
    expect(parser.retry).toBeNull();
    parser.push('id\n\n');
    expect(parser.lastEventId).toBe('');
  });
});

describe('FetchEventSource', () => {
  /** A response whose body the spec writes chunk by chunk. */
  function streamed(status = 200) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
    const encoder = new TextEncoder();
    return {
      response: new Response(body, { status }),
      write: (text: string) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
      fail: () => controller.error(new TypeError('network')),
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const headersOf = (fetchFn: ReturnType<typeof vi.fn>, call: number) =>
    (fetchFn.mock.calls[call][1] as RequestInit).headers as Record<string, string>;

  /** Records the callbacks as they fire, with the readyState each saw. */
  function record(source: FetchEventSource): string[] {
    const calls: string[] = [];
    source.onopen = () => calls.push(`open:${source.readyState}`);
    source.onmessage = (event) => calls.push(`message:${event.data}`);
    source.onerror = () => calls.push(`error:${source.readyState}`);
    return calls;
  }

  it('sends the bearer, fires onopen on a 2xx and hands unnamed messages to onmessage', async () => {
    const stream = streamed();
    const fetchFn = vi.fn(async () => stream.response);
    const source = new FetchEventSource(
      'https://events.example/events/api/stream',
      async () => 'T',
      fetchFn,
    );
    const calls = record(source);
    expect(source.readyState).toBe(0);
    await settle();
    expect(fetchFn).toHaveBeenCalledWith(
      'https://events.example/events/api/stream',
      expect.objectContaining({
        headers: { accept: 'text/event-stream', authorization: 'Bearer T' },
      }),
    );
    expect(source.readyState).toBe(1);
    stream.write('data: {"id":"1"}\n\nevent: other\ndata: skip\n\n');
    await settle();
    expect(calls).toEqual(['open:1', 'message:{"id":"1"}']);
    source.close();
  });

  it('reconnects a dropped stream after the retry it asked for, with Last-Event-ID and a fresh token', async () => {
    const first = streamed();
    const second = streamed();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    const token = vi.fn().mockResolvedValueOnce('T1').mockResolvedValueOnce('T2');
    const source = new FetchEventSource('/s', token, fetchFn);
    const calls = record(source);
    await settle();
    first.write('retry: 20\nid: 7\ndata: a\n\n');
    first.end();
    await settle();
    expect(calls).toEqual(['open:1', 'message:a', 'error:0']);
    expect(source.readyState).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(headersOf(fetchFn, 1)).toEqual({
      accept: 'text/event-stream',
      authorization: 'Bearer T2',
      'last-event-id': '7',
    });
    await settle();
    second.write('data: b\n\n');
    await settle();
    expect(calls).toEqual(['open:1', 'message:a', 'error:0', 'open:1', 'message:b']);
    source.close();
  });

  it('waits RECONNECT_MS (3 s) by default, and sends no Last-Event-ID when no id came', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const first = streamed();
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(first.response)
        .mockResolvedValue(streamed().response);
      const source = new FetchEventSource('/s', async () => 'T', fetchFn);
      await vi.advanceTimersByTimeAsync(0);
      first.end();
      await vi.advanceTimersByTimeAsync(RECONNECT_MS - 1);
      expect(RECONNECT_MS).toBe(3000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(headersOf(fetchFn, 1)).toEqual({
        accept: 'text/event-stream',
        authorization: 'Bearer T',
      });
      source.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects after a network failure, before and after the open', async () => {
    const stream = streamed();
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValue(new Response('', { status: 503 }));
    const source = new FetchEventSource('/s', async () => 'T', fetchFn, { reconnectMs: 5 });
    const calls = record(source);
    await vi.waitFor(() => expect(calls).toEqual(['error:0', 'open:1']));
    stream.fail();
    await vi.waitFor(() => expect(calls).toEqual(['error:0', 'open:1', 'error:0', 'error:2']));
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('treats a non-2xx answer as final: CLOSED, one onerror, no reconnect', async () => {
    for (const status of [404, 500, 204]) {
      const fetchFn = vi.fn(async () => new Response(status === 204 ? null : '', { status }));
      const source = new FetchEventSource('/s', async () => 'T', fetchFn, { reconnectMs: 1 });
      const calls = record(source);
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toEqual(['error:2']);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it('fails CLOSED on a 401 when it has no way to refresh', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 401 }));
    const source = new FetchEventSource('/s', async () => null, fetchFn);
    const calls = record(source);
    await settle();
    expect(calls).toEqual(['error:2']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries a 401 once with the refreshed token, and opens', async () => {
    const stream = streamed();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(stream.response);
    const retryToken = vi.fn(async () => 'FRESH');
    const source = new FetchEventSource('/s', async () => 'OLD', fetchFn, { retryToken });
    const calls = record(source);
    await vi.waitFor(() => expect(calls).toEqual(['open:1']));
    expect(retryToken).toHaveBeenCalledWith('OLD');
    expect(headersOf(fetchFn, 1)).toEqual({
      accept: 'text/event-stream',
      authorization: 'Bearer FRESH',
    });
    source.close();
  });

  it('gives up after the retried request is refused too, or when the refresh fails', async () => {
    const twice = vi.fn(async () => new Response('', { status: 401 }));
    const retryToken = vi.fn(async () => 'FRESH');
    const refused = new FetchEventSource('/s', async () => 'OLD', twice, {
      retryToken,
      reconnectMs: 1,
    });
    const refusedCalls = record(refused);

    const once = vi.fn(async () => new Response('', { status: 401 }));
    const failed = new FetchEventSource('/s', async () => 'OLD', once, {
      retryToken: async () => null,
      reconnectMs: 1,
    });
    const failedCalls = record(failed);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refusedCalls).toEqual(['error:2']);
    expect(twice).toHaveBeenCalledTimes(2);
    expect(retryToken).toHaveBeenCalledTimes(1);
    expect(failedCalls).toEqual(['error:2']);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('stays quiet after close', async () => {
    const stream = streamed();
    const source = new FetchEventSource(
      '/s',
      async () => 'T',
      async () => stream.response,
    );
    await settle();
    const calls = record(source);
    source.close();
    expect(source.readyState).toBe(2);
    stream.write('data: late\n\n');
    await settle();
    expect(calls).toEqual([]);
  });

  it('does not reconnect when onerror closes it, nor once closed while waiting', async () => {
    const fetchFn = vi.fn(async () => {
      const stream = streamed();
      stream.end();
      return stream.response;
    });
    const fromHandler = new FetchEventSource('/s', async () => 'T', fetchFn, { reconnectMs: 1 });
    fromHandler.onerror = () => fromHandler.close();

    const waiting = vi.fn(async () => {
      const stream = streamed();
      stream.end();
      return stream.response;
    });
    const whileWaiting = new FetchEventSource('/s', async () => 'T', waiting, {
      reconnectMs: 10,
    });
    whileWaiting.onerror = () => queueMicrotask(() => whileWaiting.close());

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fromHandler.readyState).toBe(2);
    expect(waiting).toHaveBeenCalledTimes(1);
    expect(whileWaiting.readyState).toBe(2);
  });
});
