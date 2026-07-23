import { describe, expect, it } from 'vitest';

import { createMemoryProviderResponseCache } from './cache.js';

describe('bounded provider response cache', () => {
  it('evicts least-recent entries by both count and aggregate bytes', async () => {
    const cache = createMemoryProviderResponseCache({
      maxEntries: 2,
      maxTotalBytes: 5,
    });
    await cache.write('a', { body: new Uint8Array(3), status: 200 }, 100);
    await cache.write('b', { body: new Uint8Array(3), status: 200 }, 100);
    expect(await cache.read('a', 0)).toBeUndefined();
    expect(await cache.read('b', 0)).toBeDefined();

    await cache.write('c', { body: new Uint8Array(2), status: 200 }, 100);
    await cache.write('d', { body: new Uint8Array(1), status: 200 }, 100);
    expect(await cache.read('b', 0)).toBeUndefined();
    expect(await cache.read('c', 0)).toBeDefined();
    expect(await cache.read('d', 0)).toBeDefined();
  });

  it('does not retain an individual entry larger than the total byte budget', async () => {
    const cache = createMemoryProviderResponseCache({
      maxEntries: 2,
      maxTotalBytes: 2,
    });
    await cache.write('oversized', { body: new Uint8Array(3), status: 200 }, 100);
    expect(await cache.read('oversized', 0)).toBeUndefined();
  });
});
