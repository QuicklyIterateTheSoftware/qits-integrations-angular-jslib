import { sanitizeCaptureValue } from './capture-state-sanitize';

/** The feature's contract: everything the sanitizer returns stringifies without throwing. */
function roundTrips(value: unknown): unknown {
  return JSON.parse(JSON.stringify({ wrapped: value })).wrapped;
}

describe('sanitizeCaptureValue', () => {
  it('passes plain JSON values through untouched', () => {
    const value = { name: 'anna', count: 2, active: true, tags: ['a', 'b'], none: null };
    expect(sanitizeCaptureValue(value)).toEqual(value);
    expect(roundTrips(sanitizeCaptureValue(value))).toEqual(value);
  });

  it('breaks cycles with $circular', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(sanitizeCaptureValue(cyclic)).toEqual({ name: 'loop', self: '$circular' });
  });

  it('shared (non-cyclic) references serialize normally — ancestor-path tracking, not visited-set', () => {
    const shared = { id: 1 };
    expect(sanitizeCaptureValue({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it('caps depth at 8 with $depth-capped', () => {
    interface Nested {
      child?: Nested;
    }
    const root: Nested = {};
    let cursor = root;
    for (let i = 0; i < 9; i++) {
      cursor.child = {};
      cursor = cursor.child;
    }
    let sanitized = sanitizeCaptureValue(root) as Nested;
    for (let i = 0; i < 7; i++) {
      sanitized = sanitized.child as Nested;
    }
    expect(sanitized.child).toBe('$depth-capped');
  });

  it('converts Map and Set', () => {
    expect(sanitizeCaptureValue({ map: new Map([['k', 'v']]), set: new Set([1, 2]) })).toEqual({
      map: { k: 'v' },
      set: [1, 2],
    });
  });

  it('converts Date to its ISO string', () => {
    const date = new Date('2026-07-14T12:00:00Z');
    expect(sanitizeCaptureValue(date)).toBe('2026-07-14T12:00:00.000Z');
  });

  it('converts BigInt to a decimal string — the one value JSON.stringify throws on', () => {
    const sanitized = sanitizeCaptureValue({ big: 123456789012345678901234567890n });
    expect(sanitized).toEqual({ big: '123456789012345678901234567890' });
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  it('marks functions and symbols', () => {
    expect(sanitizeCaptureValue({ fn: () => 1, sym: Symbol('s') })).toEqual({
      fn: '$unserializable(function)',
      sym: '$unserializable(symbol)',
    });
  });

  it('marks DOM nodes with their type', () => {
    expect(sanitizeCaptureValue(document.createElement('div'))).toBe(
      '$unserializable(HTMLDivElement)',
    );
  });

  it('marks non-plain class instances with their constructor name', () => {
    class Foo {
      bar = 1;
    }
    expect(sanitizeCaptureValue(new Foo())).toBe('$unserializable(Foo)');
  });

  it('marks typed arrays — megabytes of canvas pixels stay out of captures', () => {
    expect(sanitizeCaptureValue(new Uint8Array([1, 2, 3]))).toBe('$unserializable(Uint8Array)');
  });

  it('recurses into null-prototype objects (plain by construction)', () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { k: 'v' });
    expect(sanitizeCaptureValue(value)).toEqual({ k: 'v' });
  });

  it('drops undefined object values, as JSON.stringify would', () => {
    expect(sanitizeCaptureValue({ present: 1, absent: undefined })).toEqual({ present: 1 });
  });
});
