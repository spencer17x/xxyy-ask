import { describe, expect, it } from 'vitest';

import {
  createBrowserTxAnalysisProvider,
  type BrowserTxAnalysisDriver,
} from './browser-tx-analysis.js';
import { TxAnalysisUnsupportedChainError } from './tx-analysis.js';

const SOLANA_TX =
  '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

describe('createBrowserTxAnalysisProvider', () => {
  it('analyzes a Solana transaction window collected from Solscan and XXYY', async () => {
    const driver: BrowserTxAnalysisDriver = {
      analyzeSolanaTransaction(input) {
        expect(input.txHash).toBe(SOLANA_TX);
        return Promise.resolve({
          contractAddress: 'So11111111111111111111111111111111111111112',
          poolAddress: 'Pool1111111111111111111111111111111111111111',
          program: 'OkxDex: Swap',
          screenshotUrl: '/assets/tx-analysis-solana-window.png',
          solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
          targetTrade: {
            hash: SOLANA_TX,
            side: 'buy',
            summary: 'target buy',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: 'UserTrader11111111111111111111111111111111111',
          },
          transactionTime: '2026-06-10T01:00:05.000Z',
          tradeWindow: {
            after: [
              trade('after-1', 'sell', 'Attacker1111111111111111111111111111111111', 6),
              trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
              trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
              trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
              trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
            ],
            before: [
              trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
              trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
              trade('before-3', 'buy', 'Attacker1111111111111111111111111111111111', 2),
              trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
              trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
            ],
          },
          xxyyPoolUrl: 'https://www.xxyy.io/discover/solana/pool/Pool111',
        });
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({
      chain: 'solana',
      txHash: SOLANA_TX,
    });

    expect(result).toMatchObject({
      chain: 'solana',
      confidence: 0.82,
      contractAddress: 'So11111111111111111111111111111111111111112',
      dataSource: 'browser',
      poolAddress: 'Pool1111111111111111111111111111111111111111',
      screenshotUrl: '/assets/tx-analysis-solana-window.png',
      txHash: SOLANA_TX,
      verdict: 'sandwiched',
    });
    expect(result.summary).toContain('疑似被夹');
    expect(result.summary).toContain('Pool1111111111111111111111111111111111111111');
    expect(result.evidence.map((item) => item.label)).toContain('前后交易窗口');
    expect(result.relatedTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hash: 'before-3', role: 'front_run' }),
        expect.objectContaining({ hash: SOLANA_TX, role: 'user' }),
        expect.objectContaining({ hash: 'after-1', role: 'back_run' }),
      ]),
    );
  });

  it('rejects non-Solana transactions while the browser provider is Solana-only', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('driver should not be called');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'base',
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      }),
    ).rejects.toBeInstanceOf(TxAnalysisUnsupportedChainError);
  });
});

function trade(
  hash: string,
  side: 'buy' | 'sell',
  traderAddress: string,
  secondsAfterStart: number,
) {
  return {
    hash,
    side,
    summary: `${side} ${hash}`,
    timestamp: new Date(Date.UTC(2026, 5, 10, 1, 0, secondsAfterStart)).toISOString(),
    traderAddress,
  };
}
