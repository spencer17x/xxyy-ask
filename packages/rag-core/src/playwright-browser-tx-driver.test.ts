import { describe, expect, it } from 'vitest';

import {
  buildXxyySolPoolUrl,
  selectMatchingSearchItemIndex,
} from './playwright-browser-tx-driver.js';

describe('buildXxyySolPoolUrl', () => {
  it('builds a direct XXYY Solana pool URL from the Solscan pool address', () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';

    expect(buildXxyySolPoolUrl('https://www.xxyy.io/discover', poolAddress)).toBe(
      'https://www.xxyy.io/sol/9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7',
    );
  });

  it('keeps the configured XXYY origin for direct pool URLs', () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';

    expect(buildXxyySolPoolUrl('https://staging.xxyy.io/discover', poolAddress)).toBe(
      'https://staging.xxyy.io/sol/9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7',
    );
  });
});

describe('selectMatchingSearchItemIndex', () => {
  it('prefers the XXYY search result whose abbreviated pair matches the Solscan pool', () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';

    const index = selectMatchingSearchItemIndex(
      [
        { text: 'BRIM / SOL Token: 9smM...pump Pair: 1111...1111' },
        { text: 'BRIM / SOL Token: 9smM...pump Pair: 9hXD...MyJ7' },
        { text: 'DYN2 BRIM / SOL Token: 9smM...pump Pair: 2TxX...5arg' },
      ],
      poolAddress,
    );

    expect(index).toBe(1);
  });

  it('does not fall back to the first result when Solscan has a pool and XXYY has no match', () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';

    const index = selectMatchingSearchItemIndex(
      [
        { text: 'BRIM / SOL Token: 9smM...pump Pair: HgRh...dgNE' },
        { text: 'DYN2 BRIM / SOL Token: 9smM...pump Pair: 2TxX...5arg' },
      ],
      poolAddress,
    );

    expect(index).toBe(-1);
  });
});
