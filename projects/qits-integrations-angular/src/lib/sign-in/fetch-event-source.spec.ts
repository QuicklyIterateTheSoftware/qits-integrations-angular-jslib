import { FetchEventSource, SseParser } from './fetch-event-source';

describe('SseParser', () => {
  it('dispatches a message on a blank line, joining data lines', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\ndata: second\n\n')).toEqual([
      { event: '', data: '{"a":1}\nsecond' },
    ]);
  });

  it('waits for the rest of a message split across chunks, CRLF split included', () => {
    const parser = new SseParser();
    expect(parser.push('data: hel')).toEqual([]);
    expect(parser.push('lo\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual([{ event: '', data: 'hello' }]);
  });

  it('reads comments, ids and retries past, and keeps the event name', () => {
    const parser = new SseParser();
    expect(parser.push(':keep-alive\nid: 7\nretry: 1000\nevent: ping\ndata:x\n\n')).toEqual([
      { event: 'ping', data: 'x' },
    ]);
  });

  it('dispatches nothing for a frame without data, and drops a leading BOM', () => {
    const parser = new SseParser();
    expect(parser.push('\uFEFFevent: empty\n\ndata: y\r\r\n')).toEqual([{ event: '', data: 'y' }]);
  });
});

describe('FetchEventSource', () => {
  /** A response whose body the spec writes chunk by chunk. */
  function streamed() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
    const encoder = new TextEncoder();
    return {
      response: new Response(body, { status: 200 }),
      write: (text: string) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve));

  it('sends the bearer, hands unnamed messages to onmessage and fails CLOSED at the end', async () => {
    const stream = streamed();
    const fetchFn = vi.fn(async () => stream.response);
    const source = new FetchEventSource(
      'https://events.example/events/api/stream',
      async () => 'T',
      fetchFn,
    );
    const messages: string[] = [];
    const errors: number[] = [];
    source.onmessage = (event) => messages.push(event.data);
    source.onerror = () => errors.push(source.readyState);
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
    expect(messages).toEqual(['{"id":"1"}']);
    stream.end();
    await settle();
    expect(errors).toEqual([2]);
  });

  it('fails CLOSED when the stream is refused', async () => {
    const source = new FetchEventSource(
      '/s',
      async () => null,
      async () => new Response('', { status: 401 }),
    );
    const errors: number[] = [];
    source.onerror = () => errors.push(source.readyState);
    await settle();
    expect(errors).toEqual([2]);
  });

  it('stays quiet after close', async () => {
    const stream = streamed();
    const source = new FetchEventSource(
      '/s',
      async () => 'T',
      async () => stream.response,
    );
    const calls: string[] = [];
    source.onmessage = () => calls.push('message');
    source.onerror = () => calls.push('error');
    await settle();
    source.close();
    stream.write('data: late\n\n');
    await settle();
    expect(calls).toEqual([]);
  });
});
