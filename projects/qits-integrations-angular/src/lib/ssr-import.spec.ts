// @vitest-environment node
import { describe, expect, it } from 'vitest';

// An SSR app imports this library on the server, where there is no `window`, `document` or
// `location`. Importing the public API there must not throw.
describe('the public API on the server', () => {
  it('imports without a DOM', async () => {
    expect(typeof location).toBe('undefined');
    await expect(import('../public-api')).resolves.toBeDefined();
  });
});
