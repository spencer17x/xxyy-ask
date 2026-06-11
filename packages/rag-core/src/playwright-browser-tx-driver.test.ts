import { describe, expect, it } from 'vitest';

import {
  calculateXxyyOriginalTargetRowY,
  buildXxyyTradeWindow,
  buildXxyySolPoolUrl,
  calculateXxyyOriginalTradeScrollTop,
  extractSolanaFmPoolCandidates,
  selectXxyyPoolCandidate,
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

describe('buildXxyyTradeWindow', () => {
  it('builds a target-centered before and after window from structured XXYY trades', () => {
    const target = trade('target', 'target-maker', 'sell', 1000);
    const result = buildXxyyTradeWindow({
      afterTrades: [
        trade('after-1', 'after-maker-1', 'buy', 1001),
        trade('after-2', 'after-maker-2', 'sell', 1002),
      ],
      beforeTrades: [
        trade('before-5', 'before-maker-5', 'buy', 999),
        trade('before-4', 'before-maker-4', 'sell', 998),
        trade('before-3', 'before-maker-3', 'buy', 997),
        trade('before-2', 'before-maker-2', 'sell', 996),
        trade('before-1', 'before-maker-1', 'buy', 995),
      ],
      targetTrade: target,
    });

    expect(result).toMatchObject({
      targetTrade: {
        hash: 'target',
        side: 'sell',
        timestamp: '1970-01-01T00:00:01.000Z',
        traderAddress: 'target-maker',
      },
      tradeWindow: {
        after: [
          { hash: 'after-1', side: 'buy', traderAddress: 'after-maker-1' },
          { hash: 'after-2', side: 'sell', traderAddress: 'after-maker-2' },
        ],
        before: [
          { hash: 'before-1', side: 'buy', traderAddress: 'before-maker-1' },
          { hash: 'before-2', side: 'sell', traderAddress: 'before-maker-2' },
          { hash: 'before-3', side: 'buy', traderAddress: 'before-maker-3' },
          { hash: 'before-4', side: 'sell', traderAddress: 'before-maker-4' },
          { hash: 'before-5', side: 'buy', traderAddress: 'before-maker-5' },
        ],
      },
    });
  });
});

describe('calculateXxyyOriginalTradeScrollTop', () => {
  it('centers the target trade inside the original XXYY virtual list viewport', () => {
    expect(
      calculateXxyyOriginalTradeScrollTop({
        clientHeight: 320,
        rowHeight: 40,
        targetIndex: 1413,
      }),
    ).toBe(56380);
  });

  it('does not scroll before the beginning of the original XXYY list', () => {
    expect(
      calculateXxyyOriginalTradeScrollTop({
        clientHeight: 320,
        rowHeight: 40,
        targetIndex: 2,
      }),
    ).toBe(0);
  });
});

describe('calculateXxyyOriginalTargetRowY', () => {
  it('calculates the target row center inside the scroller viewport after scrolling', () => {
    expect(
      calculateXxyyOriginalTargetRowY({
        rowHeight: 40,
        scrollTop: 56380,
        targetIndex: 1413,
      }),
    ).toBe(160);
  });
});

describe('extractSolanaFmPoolCandidates', () => {
  it('extracts pool candidates and native SOL amounts from SolanaFM action text', () => {
    const candidates = extractSolanaFmPoolCandidates(`
      9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7
      sent
      0.041573611
      Wrapped SOL
      →
      ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn
      HgRhWnmKZMJqNzjrhTixnJ5CSsM4GYPDjhBVnJd6dgNE
      sent
      0.026877674
      Wrapped SOL
      →
      ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn
    `);

    expect(candidates).toEqual([
      {
        address: '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7',
        nativeAmount: '0.041573611',
      },
      {
        address: 'HgRhWnmKZMJqNzjrhTixnJ5CSsM4GYPDjhBVnJd6dgNE',
        nativeAmount: '0.026877674',
      },
    ]);
  });
});

describe('selectXxyyPoolCandidate', () => {
  it('prefers the candidate whose explorer SOL amount matches the XXYY target trade', () => {
    const selected = selectXxyyPoolCandidate(
      [
        {
          address: '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7',
          nativeAmount: '0.041573611',
        },
        {
          address: 'HgRhWnmKZMJqNzjrhTixnJ5CSsM4GYPDjhBVnJd6dgNE',
          nativeAmount: '0.026877674',
        },
      ],
      trade('target', 'target-maker', 'sell', 1000, { nativeAmount: '0.026877674000000000' }),
    );

    expect(selected?.address).toBe('HgRhWnmKZMJqNzjrhTixnJ5CSsM4GYPDjhBVnJd6dgNE');
  });
});

function trade(
  txHash: string,
  maker: string,
  type: 'buy' | 'sell',
  timestamp: number,
  overrides: { nativeAmount?: string } = {},
) {
  return {
    maker,
    nativeAmount: overrides.nativeAmount ?? '0.1',
    priceUsd: '0.0001',
    timestamp,
    tokenAmount: '10',
    txHash,
    type,
    usdAmount: '1',
  };
}
