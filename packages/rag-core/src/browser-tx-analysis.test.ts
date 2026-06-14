import { describe, expect, it } from 'vitest';

import type { TxAnalysisRelatedTransaction } from '@xxyy/shared';

import {
  createBrowserTxAnalysisProvider,
  type BrowserEvmTxSnapshot,
  type BrowserTxChainAdapter,
  type BrowserTxAnalysisDriver,
  createEvmBrowserTxChainAdapter,
} from './browser-tx-analysis.js';
import { SANDWICH_ANALYZER_VERSION } from './sandwich-analyzer.js';
import {
  TxAnalysisProviderUnavailableError,
  TxAnalysisUnsupportedChainError,
} from './tx-analysis.js';

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
          screenshotTargetRowMarked: true,
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
      analysisRuleVersion: SANDWICH_ANALYZER_VERSION,
      chain: 'solana',
      confidence: 0.9,
      contractAddress: 'So11111111111111111111111111111111111111112',
      dataSource: 'browser',
      poolAddress: 'Pool1111111111111111111111111111111111111111',
      screenshotTargetRowMarked: true,
      screenshotUrl: '/assets/tx-analysis-solana-window.png',
      targetTradeSide: 'buy',
      targetTraderAddress: 'UserTrader11111111111111111111111111111111111',
      transactionTime: '2026-06-10T01:00:05.000Z',
      txHash: SOLANA_TX,
      verdict: 'sandwiched',
      xxyyPoolUrl: 'https://www.xxyy.io/discover/solana/pool/Pool111',
    });
    expect(result.summary).toContain('疑似被夹');
    expect(result.summary).toContain('Pool1111111111111111111111111111111111111111');
    expect(result.evidence.map((item) => item.label)).toContain('前后交易窗口');
    expect(result.evidence.map((item) => item.label)).toEqual(
      expect.arrayContaining(['交易窗口覆盖', '判断规则版本', '同一交易者前后腿', '时间窗口']),
    );
    expect(result.evidence).toContainEqual({
      detail: `目标交易 ${SOLANA_TX}；前置交易 before-3；后置交易 after-1。请结合 XXYY 原页面截图中被标记的目标成交行复核。`,
      label: '复核交易哈希',
      severity: 'warning',
    });
    expect(result.evidence.find((item) => item.label === '判断规则版本')?.detail).toContain(
      'sandwich-window-rules-v1',
    );
    expect(result.relatedTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hash: 'before-3', role: 'front_run', side: 'buy' }),
        expect.objectContaining({ hash: SOLANA_TX, role: 'user', side: 'buy' }),
        expect.objectContaining({ hash: 'after-1', role: 'back_run', side: 'sell' }),
      ]),
    );
  });

  it('preserves proof that the returned original screenshot has the target row marked', async () => {
    const driver: BrowserTxAnalysisDriver = {
      analyzeSolanaTransaction() {
        return Promise.resolve({
          contractAddress: 'So11111111111111111111111111111111111111112',
          poolAddress: 'Pool1111111111111111111111111111111111111111',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-solana-window.png',
          solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
          targetTrade: {
            hash: SOLANA_TX,
            side: 'buy',
            summary: 'target buy',
            traderAddress: 'UserTrader11111111111111111111111111111111111',
          },
          tradeWindow: {
            after: [trade('after-1', 'sell', 'OtherAfter1111111111111111111111111111111', 6)],
            before: [trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0)],
          },
        });
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });

    expect(result.screenshotTargetRowMarked).toBe(true);
  });

  it('builds a reviewable XXYY pool URL from the confirmed pool address when the driver omits it', async () => {
    const driver: BrowserTxAnalysisDriver = {
      analyzeSolanaTransaction() {
        return Promise.resolve({
          contractAddress: 'So11111111111111111111111111111111111111112',
          poolAddress: 'Pool1111111111111111111111111111111111111111',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-solana-window.png',
          solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
          targetTrade: {
            hash: SOLANA_TX,
            side: 'buy',
            summary: 'target buy',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: 'UserTrader11111111111111111111111111111111111',
          },
          tradeWindow: {
            after: [
              trade('after-1', 'sell', 'OtherAfter1111111111111111111111111111111', 6),
              trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
              trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
              trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
              trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
            ],
            before: [
              trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
              trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
              trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
              trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
              trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
            ],
          },
        });
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });

    expect(result.xxyyPoolUrl).toBe(
      'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
    );
    expect(result.evidence).toContainEqual({
      detail: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      label: 'XXYY 池子页面',
      severity: 'info',
    });
  });

  it('trims browser-selected target hashes before validation and related explorer links', async () => {
    const driver: BrowserTxAnalysisDriver = {
      analyzeSolanaTransaction() {
        return Promise.resolve({
          contractAddress: 'So11111111111111111111111111111111111111112',
          poolAddress: 'Pool1111111111111111111111111111111111111111',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-solana-window.png',
          solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
          targetTrade: {
            hash: `\n${SOLANA_TX}\t`,
            side: 'buy',
            summary: 'target buy with DOM whitespace',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: 'UserTrader11111111111111111111111111111111111',
          },
          tradeWindow: {
            after: [
              trade('after-1', 'sell', 'OtherAfter1111111111111111111111111111111', 6),
              trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
              trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
              trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
              trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
            ],
            before: [
              trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
              trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
              trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
              trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
              trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
            ],
          },
        });
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });

    expect(result.relatedTransactions).toContainEqual(
      expect.objectContaining({
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        hash: SOLANA_TX,
        role: 'user',
      }),
    );
  });

  it('normalizes browser-selected transaction explorer links before validation and related explorer links', async () => {
    const driver: BrowserTxAnalysisDriver = {
      analyzeSolanaTransaction() {
        return Promise.resolve({
          contractAddress: 'So11111111111111111111111111111111111111112',
          poolAddress: 'Pool1111111111111111111111111111111111111111',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-solana-window.png',
          solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
          targetTrade: {
            hash: `https://solscan.io/tx/${SOLANA_TX}`,
            side: 'buy',
            summary: 'target buy with DOM explorer link',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: 'UserTrader11111111111111111111111111111111111',
          },
          tradeWindow: {
            after: [
              trade('after-1', 'sell', 'OtherAfter1111111111111111111111111111111', 6),
              trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
              trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
              trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
              trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
            ],
            before: [
              trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
              trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
              trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
              trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
              trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
            ],
          },
        });
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });

    expect(result.relatedTransactions).toContainEqual(
      expect.objectContaining({
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        hash: SOLANA_TX,
        role: 'user',
      }),
    );
  });

  it('analyzes a Base transaction window collected from an EVM browser driver', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction(input) {
        expect(input).toEqual({ chain: 'base', txHash: evmTx });
        return Promise.resolve({
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          poolAddress: '0xPool0000000000000000000000000000000000000',
          routerAddress: '0xRouter0000000000000000000000000000000000',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-base-window.png',
          targetTrade: {
            hash: evmTx,
            side: 'buy',
            summary: 'target buy on Base',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: '0xUser0000000000000000000000000000000000000',
          },
          transactionTime: '2026-06-10T01:00:05.000Z',
          tradeWindow: {
            after: [
              trade('0xback', 'sell', '0xAttacker000000000000000000000000000000000', 6),
              trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 7),
              trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 8),
              trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 9),
              trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 10),
            ],
            before: [
              trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0),
              trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 1),
              trade('0xfront', 'buy', '0xAttacker000000000000000000000000000000000', 2),
              trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 3),
              trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 4),
            ],
          },
          xxyyPoolUrl: 'https://www.xxyy.io/base/0xPool0000000000000000000000000000000000000',
        });
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for Base');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result).toMatchObject({
      chain: 'base',
      confidence: 0.9,
      contractAddress: '0xToken000000000000000000000000000000000000',
      dataSource: 'browser',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
      poolAddress: '0xPool0000000000000000000000000000000000000',
      routerAddress: '0xRouter0000000000000000000000000000000000',
      screenshotTargetRowMarked: true,
      screenshotUrl: '/assets/tx-analysis-base-window.png',
      targetTradeSide: 'buy',
      targetTraderAddress: '0xUser0000000000000000000000000000000000000',
      transactionTime: '2026-06-10T01:00:05.000Z',
      txHash: evmTx,
      verdict: 'sandwiched',
      xxyyPoolUrl: 'https://www.xxyy.io/base/0xPool0000000000000000000000000000000000000',
    });
    expect(result.evidence.map((item) => item.label)).toEqual(
      expect.arrayContaining(['EVM 交易浏览器', '交易窗口覆盖', '同一交易者前后腿']),
    );
    expect(result.relatedTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hash: '0xfront', role: 'front_run', side: 'buy' }),
        expect.objectContaining({ hash: evmTx, role: 'user', side: 'buy' }),
        expect.objectContaining({ hash: '0xback', role: 'back_run', side: 'sell' }),
      ]),
    );
  });

  it('normalizes EVM explorer evidence and omits blank router evidence', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const explorerUrl = `https://basescan.org/tx/${evmTx}`;
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction() {
        return Promise.resolve({
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `\n ${explorerUrl} \t`,
          poolAddress: '0xPool0000000000000000000000000000000000000',
          routerAddress: '   ',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-base-window.png',
          targetTrade: {
            hash: evmTx,
            side: 'buy',
            summary: 'target buy on Base',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: '0xUser0000000000000000000000000000000000000',
          },
          tradeWindow: {
            after: [trade('0xback', 'sell', '0xAttacker000000000000000000000000000000000', 6)],
            before: [trade('0xfront', 'buy', '0xAttacker000000000000000000000000000000000', 2)],
          },
        });
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for Base');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.explorerUrl).toBe(explorerUrl);
    expect(result).not.toHaveProperty('routerAddress');
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: explorerUrl,
          label: 'EVM 交易浏览器',
        }),
      ]),
    );
    expect(result.evidence.map((item) => item.label)).not.toContain('EVM Router');
  });

  it('backfills the pool address from a reviewable XXYY pool URL when the browser only parsed the contract', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const poolAddress = '0x1111111111111111111111111111111111111111';
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction() {
        return Promise.resolve({
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-base-window.png',
          targetTrade: {
            hash: evmTx,
            side: 'buy',
            summary: 'target buy on Base',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: '0xUser0000000000000000000000000000000000000',
          },
          tradeWindow: {
            after: [trade('0xback', 'sell', '0xAttacker000000000000000000000000000000000', 6)],
            before: [trade('0xfront', 'buy', '0xAttacker000000000000000000000000000000000', 2)],
          },
          xxyyPoolUrl: `https://www.xxyy.io/base/${poolAddress}`,
        });
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for Base');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.poolAddress).toBe(poolAddress);
    expect(result.summary).toContain(`池子：${poolAddress}`);
    expect(result.xxyyPoolUrl).toBe(`https://www.xxyy.io/base/${poolAddress}`);
  });

  it('rejects malformed direct XXYY pool URLs when the browser only parsed the contract', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-base-window.png',
            targetTrade: {
              hash: evmTx,
              side: 'buy',
              summary: 'target buy with a malformed XXYY pool URL',
              timestamp: '2026-06-10T01:00:05.000Z',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [trade('0xback', 'sell', '0xAttacker000000000000000000000000000000000', 6)],
              before: [trade('0xfront', 'buy', '0xAttacker000000000000000000000000000000000', 2)],
            },
            xxyyPoolUrl: 'https://www.xxyy.io/base/not-a-pool-address',
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Base');
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('pool_not_found');
    expect(providerError.metadata).toMatchObject({
      contractAddress: '0xToken000000000000000000000000000000000000',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
    });
    expect(providerError.metadata).not.toHaveProperty('poolAddress');
    expect(providerError.metadata).not.toHaveProperty('xxyyPoolUrl');
  });

  it('rejects browser snapshots whose XXYY pool URL points to another chain when the browser only parsed the contract', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const poolAddress = '0x1111111111111111111111111111111111111111';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-base-window.png',
            targetTrade: {
              hash: evmTx,
              side: 'buy',
              summary: 'target buy with wrong-chain XXYY pool URL',
              timestamp: '2026-06-10T01:00:05.000Z',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [trade('0xback', 'sell', '0xAttacker000000000000000000000000000000000', 6)],
              before: [trade('0xfront', 'buy', '0xAttacker000000000000000000000000000000000', 2)],
            },
            xxyyPoolUrl: `https://www.xxyy.io/eth/${poolAddress}`,
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Base');
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('pool_not_found');
    expect(providerError.metadata).toMatchObject({
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
    });
    expect(providerError.metadata).not.toHaveProperty('xxyyPoolUrl');
  });

  it('adds explorer links to browser-collected related transactions', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const backTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction() {
        return Promise.resolve({
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          poolAddress: '0xPool0000000000000000000000000000000000000',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-base-window.png',
          targetTrade: {
            hash: evmTx,
            side: 'buy',
            summary: 'target buy on Base',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: '0xUser0000000000000000000000000000000000000',
          },
          tradeWindow: {
            after: [
              trade(backTx, 'sell', '0xAttacker000000000000000000000000000000000', 6),
              trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 7),
              trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 8),
              trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 9),
              trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 10),
            ],
            before: [
              trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0),
              trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 1),
              trade(frontTx, 'buy', '0xAttacker000000000000000000000000000000000', 2),
              trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 3),
              trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 4),
            ],
          },
        });
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for Base');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.relatedTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          explorerUrl: `https://basescan.org/tx/${frontTx}`,
          hash: frontTx,
          role: 'front_run',
        }),
        expect.objectContaining({
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          hash: evmTx,
          role: 'user',
        }),
        expect.objectContaining({
          explorerUrl: `https://basescan.org/tx/${backTx}`,
          hash: backTx,
          role: 'back_run',
        }),
      ]),
    );
  });

  it('trims browser-collected related transaction summaries before returning results', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const snapshot = sandwichedEvmSnapshot(evmTx);
    snapshot.targetTrade = {
      ...snapshot.targetTrade,
      summary: '  target buy summary  ',
    };
    snapshot.tradeWindow.before[0] = {
      ...snapshot.tradeWindow.before[0]!,
      summary: '  front run summary  ',
    };
    snapshot.tradeWindow.after[0] = {
      ...snapshot.tradeWindow.after[0]!,
      summary: '   ',
    };
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction() {
        return Promise.resolve(snapshot);
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for Base');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.relatedTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'front_run',
          summary: 'front run summary',
        }),
        expect.objectContaining({
          role: 'user',
          summary: 'target buy summary',
        }),
        expect.objectContaining({
          role: 'back_run',
          summary: '后置交易',
        }),
      ]),
    );
  });

  it('falls back to browser explorer links when related transaction explorer URLs are blank', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const backTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction() {
        return Promise.resolve({
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          poolAddress: '0xPool0000000000000000000000000000000000000',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-base-window.png',
          targetTrade: {
            hash: evmTx,
            side: 'buy',
            summary: 'target buy on Base',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: '0xUser0000000000000000000000000000000000000',
          },
          tradeWindow: {
            after: [
              {
                ...trade(backTx, 'sell', '0xAttacker000000000000000000000000000000000', 6),
                explorerUrl: '   ',
              },
            ],
            before: [
              {
                ...trade(frontTx, 'buy', '0xAttacker000000000000000000000000000000000', 2),
                explorerUrl: '',
              },
            ],
          },
        });
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for Base');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.relatedTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          explorerUrl: `https://basescan.org/tx/${frontTx}`,
          hash: frontTx,
          role: 'front_run',
        }),
        expect.objectContaining({
          explorerUrl: `https://basescan.org/tx/${backTx}`,
          hash: backTx,
          role: 'back_run',
        }),
      ]),
    );
  });

  it('replaces mismatched related transaction explorer URLs with links for their own hashes', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const backTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const wrongTx = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction() {
        return Promise.resolve({
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          poolAddress: '0xPool0000000000000000000000000000000000000',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-base-window.png',
          targetTrade: {
            hash: evmTx,
            side: 'buy',
            summary: 'target buy on Base',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: '0xUser0000000000000000000000000000000000000',
          },
          tradeWindow: {
            after: [
              {
                ...trade(backTx, 'sell', '0xAttacker000000000000000000000000000000000', 6),
                explorerUrl: `https://basescan.org/tx/${wrongTx}`,
              },
            ],
            before: [
              {
                ...trade(frontTx, 'buy', '0xAttacker000000000000000000000000000000000', 2),
                explorerUrl: `https://etherscan.io/tx/${frontTx}`,
              },
            ],
          },
        });
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for Base');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.relatedTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          explorerUrl: `https://basescan.org/tx/${frontTx}`,
          hash: frontTx,
          role: 'front_run',
        }),
        expect.objectContaining({
          explorerUrl: `https://basescan.org/tx/${backTx}`,
          hash: backTx,
          role: 'back_run',
        }),
      ]),
    );
  });

  it('adds explorer links to EVM related transactions when attacker leg hashes use an uppercase hex prefix', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontTx = '0Xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const backTx = '0Xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction() {
        return Promise.resolve({
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          poolAddress: '0xPool0000000000000000000000000000000000000',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-base-window.png',
          targetTrade: {
            hash: evmTx,
            side: 'buy',
            summary: 'target buy on Base',
            timestamp: '2026-06-10T01:00:05.000Z',
            traderAddress: '0xUser0000000000000000000000000000000000000',
          },
          tradeWindow: {
            after: [trade(backTx, 'sell', '0xAttacker000000000000000000000000000000000', 6)],
            before: [trade(frontTx, 'buy', '0xAttacker000000000000000000000000000000000', 4)],
          },
        });
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for Base');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.relatedTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          explorerUrl: `https://basescan.org/tx/${frontTx}`,
          hash: frontTx,
          role: 'front_run',
        }),
        expect.objectContaining({
          explorerUrl: `https://basescan.org/tx/${backTx}`,
          hash: backTx,
          role: 'back_run',
        }),
      ]),
    );
  });

  it('uses the XXYY target trade timestamp as the transaction time when explorer time is missing', async () => {
    const evmTx = '0xc234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const targetTimestamp = '2026-06-10T01:00:05.000Z';
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction() {
        return Promise.resolve({
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          poolAddress: '0xPool0000000000000000000000000000000000000',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-base-window.png',
          targetTrade: {
            hash: evmTx,
            side: 'buy',
            summary: 'target buy on Base',
            timestamp: targetTimestamp,
            traderAddress: '0xUser0000000000000000000000000000000000000',
          },
          tradeWindow: {
            after: [trade('0xafter1', 'sell', '0xOtherAfter1000000000000000000000000000', 6)],
            before: [trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0)],
          },
        });
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for Base');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.transactionTime).toBe(targetTimestamp);
    expect(result.summary).toContain(`交易时间：${targetTimestamp}`);
  });

  it('probes unknown EVM transaction hashes when the hex prefix casing is uppercase', async () => {
    const evmTx = '0X1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction(input) {
        expect(input).toEqual({ chain: 'base', txHash: evmTx });
        return Promise.resolve(sandwichedEvmSnapshot(evmTx));
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for an EVM hash');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'unknown', txHash: evmTx });

    expect(result.chain).toBe('base');
    expect(result.txHash).toBe(evmTx);
    expect(result.relatedTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          hash: evmTx,
          role: 'user',
        }),
      ]),
    );
  });

  it('does not report browser-collected attacker legs from another pool as sandwiched', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driver: BrowserTxAnalysisDriver = {
      analyzeEvmTransaction() {
        return Promise.resolve({
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          poolAddress: '0xPoolA00000000000000000000000000000000000',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/assets/tx-analysis-base-window.png',
          targetTrade: tradeInPool(
            evmTx,
            'buy',
            '0xUser0000000000000000000000000000000000000',
            5,
            '0xPoolA00000000000000000000000000000000000',
          ),
          tradeWindow: {
            after: [
              tradeInPool(
                '0xback-other-pool',
                'sell',
                '0xAttacker000000000000000000000000000000000',
                6,
                '0xPoolB00000000000000000000000000000000000',
              ),
              tradeInPool(
                '0xafter2',
                'buy',
                '0xOtherAfter20000000000000000000000000000',
                7,
                '0xPoolA00000000000000000000000000000000000',
              ),
              tradeInPool(
                '0xafter3',
                'sell',
                '0xOtherAfter3000000000000000000000000000',
                8,
                '0xPoolA00000000000000000000000000000000000',
              ),
              tradeInPool(
                '0xafter4',
                'buy',
                '0xOtherAfter40000000000000000000000000000',
                9,
                '0xPoolA00000000000000000000000000000000000',
              ),
              tradeInPool(
                '0xafter5',
                'sell',
                '0xOtherAfter5000000000000000000000000000',
                10,
                '0xPoolA00000000000000000000000000000000000',
              ),
            ],
            before: [
              tradeInPool(
                '0xfront-other-pool',
                'buy',
                '0xAttacker000000000000000000000000000000000',
                2,
                '0xPoolB00000000000000000000000000000000000',
              ),
              tradeInPool(
                '0xbefore2',
                'sell',
                '0xOtherBefore200000000000000000000000000',
                1,
                '0xPoolA00000000000000000000000000000000000',
              ),
              tradeInPool(
                '0xbefore3',
                'buy',
                '0xOtherBefore3000000000000000000000000000',
                2,
                '0xPoolA00000000000000000000000000000000000',
              ),
              tradeInPool(
                '0xbefore4',
                'sell',
                '0xOtherBefore400000000000000000000000000',
                3,
                '0xPoolA00000000000000000000000000000000000',
              ),
              tradeInPool(
                '0xbefore5',
                'buy',
                '0xOtherBefore5000000000000000000000000000',
                4,
                '0xPoolA00000000000000000000000000000000000',
              ),
            ],
          },
          xxyyPoolUrl: 'https://www.xxyy.io/base/0xpoola00000000000000000000000000000000000',
        });
      },
      analyzeSolanaTransaction() {
        throw new Error('Solana driver should not be called for Base');
      },
    };
    const provider = createBrowserTxAnalysisProvider({ driver });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.verdict).toBe('not_sandwiched');
    expect(result.relatedTransactions.map(({ hash, role }) => ({ hash, role }))).toEqual([
      { hash: '0xfront-other-pool', role: 'related' },
      { hash: '0xbefore2', role: 'related' },
      { hash: '0xbefore3', role: 'related' },
      { hash: '0xbefore4', role: 'related' },
      { hash: '0xbefore5', role: 'related' },
      { hash: evmTx, role: 'user' },
      { hash: '0xback-other-pool', role: 'related' },
      { hash: '0xafter2', role: 'related' },
      { hash: '0xafter3', role: 'related' },
      { hash: '0xafter4', role: 'related' },
      { hash: '0xafter5', role: 'related' },
    ]);
    expect(result.evidence).toContainEqual({
      detail:
        '发现同一交易者前后腿候选，但候选交易不在目标交易同一池子/交易对内，不计为典型 sandwich。',
      label: '池子一致性',
      severity: 'info',
    });
  });

  it('supports Base, Ethereum, and BSC in the generic EVM browser adapter', () => {
    const adapter = createEvmBrowserTxChainAdapter({
      analyzeEvmTransaction() {
        throw new Error('driver should not be called by supports');
      },
    });

    expect(adapter.supports({ chain: 'base', txHash: '0x1' })).toBe(true);
    expect(adapter.supports({ chain: 'ethereum', txHash: '0x1' })).toBe(true);
    expect(adapter.supports({ chain: 'bsc', txHash: '0x1' })).toBe(true);
    expect(adapter.supports({ chain: 'solana', txHash: SOLANA_TX })).toBe(false);
    expect(adapter.supports({ chain: 'unknown', txHash: '0x1' })).toBe(false);
  });

  it('discovers the concrete chain for an unknown EVM transaction hash', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const attemptedChains: string[] = [];
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction(input) {
          attemptedChains.push(input.chain);
          if (input.chain !== 'ethereum') {
            throw new TxAnalysisProviderUnavailableError(
              `${input.chain} explorer did not contain this transaction`,
              'tx_not_found',
            );
          }

          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://etherscan.io/tx/${evmTx}`,
            poolAddress: '0xPool0000000000000000000000000000000000000',
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-ethereum-window.png',
            targetTrade: {
              hash: evmTx,
              side: 'buy',
              summary: 'target buy on Ethereum',
              timestamp: '2026-06-10T01:00:05.000Z',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [
                trade('0xafter1', 'sell', '0xOtherAfter1000000000000000000000000000', 6),
                trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 7),
                trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 8),
                trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 9),
                trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 10),
              ],
              before: [
                trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0),
                trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 1),
                trade('0xbefore3', 'buy', '0xOtherBefore3000000000000000000000000000', 2),
                trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 3),
                trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 4),
              ],
            },
            xxyyPoolUrl: 'https://www.xxyy.io/eth/0xPool0000000000000000000000000000000000000',
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for an EVM hash');
        },
      },
    });

    const result = await provider.analyze({ chain: 'unknown', txHash: evmTx });

    expect(attemptedChains).toEqual(['base', 'ethereum']);
    expect(result).toMatchObject({
      chain: 'ethereum',
      explorerUrl: `https://etherscan.io/tx/${evmTx}`,
      poolAddress: '0xPool0000000000000000000000000000000000000',
      txHash: evmTx,
    });
  });

  it('continues unknown EVM chain discovery when an earlier explorer requires browser verification', async () => {
    const evmTx = '0x7234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const attemptedChains: string[] = [];
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction(input) {
          attemptedChains.push(input.chain);
          if (input.chain === 'base') {
            throw new TxAnalysisProviderUnavailableError(
              'BaseScan requires browser verification',
              'browser_verification_required',
            );
          }

          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://etherscan.io/tx/${evmTx}`,
            poolAddress: '0xPool0000000000000000000000000000000000000',
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-ethereum-window.png',
            targetTrade: {
              hash: evmTx,
              side: 'buy',
              summary: 'target buy on Ethereum',
              timestamp: '2026-06-10T01:00:05.000Z',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [
                trade('0xafter1', 'sell', '0xOtherAfter1000000000000000000000000000', 6),
                trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 7),
                trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 8),
                trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 9),
                trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 10),
              ],
              before: [
                trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0),
                trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 1),
                trade('0xbefore3', 'buy', '0xOtherBefore3000000000000000000000000000', 2),
                trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 3),
                trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 4),
              ],
            },
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for an EVM hash');
        },
      },
    });

    const result = await provider.analyze({ chain: 'unknown', txHash: evmTx });

    expect(attemptedChains).toEqual(['base', 'ethereum']);
    expect(result).toMatchObject({
      chain: 'ethereum',
      explorerUrl: `https://etherscan.io/tx/${evmTx}`,
      txHash: evmTx,
    });
  });

  it('prefers actionable verification failures over earlier transient unknown EVM probe failures', async () => {
    const evmTx = '0x8234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const attemptedChains: string[] = [];
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction(input) {
          attemptedChains.push(input.chain);
          if (input.chain === 'base') {
            throw new Error('net::ERR_CONNECTION_RESET while opening BaseScan');
          }
          if (input.chain === 'ethereum') {
            throw new TxAnalysisProviderUnavailableError(
              'Etherscan requires browser verification',
              'browser_verification_required',
            );
          }

          throw new TxAnalysisProviderUnavailableError('not found on BSC', 'tx_not_found');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for an EVM hash');
        },
      },
    });

    await expect(provider.analyze({ chain: 'unknown', txHash: evmTx })).rejects.toMatchObject({
      reason: 'browser_verification_required',
      reference: { chain: 'ethereum', txHash: evmTx },
    });
    expect(attemptedChains).toEqual(['base', 'ethereum', 'bsc']);
  });

  it('persists unknown EVM probe attempts when every public explorer probe fails', async () => {
    const evmTx = '0x9234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const failureWrites: Array<{
      metadata?: { relatedTransactions?: TxAnalysisRelatedTransaction[] };
      reason: string;
      reference: { chain: string; txHash: string };
    }> = [];
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction(input) {
          if (input.chain === 'base') {
            throw new TxAnalysisProviderUnavailableError(
              'BaseScan HTTP 503 Service Unavailable',
              'provider_unavailable',
            );
          }
          if (input.chain === 'ethereum') {
            throw new TxAnalysisProviderUnavailableError(
              'Etherscan requires browser verification',
              'browser_verification_required',
            );
          }

          throw new TxAnalysisProviderUnavailableError('not found on BSC', 'tx_not_found');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for an EVM hash');
        },
      },
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-ethereum.json' });
        },
      },
    });

    await expect(provider.analyze({ chain: 'unknown', txHash: evmTx })).rejects.toMatchObject({
      reason: 'browser_verification_required',
      reportUrl: '/assets/tx-analysis-failure-ethereum.json',
      reference: { chain: 'ethereum', txHash: evmTx },
    });
    expect(failureWrites).toEqual([
      {
        message: 'Etherscan requires browser verification',
        metadata: {
          probeAttempts: [
            {
              chain: 'base',
              message: 'BaseScan HTTP 503 Service Unavailable',
              reason: 'provider_unavailable',
            },
            {
              chain: 'ethereum',
              message: 'Etherscan requires browser verification',
              reason: 'browser_verification_required',
            },
            {
              chain: 'bsc',
              message: 'not found on BSC',
              reason: 'tx_not_found',
            },
          ],
        },
        reason: 'browser_verification_required',
        reference: { chain: 'ethereum', txHash: evmTx },
      },
    ]);
  });

  it('routes non-Solana transactions to a matching browser chain adapter', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const adapter: BrowserTxChainAdapter = {
      analyze(reference) {
        expect(reference).toEqual({ chain: 'base', txHash: evmTx });
        return Promise.resolve({
          analyzedAt: '2026-06-11T00:00:00.000Z',
          chain: 'base',
          confidence: 0.41,
          dataSource: 'browser',
          evidence: [],
          relatedTransactions: [
            {
              hash: evmTx,
              role: 'user',
              summary: 'Base user transaction',
            },
          ],
          summary: 'Base browser adapter result',
          txHash: evmTx,
          verdict: 'inconclusive',
        });
      },
      supports(reference) {
        return reference.chain === 'base';
      },
    };
    const provider = createBrowserTxAnalysisProvider({
      adapters: [adapter],
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: evmTx,
    });

    expect(result).toMatchObject({
      chain: 'base',
      dataSource: 'browser',
      txHash: evmTx,
    });
  });

  it('rejects chains without a matching browser adapter', async () => {
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

  it('classifies browser timeout errors with a timeout unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Timeout 60000ms exceeded while waiting for page');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'timeout',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies Chrome net::ERR_TIMED_OUT failures with a timeout unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('page.goto: net::ERR_TIMED_OUT at https://solscan.io/tx/example');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'timeout',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies low-level ETIMEDOUT browser errors with a timeout unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('connect ETIMEDOUT 104.18.12.34:443 while loading XXYY pool page');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'timeout',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw browser security verification errors with a verification unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Attention Required! Cloudflare browser verification is required');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw connection security check errors with a verification unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error(
            'Checking if the site connection is secure before proceeding with Solscan',
          );
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw not-a-robot verification errors with a verification unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Please verify you are not a robot before continuing');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw human verification errors with a verification unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Please verify you are human before continuing');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw JavaScript and cookie verification errors with a verification unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Please enable JavaScript and cookies to continue');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('keeps verification actionable when a raw browser error also mentions a temporary 5xx', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error(
            'HTTP 503 Service Unavailable. Attention Required! Cloudflare browser verification is required',
          );
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('keeps verification actionable when a raw browser timeout includes challenge markup', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Timeout 30000ms exceeded while waiting for cf-turnstile-response');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw transaction-not-found browser errors with a not found unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Transaction not found on explorer page');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw Solana signature-not-found browser errors with a not found unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Solscan says signature not found');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw unable-to-locate Solana signature browser errors with a not found unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Solana Explorer says unable to locate this signature');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw Solana signature-could-not-be-found browser errors with a not found unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Solana Explorer says this signature could not be found');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw no-transaction-found browser errors with a not found unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Solscan says no transaction found for this signature');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw unable-to-locate transaction hash browser errors with a not found unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('Etherscan says Sorry, we are unable to locate this TxnHash');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Ethereum');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'ethereum',
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw transaction-does-not-exist browser errors with a not found unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('BaseScan shows this transaction hash does not exist');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Base');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'base',
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw transaction-hash-cannot-be-found browser errors with a not found unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('Etherscan shows this transaction hash cannot be found');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Ethereum');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'ethereum',
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw could-not-locate transaction hash browser errors with a not found unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('BaseScan says could not locate this TxnHash');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Base');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'base',
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw failed transaction browser errors with a tx_failed unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Transaction status: failed with error execution reverted');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('keeps failed transaction root cause when browser error text also contains transient noise', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Transaction Reverted while protocol error occurred after page parsing');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw numeric failed status browser errors with a tx_failed unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('EVM explorer showed Status: 0x0 for this transaction');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw Solana Err status browser errors with a tx_failed unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Solscan showed Status: Err for this transaction');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw Solana result error browser errors with a tx_failed unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Solscan showed Result: Error for this transaction');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw success false browser errors with a tx_failed unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('EVM explorer showed Success: false for this transaction');
        },
        analyzeSolanaTransaction() {
          throw new Error('not used');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'base',
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw contract execution browser errors with a tx_failed unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Error encountered during contract execution [out of gas]');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw compact Solana InstructionError browser errors with a tx_failed unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Solana Explorer rendered InstructionError for this transaction');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw numbered Solana instruction failure browser errors with a tx_failed unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Solscan rendered Instruction #3 Failed while executing swap');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw EVM has-been-reverted browser errors with a tx_failed unavailable reason', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('This transaction has been reverted.');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Base');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'base',
        txHash: evmTx,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw EVM Transaction Reverted browser errors with a tx_failed unavailable reason', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('Etherscan page showed Transaction Reverted');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Ethereum');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'ethereum',
        txHash: evmTx,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw EVM Status Reverted browser errors with a tx_failed unavailable reason', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('BscScan receipt rendered Status: Reverted');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for BSC');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'bsc',
        txHash: evmTx,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw EVM transaction receipt error status browser errors with a tx_failed unavailable reason', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('Etherscan receipt rendered Transaction Receipt Status: Error');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Ethereum');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'ethereum',
        txHash: evmTx,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw EVM unsuccessful receipt status browser errors with a tx_failed unavailable reason', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('Etherscan receipt rendered Transaction Receipt Status: Unsuccessful');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Ethereum');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'ethereum',
        txHash: evmTx,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw EVM pending receipt status browser errors with a tx_pending unavailable reason', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('Etherscan receipt rendered Transaction Receipt Status: Pending');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Ethereum');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'ethereum',
        txHash: evmTx,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw pending transaction browser errors with a tx_pending unavailable reason', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('Etherscan rendered Pending Transaction for this hash');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Ethereum');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'ethereum',
        txHash: evmTx,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw pending Solana signature browser errors with a tx_pending unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Solana Explorer says Signature is not finalized yet');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw processing Solana signature browser errors with a tx_pending unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Solscan says processing signature for this transaction');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw mempool browser errors with a tx_pending unavailable reason', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          throw new Error('Etherscan rendered transaction is in the mempool and not yet mined');
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Ethereum');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'ethereum',
        txHash: evmTx,
      }),
    ).rejects.toMatchObject({
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw target-trade lookup browser errors with a target trade unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Target trade not found in XXYY transaction list');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'target_trade_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw XXYY pool lookup browser errors with a pool unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('XXYY pool not found for this transaction contract');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'pool_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('classifies raw screenshot capture browser errors with a screenshot unavailable reason', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          throw new Error('Unable to mark target transaction row in XXYY original trade list');
        },
      },
    });

    await expect(
      provider.analyze({
        chain: 'solana',
        txHash: SOLANA_TX,
      }),
    ).rejects.toMatchObject({
      reason: 'screenshot_unavailable',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('requires browser driver results to include an original page screenshot', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          return Promise.resolve({
            contractAddress: 'So11111111111111111111111111111111111111112',
            poolAddress: 'Pool1111111111111111111111111111111111111111',
            solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            targetTrade: {
              hash: SOLANA_TX,
              side: 'buy',
              summary: 'target buy without screenshot',
              traderAddress: 'UserTrader11111111111111111111111111111111111',
            },
            tradeWindow: {
              after: [
                trade('after-1', 'sell', 'OtherAfter111111111111111111111111111111', 6),
                trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
                trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
                trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
                trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
              ],
              before: [
                trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
                trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
                trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
                trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
                trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
              ],
            },
            xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
          });
        },
      },
    });

    await expect(provider.analyze({ chain: 'solana', txHash: SOLANA_TX })).rejects.toMatchObject({
      reason: 'screenshot_unavailable',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it.each([undefined, false])(
    'requires browser driver screenshots to mark the target transaction row',
    async (screenshotTargetRowMarked) => {
      const provider = createBrowserTxAnalysisProvider({
        driver: {
          analyzeSolanaTransaction() {
            return Promise.resolve({
              contractAddress: 'So11111111111111111111111111111111111111112',
              poolAddress: 'Pool1111111111111111111111111111111111111111',
              ...(screenshotTargetRowMarked === undefined ? {} : { screenshotTargetRowMarked }),
              screenshotUrl: '/assets/tx-analysis-solana-window.png',
              solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
              targetTrade: {
                hash: SOLANA_TX,
                side: 'buy',
                summary: 'target buy with unmarked screenshot',
                traderAddress: 'UserTrader11111111111111111111111111111111111',
              },
              tradeWindow: {
                after: [
                  trade('after-1', 'sell', 'OtherAfter111111111111111111111111111111', 6),
                  trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
                  trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
                  trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
                  trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
                ],
                before: [
                  trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
                  trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
                  trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
                  trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
                  trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
                ],
              },
              xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
            });
          },
        },
      });

      await expect(provider.analyze({ chain: 'solana', txHash: SOLANA_TX })).rejects.toMatchObject({
        reason: 'screenshot_unavailable',
      } satisfies Partial<TxAnalysisProviderUnavailableError>);
    },
  );

  it('preserves the located trade window in failure metadata when the original screenshot is missing', async () => {
    const beforeHash = 'A'.repeat(64);
    const afterHash = 'B'.repeat(64);
    const beforeTimestamp = '2026-06-10T01:00:04.000Z';
    const targetTimestamp = '2026-06-10T01:00:05.000Z';
    const afterTimestamp = '2026-06-10T01:00:06.000Z';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          return Promise.resolve({
            contractAddress: 'So11111111111111111111111111111111111111112',
            poolAddress: 'Pool1111111111111111111111111111111111111111',
            solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            targetTrade: {
              hash: SOLANA_TX,
              side: 'buy',
              summary: 'target buy without screenshot',
              timestamp: targetTimestamp,
              traderAddress: 'UserTrader11111111111111111111111111111111111',
            },
            tradeWindow: {
              after: [
                {
                  hash: afterHash,
                  side: 'sell',
                  summary: 'after sell context',
                  timestamp: afterTimestamp,
                  traderAddress: 'AfterTrader111111111111111111111111111111',
                },
              ],
              before: [
                {
                  hash: beforeHash,
                  side: 'buy',
                  summary: 'before buy context',
                  timestamp: beforeTimestamp,
                  traderAddress: 'BeforeTrader11111111111111111111111111111',
                },
              ],
            },
            xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
          });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('screenshot_unavailable');
    expect(providerError.metadata?.relatedTransactions).toEqual([
      {
        explorerUrl: `https://solscan.io/tx/${beforeHash}`,
        hash: beforeHash,
        role: 'related',
        side: 'buy',
        summary: 'before buy context',
        timestamp: beforeTimestamp,
        traderAddress: 'BeforeTrader11111111111111111111111111111',
      },
      {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        hash: SOLANA_TX,
        role: 'user',
        side: 'buy',
        summary: 'target buy without screenshot',
        timestamp: targetTimestamp,
        traderAddress: 'UserTrader11111111111111111111111111111111111',
      },
      {
        explorerUrl: `https://solscan.io/tx/${afterHash}`,
        hash: afterHash,
        role: 'related',
        side: 'sell',
        summary: 'after sell context',
        timestamp: afterTimestamp,
        traderAddress: 'AfterTrader111111111111111111111111111111',
      },
    ]);
  });

  it.each(['', '   '])(
    'rejects browser driver snapshots with a blank original page screenshot URL',
    async (screenshotUrl) => {
      const provider = createBrowserTxAnalysisProvider({
        driver: {
          analyzeSolanaTransaction() {
            return Promise.resolve({
              contractAddress: 'So11111111111111111111111111111111111111112',
              poolAddress: 'Pool1111111111111111111111111111111111111111',
              screenshotUrl,
              solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
              targetTrade: {
                hash: SOLANA_TX,
                side: 'buy',
                summary: 'target buy with blank screenshot URL',
                traderAddress: 'UserTrader11111111111111111111111111111111111',
              },
              tradeWindow: {
                after: [
                  trade('after-1', 'sell', 'OtherAfter111111111111111111111111111111', 6),
                  trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
                  trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
                  trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
                  trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
                ],
                before: [
                  trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
                  trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
                  trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
                  trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
                  trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
                ],
              },
              xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
            });
          },
        },
      });

      await expect(provider.analyze({ chain: 'solana', txHash: SOLANA_TX })).rejects.toMatchObject({
        reason: 'screenshot_unavailable',
      } satisfies Partial<TxAnalysisProviderUnavailableError>);
    },
  );

  it.each(['', '   '])(
    'rejects browser driver snapshots with a blank transaction explorer URL',
    async (solscanUrl) => {
      const provider = createBrowserTxAnalysisProvider({
        driver: {
          analyzeSolanaTransaction() {
            return Promise.resolve({
              contractAddress: 'So11111111111111111111111111111111111111112',
              poolAddress: 'Pool1111111111111111111111111111111111111111',
              screenshotTargetRowMarked: true,
              screenshotUrl: '/assets/tx-analysis-solana-window.png',
              solscanUrl,
              targetTrade: {
                hash: SOLANA_TX,
                side: 'buy',
                summary: 'target buy without source explorer URL',
                traderAddress: 'UserTrader11111111111111111111111111111111111',
              },
              tradeWindow: {
                after: [
                  trade('after-1', 'sell', 'OtherAfter111111111111111111111111111111', 6),
                  trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
                  trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
                  trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
                  trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
                ],
                before: [
                  trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
                  trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
                  trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
                  trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
                  trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
                ],
              },
              xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
            });
          },
        },
      });

      let caughtError: unknown;
      try {
        await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
      const providerError = caughtError as TxAnalysisProviderUnavailableError;
      expect(providerError.reason).toBe('provider_unavailable');
      expect(providerError.metadata).not.toHaveProperty('explorerUrl');
    },
  );

  it.each(['', '   '])(
    'falls back to a reviewable XXYY pool URL when the browser returns a blank pool URL',
    async (xxyyPoolUrl) => {
      const provider = createBrowserTxAnalysisProvider({
        driver: {
          analyzeSolanaTransaction() {
            return Promise.resolve({
              contractAddress: 'So11111111111111111111111111111111111111112',
              poolAddress: 'Pool1111111111111111111111111111111111111111',
              screenshotTargetRowMarked: true,
              screenshotUrl: '/assets/tx-analysis-solana-window.png',
              solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
              targetTrade: {
                hash: SOLANA_TX,
                side: 'buy',
                summary: 'target buy with blank XXYY pool URL',
                traderAddress: 'UserTrader11111111111111111111111111111111111',
              },
              tradeWindow: {
                after: [
                  trade('after-1', 'sell', 'OtherAfter111111111111111111111111111111', 6),
                  trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
                  trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
                  trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
                  trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
                ],
                before: [
                  trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
                  trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
                  trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
                  trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
                  trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
                ],
              },
              xxyyPoolUrl,
            });
          },
        },
      });

      const result = await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });

      expect(result.xxyyPoolUrl).toBe(
        'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      );
      expect(result.evidence).toContainEqual({
        detail: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
        label: 'XXYY 池子页面',
        severity: 'info',
      });
    },
  );

  it('falls back to a reviewable XXYY pool URL when the browser returns a non-XXYY pool URL', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          return Promise.resolve({
            contractAddress: 'So11111111111111111111111111111111111111112',
            poolAddress: 'Pool1111111111111111111111111111111111111111',
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-solana-window.png',
            solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            targetTrade: {
              hash: SOLANA_TX,
              side: 'buy',
              summary: 'target buy with non-XXYY pool URL',
              traderAddress: 'UserTrader11111111111111111111111111111111111',
            },
            tradeWindow: {
              after: [
                trade('after-1', 'sell', 'OtherAfter111111111111111111111111111111', 6),
                trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
                trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
                trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
                trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
              ],
              before: [
                trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
                trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
                trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
                trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
                trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
              ],
            },
            xxyyPoolUrl:
              'https://example.com/not-xxyy/pool/Pool1111111111111111111111111111111111111111',
          });
        },
      },
    });

    const result = await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });

    expect(result.xxyyPoolUrl).toBe(
      'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
    );
    expect(result.evidence).toContainEqual({
      detail: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      label: 'XXYY 池子页面',
      severity: 'info',
    });
  });

  it('rejects EVM browser snapshots whose direct XXYY pool URL points to another pool address', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const poolAddress = '0x1111111111111111111111111111111111111111';
    const otherPoolAddress = '0x2222222222222222222222222222222222222222';
    const snapshot = sandwichedEvmSnapshot(evmTx);
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            ...snapshot,
            poolAddress,
            targetTrade: { ...snapshot.targetTrade, poolAddress },
            xxyyPoolUrl: `https://www.xxyy.io/base/${otherPoolAddress}`,
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Base');
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('pool_not_found');
    expect(providerError.metadata).toMatchObject({
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
      poolAddress,
    });
    expect(providerError.metadata).not.toHaveProperty('xxyyPoolUrl');
  });

  it('rejects Solana browser snapshots whose Discover pool URL points to another complete pool address', async () => {
    const poolAddress = '11111111111111111111111111111111';
    const otherPoolAddress = '22222222222222222222222222222222';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          return Promise.resolve({
            contractAddress: 'So11111111111111111111111111111111111111112',
            poolAddress,
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-solana-window.png',
            solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            targetTrade: {
              hash: SOLANA_TX,
              poolAddress,
              side: 'buy',
              summary: 'target buy with mismatched Discover pool URL',
              traderAddress: 'UserTrader11111111111111111111111111111111111',
            },
            tradeWindow: {
              after: [
                trade('after-1', 'sell', 'OtherAfter111111111111111111111111111111', 6),
                trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
                trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
                trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
                trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
              ],
              before: [
                trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
                trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
                trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
                trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
                trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
              ],
            },
            xxyyPoolUrl: `https://www.xxyy.io/discover/solana/pool/${otherPoolAddress}`,
          });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('pool_not_found');
    expect(providerError.metadata).toMatchObject({
      explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
      poolAddress,
    });
    expect(providerError.metadata).not.toHaveProperty('xxyyPoolUrl');
  });

  it('rejects EVM browser snapshots whose transaction explorer URL points to another transaction', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const snapshot = sandwichedEvmSnapshot(evmTx);
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            ...snapshot,
            explorerUrl: `https://basescan.org/tx/${otherTxHash}`,
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Base');
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('tx_not_found');
    expect(providerError.metadata).not.toHaveProperty('explorerUrl');
  });

  it('rejects EVM browser snapshots whose transaction explorer URL points to another chain', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const snapshot = sandwichedEvmSnapshot(evmTx);
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            ...snapshot,
            explorerUrl: `https://etherscan.io/tx/${evmTx}`,
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Base');
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('tx_not_found');
    expect(providerError.metadata).not.toHaveProperty('explorerUrl');
  });

  it('rejects browser driver snapshots without a reviewable XXYY pool URL', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          return Promise.resolve({
            contractAddress: 'So11111111111111111111111111111111111111112',
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-solana-window.png',
            solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            targetTrade: {
              hash: SOLANA_TX,
              side: 'buy',
              summary: 'target buy with no reviewable XXYY pool URL',
              traderAddress: 'UserTrader11111111111111111111111111111111111',
            },
            tradeWindow: {
              after: [
                trade('after-1', 'sell', 'OtherAfter111111111111111111111111111111', 6),
                trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
                trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
                trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
                trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
              ],
              before: [
                trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
                trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
                trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
                trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
                trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
              ],
            },
          });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('pool_not_found');
    expect(providerError.metadata).toMatchObject({
      contractAddress: 'So11111111111111111111111111111111111111112',
      explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
      screenshotTargetRowMarked: true,
      screenshotUrl: '/assets/tx-analysis-solana-window.png',
    });
    expect(providerError.metadata).not.toHaveProperty('poolAddress');
    expect(providerError.metadata).not.toHaveProperty('xxyyPoolUrl');
  });

  it('rejects browser driver snapshots whose pool and contract addresses are blank', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          return Promise.resolve({
            contractAddress: '   ',
            poolAddress: '',
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-solana-window.png',
            solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            targetTrade: {
              hash: SOLANA_TX,
              side: 'buy',
              summary: 'target buy with blank pool and contract',
              traderAddress: 'UserTrader11111111111111111111111111111111111',
            },
            tradeWindow: {
              after: [
                trade('after-1', 'sell', 'OtherAfter111111111111111111111111111111', 6),
                trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
                trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
                trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
                trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
              ],
              before: [
                trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
                trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
                trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
                trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
                trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
              ],
            },
            xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
          });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'solana', txHash: SOLANA_TX });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('pool_not_found');
    expect(providerError.metadata).not.toHaveProperty('contractAddress');
    expect(providerError.metadata).not.toHaveProperty('poolAddress');
  });

  it('rejects browser driver snapshots whose target trade hash does not match the requested hash', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          return Promise.resolve({
            contractAddress: 'So11111111111111111111111111111111111111112',
            poolAddress: 'Pool1111111111111111111111111111111111111111',
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-solana-window.png',
            solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            targetTrade: {
              hash: 'different-visible-row',
              side: 'buy',
              summary: 'a different row was selected',
              traderAddress: 'UserTrader11111111111111111111111111111111111',
            },
            tradeWindow: {
              after: [
                trade('after-1', 'sell', 'OtherAfter111111111111111111111111111111', 6),
                trade('after-2', 'buy', 'OtherAfter2222222222222222222222222222222', 7),
                trade('after-3', 'sell', 'OtherAfter333333333333333333333333333333', 8),
                trade('after-4', 'buy', 'OtherAfter4444444444444444444444444444444', 9),
                trade('after-5', 'sell', 'OtherAfter555555555555555555555555555555', 10),
              ],
              before: [
                trade('before-1', 'buy', 'OtherBefore111111111111111111111111111111', 0),
                trade('before-2', 'sell', 'OtherBefore22222222222222222222222222222', 1),
                trade('before-3', 'buy', 'OtherBefore33333333333333333333333333333', 2),
                trade('before-4', 'sell', 'OtherBefore44444444444444444444444444444', 3),
                trade('before-5', 'buy', 'OtherBefore555555555555555555555555555555', 4),
              ],
            },
            xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
          });
        },
      },
    });

    await expect(provider.analyze({ chain: 'solana', txHash: SOLANA_TX })).rejects.toMatchObject({
      reason: 'target_trade_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('omits wrong-chain XXYY pool URLs from early failure metadata', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const poolAddress = '0x1111111111111111111111111111111111111111';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-base-window.png',
            targetTrade: {
              hash: '0xdifferent0000000000000000000000000000000000000000000000000000000',
              side: 'buy',
              summary: 'a different Base row was selected',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [trade('0xafter1', 'sell', '0xOtherAfter1000000000000000000000000000', 6)],
              before: [trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0)],
            },
            xxyyPoolUrl: `https://www.xxyy.io/eth/${poolAddress}`,
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Base');
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('target_trade_not_found');
    expect(providerError.metadata).toMatchObject({
      contractAddress: '0xToken000000000000000000000000000000000000',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
    });
    expect(providerError.metadata).not.toHaveProperty('xxyyPoolUrl');
  });

  it('omits malformed Discover XXYY pool URLs from early failure metadata', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-base-window.png',
            targetTrade: {
              hash: '0xdifferent0000000000000000000000000000000000000000000000000000000',
              side: 'buy',
              summary: 'a different Base row was selected',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [trade('0xafter1', 'sell', '0xOtherAfter1000000000000000000000000000', 6)],
              before: [trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0)],
            },
            xxyyPoolUrl: 'https://www.xxyy.io/discover/base/pool/not-a-pool-address',
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for Base');
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('target_trade_not_found');
    expect(providerError.metadata).toMatchObject({
      contractAddress: '0xToken000000000000000000000000000000000000',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
    });
    expect(providerError.metadata).not.toHaveProperty('poolAddress');
    expect(providerError.metadata).not.toHaveProperty('xxyyPoolUrl');
  });

  it('keeps a pool_not_found reason when the browser driver cannot identify an XXYY pool', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          return Promise.resolve({
            poolCandidates: [],
            solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            targetTrade: {
              hash: SOLANA_TX,
              side: 'buy',
              summary: 'target buy without a pool',
              traderAddress: 'UserTrader11111111111111111111111111111111111',
            },
            tradeWindow: {
              after: [],
              before: [],
            },
          });
        },
      },
    });

    await expect(provider.analyze({ chain: 'solana', txHash: SOLANA_TX })).rejects.toMatchObject({
      reason: 'pool_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('treats an unconfirmed direct XXYY pool candidate as pool_not_found', async () => {
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeSolanaTransaction() {
          return Promise.resolve({
            poolAddress: 'Pool1111111111111111111111111111111111111111',
            solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            targetTrade: {
              hash: SOLANA_TX,
              side: 'buy',
              summary: 'target buy with only an unconfirmed pool candidate',
              traderAddress: 'UserTrader11111111111111111111111111111111111',
            },
            tradeWindow: {
              after: [],
              before: [],
            },
          });
        },
      },
    });

    await expect(provider.analyze({ chain: 'solana', txHash: SOLANA_TX })).rejects.toMatchObject({
      reason: 'pool_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('retries timeout failures before returning the browser adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('Timeout 60000ms exceeded while opening page');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried successfully');
  });

  it('retries browser NS_ERROR_NET_TIMEOUT failures as timeout errors', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: NS_ERROR_NET_TIMEOUT while opening Etherscan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried NS_ERROR_NET_TIMEOUT successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'ethereum';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'ethereum',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried NS_ERROR_NET_TIMEOUT successfully');
  });

  it('retries transient browser navigation failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error(
                'page.evaluate: Execution context was destroyed, most likely because of a navigation',
              );
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried transient browser failure successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried transient browser failure successfully');
  });

  it('retries transient XXYY trade window fetch failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new TxAnalysisProviderUnavailableError(
                'XXYY 结构化交易窗口查询失败：Failed to fetch',
                'provider_unavailable',
              );
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried XXYY trade window fetch successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried XXYY trade window fetch successfully');
  });

  it('retries transient browser page crashes before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('Navigation failed because page crashed while opening Etherscan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried page crash successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'ethereum';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'ethereum',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried page crash successfully');
  });

  it('retries transient browser frame detachments before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: Navigating frame was detached while opening BaseScan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried frame detached successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried frame detached successfully');
  });

  it('retries transient socket browser failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('socket hang up ECONNRESET while loading XXYY trade window');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried socket failure successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried socket failure successfully');
  });

  it('retries raw Chrome connection reset failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: ERR_CONNECTION_RESET while opening BaseScan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried raw ERR_CONNECTION_RESET successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried raw ERR_CONNECTION_RESET successfully');
  });

  it('retries raw Chrome connection closed failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: ERR_CONNECTION_CLOSED while opening BaseScan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried raw ERR_CONNECTION_CLOSED successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried raw ERR_CONNECTION_CLOSED successfully');
  });

  it('retries raw Chrome connection refused failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: ERR_CONNECTION_REFUSED while opening XXYY pool page');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried raw ERR_CONNECTION_REFUSED successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried raw ERR_CONNECTION_REFUSED successfully');
  });

  it('retries raw Chrome aborted navigation failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: ERR_ABORTED while opening Etherscan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried raw ERR_ABORTED successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'ethereum';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'ethereum',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried raw ERR_ABORTED successfully');
  });

  it('retries raw Chrome HTTP2 protocol failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: ERR_HTTP2_PROTOCOL_ERROR while opening Etherscan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried raw ERR_HTTP2_PROTOCOL_ERROR successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'ethereum';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'ethereum',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried raw ERR_HTTP2_PROTOCOL_ERROR successfully');
  });

  it('retries raw Chrome network changed failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: ERR_NETWORK_CHANGED while opening XXYY pool page');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried raw ERR_NETWORK_CHANGED successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried raw ERR_NETWORK_CHANGED successfully');
  });

  it('retries raw Chrome empty response failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: ERR_EMPTY_RESPONSE while opening BscScan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried raw ERR_EMPTY_RESPONSE successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'bsc';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'bsc',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried raw ERR_EMPTY_RESPONSE successfully');
  });

  it('retries raw Chrome name resolution failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: ERR_NAME_NOT_RESOLVED while opening Etherscan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried raw ERR_NAME_NOT_RESOLVED successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'ethereum';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'ethereum',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried raw ERR_NAME_NOT_RESOLVED successfully');
  });

  it('retries raw Chrome tunnel connection failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: ERR_TUNNEL_CONNECTION_FAILED while opening Solscan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried raw ERR_TUNNEL_CONNECTION_FAILED successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'solana';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'solana',
      txHash:
        '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried raw ERR_TUNNEL_CONNECTION_FAILED successfully');
  });

  it('retries raw Chrome proxy connection failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('page.goto: ERR_PROXY_CONNECTION_FAILED while opening Solscan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried raw ERR_PROXY_CONNECTION_FAILED successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'solana';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'solana',
      txHash:
        '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried raw ERR_PROXY_CONNECTION_FAILED successfully');
  });

  it('retries public explorer rate-limit failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('HTTP 429 Too Many Requests from Etherscan rate limit');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried public explorer rate limit successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'ethereum';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'ethereum',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried public explorer rate limit successfully');
  });

  it('retries public explorer 5xx failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('HTTP 503 Service Unavailable from BaseScan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried public explorer 5xx successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried public explorer 5xx successfully');
  });

  it('retries public explorer Cloudflare 52x failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('HTTP 520 Web server returned an unknown error from BaseScan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried public explorer Cloudflare 52x successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried public explorer Cloudflare 52x successfully');
  });

  it('retries public explorer Cloudflare 525 failures before returning the adapter result', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('HTTP 525 SSL handshake failed from BaseScan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried public explorer Cloudflare 525 successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried public explorer Cloudflare 525 successfully');
  });

  it('retries public explorer SSL handshake failures without an HTTP status code', async () => {
    let attempts = 0;
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('Cloudflare SSL handshake failed while loading BaseScan');
            }

            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'retried public explorer SSL handshake successfully',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxRetries: 1,
    });

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(attempts).toBe(2);
    expect(result.summary).toBe('retried public explorer SSL handshake successfully');
  });

  it('retries raw Chrome SSL and certificate failures before returning the adapter result', async () => {
    for (const message of [
      'page.goto: ERR_SSL_PROTOCOL_ERROR while opening BaseScan',
      'page.goto: ERR_CERT_AUTHORITY_INVALID while opening Etherscan',
    ]) {
      let attempts = 0;
      const provider = createBrowserTxAnalysisProvider({
        adapters: [
          {
            analyze(reference) {
              attempts += 1;
              if (attempts === 1) {
                throw new Error(message);
              }

              return Promise.resolve({
                analyzedAt: '2026-06-11T00:00:00.000Z',
                chain: reference.chain,
                confidence: 0.5,
                dataSource: 'browser',
                evidence: [],
                relatedTransactions: [],
                summary: `retried ${message} successfully`,
                txHash: reference.txHash,
                verdict: 'inconclusive',
              });
            },
            supports(reference) {
              return reference.chain === 'base';
            },
          },
        ],
        maxRetries: 1,
      });

      const result = await provider.analyze({
        chain: 'base',
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      });

      expect(attempts).toBe(2);
      expect(result.summary).toBe(`retried ${message} successfully`);
    }
  });

  it('limits concurrent browser adapter analyses', async () => {
    let active = 0;
    let peakActive = 0;
    const firstRelease = deferred<void>();
    const secondStarted = deferred<void>();
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          async analyze(reference) {
            active += 1;
            peakActive = Math.max(peakActive, active);
            if (reference.txHash.endsWith('01')) {
              await firstRelease.promise;
            } else {
              secondStarted.resolve();
            }
            active -= 1;

            return {
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: reference.txHash,
              txHash: reference.txHash,
              verdict: 'inconclusive',
            };
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxConcurrentAnalyses: 1,
    });

    const first = provider.analyze({
      chain: 'base',
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
    });
    const second = provider.analyze({
      chain: 'base',
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000002',
    });
    await Promise.resolve();

    expect(peakActive).toBe(1);
    firstRelease.resolve();
    await secondStarted.promise;
    await Promise.all([first, second]);

    expect(peakActive).toBe(1);
  });

  it('releases the browser adapter concurrency slot when an analysis fails', async () => {
    let active = 0;
    let peakActive = 0;
    const firstRelease = deferred<void>();
    const secondStarted = deferred<void>();
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          async analyze(reference) {
            active += 1;
            peakActive = Math.max(peakActive, active);
            try {
              if (reference.txHash.endsWith('01')) {
                await firstRelease.promise;
                throw new Error('Transaction not found on explorer page');
              }

              secondStarted.resolve();
              return {
                analyzedAt: '2026-06-11T00:00:00.000Z',
                chain: reference.chain,
                confidence: 0.5,
                dataSource: 'browser',
                evidence: [],
                relatedTransactions: [],
                summary: 'second analysis completed',
                txHash: reference.txHash,
                verdict: 'inconclusive',
              };
            } finally {
              active -= 1;
            }
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      maxConcurrentAnalyses: 1,
    });

    const first = provider.analyze({
      chain: 'base',
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
    });
    const second = provider.analyze({
      chain: 'base',
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000002',
    });
    await Promise.resolve();

    expect(peakActive).toBe(1);
    firstRelease.resolve();

    await expect(first).rejects.toMatchObject({ reason: 'tx_not_found' });
    await secondStarted.promise;
    await expect(second).resolves.toMatchObject({ summary: 'second analysis completed' });
    expect(peakActive).toBe(1);
  });

  it('lets an optional analysis reviewer adjust a browser verdict and append evidence', async () => {
    const evmTx = '0x8234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      analysisReviewer: {
        review(input) {
          expect(input.chain).toBe('base');
          expect(input.ruleAnalysis.verdict).toBe('sandwiched');
          expect(input.targetTrade.hash).toBe(evmTx);
          return Promise.resolve({
            confidence: 0.52,
            evidence: [
              {
                detail: '模型复核认为前后腿地址模式仍有歧义，需要人工复查原页面。',
                label: '模型复核',
                severity: 'warning',
              },
            ],
            summary: '模型复核：疑似模式存在，但证据不足以直接确认被夹。',
            verdict: 'inconclusive',
          });
        },
      },
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            poolAddress: '0xPool0000000000000000000000000000000000000',
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-base-window.png',
            targetTrade: {
              hash: evmTx,
              poolAddress: '0xPool0000000000000000000000000000000000000',
              side: 'buy',
              summary: 'target buy',
              timestamp: '2026-06-10T01:00:10.000Z',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [
                trade('0xback1', 'sell', '0xAttacker100000000000000000000000000000000', 11),
                trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 12),
                trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 13),
                trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 14),
                trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 15),
              ],
              before: [
                trade('0xfront1', 'buy', '0xAttacker100000000000000000000000000000000', 9),
                trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 6),
                trade('0xbefore3', 'buy', '0xOtherBefore3000000000000000000000000000', 7),
                trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 8),
                trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 9),
              ],
            },
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.verdict).toBe('inconclusive');
    expect(result.confidence).toBe(0.52);
    expect(result.summary).toContain('模型复核：疑似模式存在');
    expect(result.evidence).toContainEqual({
      detail: '模型复核认为前后腿地址模式仍有歧义，需要人工复查原页面。',
      label: '模型复核',
      severity: 'warning',
    });
    expect(result.relatedTransactions.map((item) => item.role)).toEqual([
      'front_run',
      'related',
      'related',
      'related',
      'related',
      'user',
      'back_run',
      'related',
      'related',
      'related',
      'related',
    ]);
  });

  it('does not let a reviewer upgrade to sandwiched without structured front and back transactions', async () => {
    const evmTx = '0x8334567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      analysisReviewer: {
        review(input) {
          expect(input.ruleAnalysis.verdict).toBe('not_sandwiched');
          return Promise.resolve({
            confidence: 0.91,
            evidence: [
              {
                detail: '模型复核认为存在异常，但没有返回可复查的前后腿结构。',
                label: '模型复核',
                severity: 'warning',
              },
            ],
            summary: '模型复核：确认被夹。',
            verdict: 'sandwiched',
          });
        },
      },
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            poolAddress: '0xPool0000000000000000000000000000000000000',
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-base-window.png',
            targetTrade: {
              hash: evmTx,
              poolAddress: '0xPool0000000000000000000000000000000000000',
              side: 'buy',
              summary: 'target buy',
              timestamp: '2026-06-10T01:00:10.000Z',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [
                trade('0xafter1', 'sell', '0xOtherAfter1000000000000000000000000000', 11),
                trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 12),
                trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 13),
                trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 14),
                trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 15),
              ],
              before: [
                trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 5),
                trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 6),
                trade('0xbefore3', 'buy', '0xOtherBefore3000000000000000000000000000', 7),
                trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 8),
                trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 9),
              ],
            },
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.verdict).toBe('not_sandwiched');
    expect(result.confidence).toBe(0.6);
    expect(result.summary).not.toContain('确认被夹');
    expect(result.relatedTransactions.map((item) => item.role)).toEqual([
      'related',
      'related',
      'related',
      'related',
      'related',
      'user',
      'related',
      'related',
      'related',
      'related',
      'related',
    ]);
    expect(result.evidence).toContainEqual({
      detail: '模型复核返回 sandwiched，但规则结果没有可复查的前置和后置交易，已保留规则化判断。',
      label: '模型复核',
      severity: 'warning',
    });
  });

  it('keeps the rule summary and drops blank reviewer evidence', async () => {
    const evmTx = '0x8834567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      analysisReviewer: {
        review() {
          return Promise.resolve({
            evidence: [
              {
                detail: '   ',
                label: '模型复核',
                severity: 'warning',
              },
              {
                detail: '复核器返回了可用补充说明。',
                label: '  模型复核  ',
                severity: 'info',
              },
            ],
            summary: '   ',
            verdict: 'inconclusive',
          });
        },
      },
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve(sandwichedEvmSnapshot(evmTx));
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.verdict).toBe('inconclusive');
    expect(result.summary).toContain('疑似被夹');
    expect(result.summary.trim()).not.toBe('');
    expect(result.evidence).toContainEqual({
      detail: '复核器返回了可用补充说明。',
      label: '模型复核',
      severity: 'info',
    });
    expect(result.evidence).not.toContainEqual(
      expect.objectContaining({
        detail: '   ',
      }),
    );
  });

  it('drops reviewer evidence with an invalid severity at runtime', async () => {
    const evmTx = '0x8734567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      analysisReviewer: {
        review() {
          return Promise.resolve({
            evidence: [
              {
                detail: '这条复核证据的 severity 无法写入报告。',
                label: '模型复核',
                severity: 'urgent' as never,
              },
              {
                detail: '这条复核证据可以保留。',
                label: '模型复核',
                severity: 'warning',
              },
            ],
            verdict: 'inconclusive',
          });
        },
      },
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve(sandwichedEvmSnapshot(evmTx));
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.evidence).toContainEqual({
      detail: '这条复核证据可以保留。',
      label: '模型复核',
      severity: 'warning',
    });
    expect(result.evidence).not.toContainEqual({
      detail: '这条复核证据的 severity 无法写入报告。',
      label: '模型复核',
      severity: 'urgent',
    });
  });

  it('ignores a non-string reviewer summary at runtime and keeps usable review fields', async () => {
    const evmTx = '0x8b34567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      analysisReviewer: {
        review() {
          return Promise.resolve({
            confidence: 0.44,
            evidence: [
              {
                detail: '复核器 summary 类型错误，但这条证据仍可保留。',
                label: '模型复核',
                severity: 'warning',
              },
            ],
            summary: 123 as never,
            verdict: 'inconclusive',
          });
        },
      },
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve(sandwichedEvmSnapshot(evmTx));
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.verdict).toBe('inconclusive');
    expect(result.confidence).toBe(0.44);
    expect(result.summary).toContain('疑似被夹');
    expect(result.summary).not.toContain('123');
    expect(result.evidence).toContainEqual({
      detail: '复核器 summary 类型错误，但这条证据仍可保留。',
      label: '模型复核',
      severity: 'warning',
    });
  });

  it('ignores an invalid reviewer verdict at runtime and keeps the rule verdict', async () => {
    const evmTx = '0x8a34567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      analysisReviewer: {
        review() {
          return Promise.resolve({
            confidence: 0.41,
            evidence: [
              {
                detail: '复核器返回了无法识别的 verdict，应只保留可用置信度和证据。',
                label: '模型复核',
                severity: 'warning',
              },
            ],
            summary: '模型复核：非法 verdict 不应覆盖规则结论。',
            verdict: 'definitely_sandwiched' as never,
          });
        },
      },
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve(sandwichedEvmSnapshot(evmTx));
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.verdict).toBe('sandwiched');
    expect(result.confidence).toBe(0.41);
    expect(result.summary).toContain('模型复核：非法 verdict 不应覆盖规则结论');
    expect(result.evidence).toContainEqual({
      detail: '复核器返回了无法识别的 verdict，应只保留可用置信度和证据。',
      label: '模型复核',
      severity: 'warning',
    });
    expect(result.evidence).toContainEqual({
      detail: '复核器返回了无法识别的 verdict，已保留规则化判断。',
      label: '模型复核',
      severity: 'warning',
    });
  });

  it('uses a readable reviewer failure message when the thrown error message is blank', async () => {
    const evmTx = '0x8934567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      analysisReviewer: {
        review() {
          throw new Error('   ');
        },
      },
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve(sandwichedEvmSnapshot(evmTx));
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.verdict).toBe('sandwiched');
    expect(result.evidence).toContainEqual({
      detail: '交易分析复核器不可用。',
      label: '模型复核',
      severity: 'warning',
    });
    expect(result.evidence).not.toContainEqual(
      expect.objectContaining({
        detail: '   ',
      }),
    );
  });

  it('keeps the rule analysis result when an optional reviewer fails', async () => {
    const evmTx = '0x9234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      analysisReviewer: {
        review() {
          throw new Error('review model unavailable');
        },
      },
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            poolAddress: '0xPool0000000000000000000000000000000000000',
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-base-window.png',
            targetTrade: {
              hash: evmTx,
              poolAddress: '0xPool0000000000000000000000000000000000000',
              side: 'buy',
              summary: 'target buy',
              timestamp: '2026-06-10T01:00:10.000Z',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [
                trade('0xback1', 'sell', '0xAttacker100000000000000000000000000000000', 11),
                trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 12),
                trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 13),
                trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 14),
                trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 15),
              ],
              before: [
                trade('0xfront1', 'buy', '0xAttacker100000000000000000000000000000000', 9),
                trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 6),
                trade('0xbefore3', 'buy', '0xOtherBefore3000000000000000000000000000', 7),
                trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 8),
                trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 9),
              ],
            },
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.verdict).toBe('sandwiched');
    expect(result.evidence).toContainEqual({
      detail: 'review model unavailable',
      label: '模型复核',
      severity: 'warning',
    });
  });

  it('keeps the rule analysis result and records evidence when a reviewer returns no usable review', async () => {
    const evmTx = '0xa234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      analysisReviewer: {
        review() {
          return Promise.resolve(undefined);
        },
      },
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve(sandwichedEvmSnapshot(evmTx));
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.verdict).toBe('sandwiched');
    expect(result.evidence).toContainEqual({
      detail: '交易分析复核器未返回可用复核结果，已保留规则化判断。',
      label: '模型复核',
      severity: 'warning',
    });
  });

  it('attaches a persisted report URL when a report writer is configured', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const writes: Array<{
      reference: { chain: string; txHash: string };
      result: { reportUrl?: string; txHash: string };
    }> = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'persisted report result',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport(input) {
          writes.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-report-base.json' });
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.reportUrl).toBe('/assets/tx-analysis-report-base.json');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.reference).toEqual({ chain: 'base', txHash: evmTx });
    expect(writes[0]?.result.txHash).toBe(evmTx);
    expect(writes[0]?.result).not.toHaveProperty('reportUrl');
  });

  it('trims persisted success report URLs before returning results', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'persisted report result',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          return Promise.resolve({ reportUrl: '  /assets/tx-analysis-report-base.json  ' });
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.reportUrl).toBe('/assets/tx-analysis-report-base.json');
  });

  it('records a report warning when success report persistence returns a blank URL', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'persisted report result',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          return Promise.resolve({ reportUrl: '   ' });
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.reportUrl).toBeUndefined();
    expect(result.evidence).toContainEqual({
      detail: '报告保存失败：报告写入器未返回可用报告链接。',
      label: '交易分析报告',
      severity: 'warning',
    });
  });

  it('persists discovered unknown EVM transactions under the concrete chain', async () => {
    const evmTx = '0x4234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const writes: Array<{ reference: { chain: string; txHash: string } }> = [];
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction(input) {
          if (input.chain !== 'ethereum') {
            throw new TxAnalysisProviderUnavailableError('not found on this chain', 'tx_not_found');
          }

          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://etherscan.io/tx/${evmTx}`,
            poolAddress: '0xPool0000000000000000000000000000000000000',
            screenshotTargetRowMarked: true,
            screenshotUrl: '/assets/tx-analysis-ethereum-window.png',
            targetTrade: {
              hash: evmTx,
              side: 'buy',
              summary: 'target buy on Ethereum',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [
                trade('0xafter1', 'sell', '0xOtherAfter1000000000000000000000000000', 6),
                trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 7),
                trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 8),
                trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 9),
                trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 10),
              ],
              before: [
                trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0),
                trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 1),
                trade('0xbefore3', 'buy', '0xOtherBefore3000000000000000000000000000', 2),
                trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 3),
                trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 4),
              ],
            },
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for an EVM hash');
        },
      },
      reportWriter: {
        writeReport(input) {
          writes.push({ reference: input.reference });
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-report-ethereum.json' });
        },
      },
    });

    const result = await provider.analyze({ chain: 'unknown', txHash: evmTx });

    expect(result.chain).toBe('ethereum');
    expect(writes).toEqual([{ reference: { chain: 'ethereum', txHash: evmTx } }]);
  });

  it('keeps the analysis result when report persistence fails', async () => {
    const evmTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze(reference) {
            return Promise.resolve({
              analyzedAt: '2026-06-11T00:00:00.000Z',
              chain: reference.chain,
              confidence: 0.5,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: 'analysis still usable',
              txHash: reference.txHash,
              verdict: 'inconclusive',
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('disk full');
        },
      },
    });

    const result = await provider.analyze({ chain: 'base', txHash: evmTx });

    expect(result.reportUrl).toBeUndefined();
    expect(result.summary).toBe('analysis still usable');
    expect(result.evidence).toContainEqual({
      detail: '报告保存失败：disk full',
      label: '交易分析报告',
      severity: 'warning',
    });
  });

  it('persists unavailable browser failures and rethrows them with a report URL', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError('XXYY pool not found', 'pool_not_found');
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    await expect(provider.analyze({ chain: 'base', txHash: evmTx })).rejects.toMatchObject({
      reason: 'pool_not_found',
      reportUrl: '/assets/tx-analysis-failure-base.json',
    });
    expect(failureWrites).toEqual([
      {
        message: 'XXYY pool not found',
        reason: 'pool_not_found',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('trims persisted failure report URLs before rethrowing browser failures', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError('XXYY pool not found', 'pool_not_found');
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport() {
          return Promise.resolve({ reportUrl: '  /assets/tx-analysis-failure-base.json  ' });
        },
      },
    });

    await expect(provider.analyze({ chain: 'base', txHash: evmTx })).rejects.toMatchObject({
      reason: 'pool_not_found',
      reportUrl: '/assets/tx-analysis-failure-base.json',
    });
  });

  it('trims adapter failure messages before persisting reports', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError(
              '  XXYY pool not found  ',
              'pool_not_found',
            );
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    await expect(provider.analyze({ chain: 'base', txHash: evmTx })).rejects.toMatchObject({
      message: 'XXYY pool not found',
      reason: 'pool_not_found',
      reportUrl: '/assets/tx-analysis-failure-base.json',
    });
    expect(failureWrites).toEqual([
      {
        message: 'XXYY pool not found',
        reason: 'pool_not_found',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('records a report write error when failure report persistence returns a blank URL', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError('XXYY pool not found', 'pool_not_found');
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport() {
          return Promise.resolve({ reportUrl: '   ' });
        },
      },
    });

    await expect(provider.analyze({ chain: 'base', txHash: evmTx })).rejects.toMatchObject({
      metadata: { reportWriteError: '报告写入器未返回可用报告链接。' },
      reason: 'pool_not_found',
      reportUrl: undefined,
    });
  });

  it('filters malformed XXYY pool URLs before persisting adapter failure metadata', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError(
              'XXYY target trade not found',
              'target_trade_not_found',
              {
                metadata: {
                  contractAddress: '0xToken000000000000000000000000000000000000',
                  explorerUrl: `https://basescan.org/tx/${evmTx}`,
                  xxyyPoolUrl: 'https://www.xxyy.io/discover/base/pool/not-a-pool-address',
                },
              },
            );
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('target_trade_not_found');
    expect(providerError.reportUrl).toBe('/assets/tx-analysis-failure-base.json');
    expect(providerError.metadata).toMatchObject({
      contractAddress: '0xToken000000000000000000000000000000000000',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
    });
    expect(providerError.metadata).not.toHaveProperty('xxyyPoolUrl');
    expect(failureWrites).toEqual([
      {
        message: 'XXYY target trade not found',
        metadata: {
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
        },
        reason: 'target_trade_not_found',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('filters mismatched explorer URLs before persisting adapter failure metadata', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError('transaction not found', 'tx_not_found', {
              metadata: {
                contractAddress: '0xToken000000000000000000000000000000000000',
                explorerUrl: `https://basescan.org/tx/${otherTx}`,
                targetTraderAddress: '0xUser0000000000000000000000000000000000000',
              },
            });
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('tx_not_found');
    expect(providerError.reportUrl).toBe('/assets/tx-analysis-failure-base.json');
    expect(providerError.metadata).toMatchObject({
      contractAddress: '0xToken000000000000000000000000000000000000',
      targetTraderAddress: '0xUser0000000000000000000000000000000000000',
    });
    expect(providerError.metadata).not.toHaveProperty('explorerUrl');
    expect(failureWrites).toEqual([
      {
        message: 'transaction not found',
        metadata: {
          contractAddress: '0xToken000000000000000000000000000000000000',
          targetTraderAddress: '0xUser0000000000000000000000000000000000000',
        },
        reason: 'tx_not_found',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('repairs mismatched related transaction explorer URLs before persisting adapter failure metadata', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const otherTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError(
              'target row screenshot unavailable',
              'screenshot_unavailable',
              {
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${evmTx}`,
                  relatedTransactions: [
                    {
                      explorerUrl: `https://basescan.org/tx/${otherTx}`,
                      hash: frontTx,
                      role: 'front_run',
                      summary: 'front run',
                    },
                    {
                      hash: evmTx,
                      role: 'user',
                      summary: 'user trade',
                    },
                  ],
                },
              },
            );
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('screenshot_unavailable');
    const expectedRelatedTransactions = [
      {
        explorerUrl: `https://basescan.org/tx/${frontTx}`,
        hash: frontTx,
        role: 'front_run',
        summary: 'front run',
      },
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        summary: 'user trade',
      },
    ];
    expect(providerError.metadata?.relatedTransactions).toEqual(expectedRelatedTransactions);
    expect(failureWrites).toEqual([
      {
        message: 'target row screenshot unavailable',
        metadata: {
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          relatedTransactions: expectedRelatedTransactions,
        },
        reason: 'screenshot_unavailable',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('adds the requested user transaction to adapter failure related transactions before persisting', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const backTx = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError(
              'target row screenshot unavailable',
              'screenshot_unavailable',
              {
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${evmTx}`,
                  relatedTransactions: [
                    {
                      hash: frontTx,
                      role: 'front_run',
                      summary: 'front run',
                    },
                    {
                      hash: backTx,
                      role: 'back_run',
                      summary: 'back run',
                    },
                  ],
                },
              },
            );
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const expectedRelatedTransactions = [
      {
        explorerUrl: `https://basescan.org/tx/${frontTx}`,
        hash: frontTx,
        role: 'front_run',
        summary: 'front run',
      },
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        summary: '用户交易',
      },
      {
        explorerUrl: `https://basescan.org/tx/${backTx}`,
        hash: backTx,
        role: 'back_run',
        summary: 'back run',
      },
    ];
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('screenshot_unavailable');
    expect(providerError.metadata?.relatedTransactions).toEqual(expectedRelatedTransactions);
    expect(failureWrites).toEqual([
      {
        message: 'target row screenshot unavailable',
        metadata: {
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          relatedTransactions: expectedRelatedTransactions,
        },
        reason: 'screenshot_unavailable',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('deduplicates adapter failure related transactions by hash before persisting', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError(
              'target row screenshot unavailable',
              'screenshot_unavailable',
              {
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${evmTx}`,
                  relatedTransactions: [
                    {
                      hash: frontTx.toUpperCase(),
                      role: 'related',
                      summary: 'duplicate context front row',
                    },
                    {
                      hash: frontTx,
                      role: 'front_run',
                      summary: 'front run',
                    },
                    {
                      hash: evmTx.toUpperCase(),
                      role: 'related',
                      summary: 'duplicate target context row',
                    },
                  ],
                },
              },
            );
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    const expectedRelatedTransactions = [
      {
        explorerUrl: `https://basescan.org/tx/${frontTx}`,
        hash: frontTx,
        role: 'front_run',
        summary: 'front run',
      },
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        summary: '用户交易',
      },
    ];
    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('screenshot_unavailable');
    expect(providerError.metadata?.relatedTransactions).toEqual(expectedRelatedTransactions);
    expect(failureWrites).toEqual([
      {
        message: 'target row screenshot unavailable',
        metadata: {
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          relatedTransactions: expectedRelatedTransactions,
        },
        reason: 'screenshot_unavailable',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('normalizes adapter failure related transaction role aliases before persisting', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const backTx = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const contextTx = '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError(
              'target row screenshot unavailable',
              'screenshot_unavailable',
              {
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${evmTx}`,
                  relatedTransactions: [
                    {
                      hash: frontTx,
                      role: 'frontRun' as TxAnalysisRelatedTransaction['role'],
                      summary: 'front run alias',
                    },
                    {
                      hash: evmTx,
                      role: 'target' as TxAnalysisRelatedTransaction['role'],
                      summary: 'target role alias',
                    },
                    {
                      hash: backTx,
                      role: 'back-run' as TxAnalysisRelatedTransaction['role'],
                      summary: 'back run alias',
                    },
                    {
                      hash: contextTx,
                      role: 'noise' as TxAnalysisRelatedTransaction['role'],
                      summary: 'unknown role context',
                    },
                  ],
                },
              },
            );
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    const expectedRelatedTransactions = [
      {
        explorerUrl: `https://basescan.org/tx/${frontTx}`,
        hash: frontTx,
        role: 'front_run',
        summary: 'front run alias',
      },
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        summary: 'target role alias',
      },
      {
        explorerUrl: `https://basescan.org/tx/${backTx}`,
        hash: backTx,
        role: 'back_run',
        summary: 'back run alias',
      },
      {
        explorerUrl: `https://basescan.org/tx/${contextTx}`,
        hash: contextTx,
        role: 'related',
        summary: 'unknown role context',
      },
    ];
    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('screenshot_unavailable');
    expect(providerError.metadata?.relatedTransactions).toEqual(expectedRelatedTransactions);
    expect(failureWrites).toEqual([
      {
        message: 'target row screenshot unavailable',
        metadata: {
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          relatedTransactions: expectedRelatedTransactions,
        },
        reason: 'screenshot_unavailable',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('trims adapter failure related transaction summaries before persisting', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const backTx = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError(
              'target row screenshot unavailable',
              'screenshot_unavailable',
              {
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${evmTx}`,
                  relatedTransactions: [
                    {
                      hash: frontTx,
                      role: 'front_run',
                      summary: '  front run  ',
                    },
                    {
                      hash: evmTx,
                      role: 'user',
                      summary: '   ',
                    },
                    {
                      hash: backTx,
                      role: 'back_run',
                      summary: '  back run  ',
                    },
                  ],
                },
              },
            );
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    const expectedRelatedTransactions = [
      {
        explorerUrl: `https://basescan.org/tx/${frontTx}`,
        hash: frontTx,
        role: 'front_run',
        summary: 'front run',
      },
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        summary: '用户交易',
      },
      {
        explorerUrl: `https://basescan.org/tx/${backTx}`,
        hash: backTx,
        role: 'back_run',
        summary: 'back run',
      },
    ];
    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.reason).toBe('screenshot_unavailable');
    expect(providerError.metadata?.relatedTransactions).toEqual(expectedRelatedTransactions);
    expect(failureWrites).toEqual([
      {
        message: 'target row screenshot unavailable',
        metadata: {
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          relatedTransactions: expectedRelatedTransactions,
        },
        reason: 'screenshot_unavailable',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('trims adapter failure metadata fields before persisting reports', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError(
              'partial context has whitespace',
              'provider_unavailable',
              {
                metadata: {
                  contractAddress: '   ',
                  explorerUrl: `  https://basescan.org/tx/${evmTx}  `,
                  poolAddress: '   ',
                  reportWriteError: '  previous report write failed  ',
                  routerAddress: '  0xRouter0000000000000000000000000000000000  ',
                  screenshotUrl: '   ',
                  targetTraderAddress: '  0xUser0000000000000000000000000000000000000  ',
                  transactionTime: '  2026-06-10T01:00:05.000Z  ',
                  unsupportedChainHint: '  Base Sepolia  ',
                  unsupportedExplorerHost: '  sepolia.basescan.org  ',
                  xxyyPoolUrl: '   ',
                },
              },
            );
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'base', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    const expectedMetadata = {
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
      reportWriteError: 'previous report write failed',
      routerAddress: '0xRouter0000000000000000000000000000000000',
      targetTraderAddress: '0xUser0000000000000000000000000000000000000',
      transactionTime: '2026-06-10T01:00:05.000Z',
      unsupportedChainHint: 'Base Sepolia',
      unsupportedExplorerHost: 'sepolia.basescan.org',
    };
    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.metadata).toEqual(expectedMetadata);
    expect(failureWrites).toEqual([
      {
        message: 'partial context has whitespace',
        metadata: expectedMetadata,
        reason: 'provider_unavailable',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('trims adapter failure probe attempts before persisting reports', async () => {
    const evmTx = '0x4234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError(
              'all EVM probes failed',
              'provider_unavailable',
              {
                metadata: {
                  probeAttempts: [
                    {
                      chain: 'base',
                      message: '   ',
                      reason: 'tx_not_found',
                    },
                    {
                      chain: 'ethereum',
                      message: '  Etherscan requires browser verification  ',
                      reason: 'browser_verification_required',
                    },
                    {
                      chain: 'bsc',
                      message: '  BscScan timed out  ',
                      reason: 'timeout',
                    },
                  ],
                },
              },
            );
          },
          supports(reference) {
            return reference.chain === 'unknown';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-unknown.json' });
        },
      },
    });

    let caughtError: unknown;
    try {
      await provider.analyze({ chain: 'unknown', txHash: evmTx });
    } catch (error) {
      caughtError = error;
    }

    const expectedMetadata = {
      probeAttempts: [
        {
          chain: 'ethereum',
          message: 'Etherscan requires browser verification',
          reason: 'browser_verification_required',
        },
        {
          chain: 'bsc',
          message: 'BscScan timed out',
          reason: 'timeout',
        },
      ],
    };
    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.metadata).toEqual(expectedMetadata);
    expect(failureWrites).toEqual([
      {
        message: 'all EVM probes failed',
        metadata: expectedMetadata,
        reason: 'provider_unavailable',
        reference: { chain: 'unknown', txHash: evmTx },
      },
    ]);
  });

  it('preserves failure report persistence errors on unavailable browser failures', async () => {
    const evmTx = '0x5234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const provider = createBrowserTxAnalysisProvider({
      adapters: [
        {
          analyze() {
            throw new TxAnalysisProviderUnavailableError(
              'XXYY target trade missing',
              'target_trade_not_found',
            );
          },
          supports(reference) {
            return reference.chain === 'base';
          },
        },
      ],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport() {
          throw new Error('disk full');
        },
      },
    });

    await expect(provider.analyze({ chain: 'base', txHash: evmTx })).rejects.toMatchObject({
      metadata: { reportWriteError: 'disk full' },
      reason: 'target_trade_not_found',
      reportUrl: undefined,
    });
  });

  it('preserves failure report persistence errors on unsupported-chain browser failures', async () => {
    const provider = createBrowserTxAnalysisProvider({
      adapters: [],
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport() {
          throw new Error('report disk full');
        },
      },
    });

    await expect(provider.analyze({ chain: 'solana', txHash: SOLANA_TX })).rejects.toMatchObject({
      metadata: { reportWriteError: 'report disk full' },
      name: 'TxAnalysisUnsupportedChainError',
      reportUrl: undefined,
    });
  });

  it('persists discovered unknown EVM failures under the concrete chain', async () => {
    const evmTx = '0x5234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction(input) {
          if (input.chain === 'base') {
            throw new TxAnalysisProviderUnavailableError('not found on Base', 'tx_not_found');
          }

          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://etherscan.io/tx/${evmTx}`,
            poolAddress: '0xPool0000000000000000000000000000000000000',
            targetTrade: {
              hash: evmTx,
              side: 'buy',
              summary: 'target buy on Ethereum without screenshot',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [
                trade('0xafter1', 'sell', '0xOtherAfter1000000000000000000000000000', 6),
                trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 7),
                trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 8),
                trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 9),
                trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 10),
              ],
              before: [
                trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0),
                trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 1),
                trade('0xbefore3', 'buy', '0xOtherBefore3000000000000000000000000000', 2),
                trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 3),
                trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 4),
              ],
            },
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for an EVM hash');
        },
      },
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-ethereum.json' });
        },
      },
    });

    await expect(provider.analyze({ chain: 'unknown', txHash: evmTx })).rejects.toMatchObject({
      reason: 'screenshot_unavailable',
      reportUrl: '/assets/tx-analysis-failure-ethereum.json',
    });
    expect(failureWrites).toEqual([
      {
        message: '浏览器取证未生成 XXYY 原页面截图。',
        metadata: {
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://etherscan.io/tx/${evmTx}`,
          poolAddress: '0xPool0000000000000000000000000000000000000',
          relatedTransactions: [
            {
              explorerUrl: `https://etherscan.io/tx/${evmTx}`,
              hash: evmTx,
              role: 'user',
              side: 'buy',
              summary: 'target buy on Ethereum without screenshot',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
          ],
          targetTradeSide: 'buy',
          targetTraderAddress: '0xUser0000000000000000000000000000000000000',
          xxyyPoolUrl: 'https://www.xxyy.io/eth/0xpool0000000000000000000000000000000000000',
        },
        reason: 'screenshot_unavailable',
        reference: { chain: 'ethereum', txHash: evmTx },
      },
    ]);
  });

  it('persists browser failure metadata for ops review when partial transaction context is available', async () => {
    const evmTx = '0x6234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            poolAddress: '0xPool0000000000000000000000000000000000000',
            routerAddress: '0xRouter0000000000000000000000000000000000',
            targetTrade: {
              hash: evmTx,
              side: 'buy',
              summary: 'target buy without screenshot',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [
                trade('0xafter1', 'sell', '0xOtherAfter1000000000000000000000000000', 6),
                trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 7),
                trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 8),
                trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 9),
                trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 10),
              ],
              before: [
                trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0),
                trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 1),
                trade('0xbefore3', 'buy', '0xOtherBefore3000000000000000000000000000', 2),
                trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 3),
                trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 4),
              ],
            },
            xxyyPoolUrl: 'https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    await expect(provider.analyze({ chain: 'base', txHash: evmTx })).rejects.toMatchObject({
      reason: 'screenshot_unavailable',
      reportUrl: '/assets/tx-analysis-failure-base.json',
    });
    expect(failureWrites).toEqual([
      {
        message: '浏览器取证未生成 XXYY 原页面截图。',
        metadata: {
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          poolAddress: '0xPool0000000000000000000000000000000000000',
          relatedTransactions: [
            {
              explorerUrl: `https://basescan.org/tx/${evmTx}`,
              hash: evmTx,
              role: 'user',
              side: 'buy',
              summary: 'target buy without screenshot',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
          ],
          routerAddress: '0xRouter0000000000000000000000000000000000',
          targetTradeSide: 'buy',
          targetTraderAddress: '0xUser0000000000000000000000000000000000000',
          xxyyPoolUrl: 'https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
        },
        reason: 'screenshot_unavailable',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
  });

  it('persists related transaction context when the XXYY original screenshot is unavailable', async () => {
    const evmTx = '0xe234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const backTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            poolAddress: '0xPool0000000000000000000000000000000000000',
            targetTrade: {
              hash: evmTx,
              poolAddress: '0xPool0000000000000000000000000000000000000',
              side: 'buy',
              summary: 'target buy without screenshot',
              timestamp: '2026-06-10T01:00:05.000Z',
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [
                tradeInPool(
                  backTx,
                  'sell',
                  '0xAttacker000000000000000000000000000000000',
                  6,
                  '0xPool0000000000000000000000000000000000000',
                ),
              ],
              before: [
                tradeInPool(
                  frontTx,
                  'buy',
                  '0xAttacker000000000000000000000000000000000',
                  4,
                  '0xPool0000000000000000000000000000000000000',
                ),
              ],
            },
            xxyyPoolUrl: 'https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    await expect(provider.analyze({ chain: 'base', txHash: evmTx })).rejects.toMatchObject({
      reason: 'screenshot_unavailable',
      reportUrl: '/assets/tx-analysis-failure-base.json',
    });
    expect(failureWrites).toHaveLength(1);
    expect(failureWrites[0]).toMatchObject({
      metadata: {
        relatedTransactions: [
          {
            explorerUrl: `https://basescan.org/tx/${frontTx}`,
            hash: frontTx,
            role: 'front_run',
          },
          {
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            hash: evmTx,
            role: 'user',
          },
          {
            explorerUrl: `https://basescan.org/tx/${backTx}`,
            hash: backTx,
            role: 'back_run',
          },
        ],
      },
      reason: 'screenshot_unavailable',
      reference: { chain: 'base', txHash: evmTx },
    });
  });

  it('uses the XXYY target trade timestamp in failure metadata when explorer time is missing', async () => {
    const evmTx = '0xd234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const targetTimestamp = '2026-06-10T01:00:05.000Z';
    const failureWrites: unknown[] = [];
    const provider = createBrowserTxAnalysisProvider({
      driver: {
        analyzeEvmTransaction() {
          return Promise.resolve({
            contractAddress: '0xToken000000000000000000000000000000000000',
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            poolAddress: '0xPool0000000000000000000000000000000000000',
            targetTrade: {
              hash: evmTx,
              side: 'buy',
              summary: 'target buy without screenshot',
              timestamp: targetTimestamp,
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
            tradeWindow: {
              after: [trade('0xafter1', 'sell', '0xOtherAfter1000000000000000000000000000', 6)],
              before: [trade('0xbefore1', 'buy', '0xOtherBefore1000000000000000000000000000', 0)],
            },
            xxyyPoolUrl: 'https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
          });
        },
        analyzeSolanaTransaction() {
          throw new Error('Solana driver should not be called for a Base transaction');
        },
      },
      reportWriter: {
        writeReport() {
          throw new Error('success report should not be written');
        },
        writeFailureReport(input) {
          failureWrites.push(input);
          return Promise.resolve({ reportUrl: '/assets/tx-analysis-failure-base.json' });
        },
      },
    });

    await expect(provider.analyze({ chain: 'base', txHash: evmTx })).rejects.toMatchObject({
      reason: 'screenshot_unavailable',
      reportUrl: '/assets/tx-analysis-failure-base.json',
    });
    expect(failureWrites).toEqual([
      {
        message: '浏览器取证未生成 XXYY 原页面截图。',
        metadata: {
          contractAddress: '0xToken000000000000000000000000000000000000',
          explorerUrl: `https://basescan.org/tx/${evmTx}`,
          poolAddress: '0xPool0000000000000000000000000000000000000',
          relatedTransactions: [
            {
              explorerUrl: `https://basescan.org/tx/${evmTx}`,
              hash: evmTx,
              role: 'user',
              side: 'buy',
              summary: 'target buy without screenshot',
              timestamp: targetTimestamp,
              traderAddress: '0xUser0000000000000000000000000000000000000',
            },
          ],
          targetTradeSide: 'buy',
          targetTraderAddress: '0xUser0000000000000000000000000000000000000',
          transactionTime: targetTimestamp,
          xxyyPoolUrl: 'https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
        },
        reason: 'screenshot_unavailable',
        reference: { chain: 'base', txHash: evmTx },
      },
    ]);
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

function sandwichedEvmSnapshot(evmTx: string): BrowserEvmTxSnapshot {
  return {
    contractAddress: '0xToken000000000000000000000000000000000000',
    explorerUrl: `https://basescan.org/tx/${evmTx}`,
    poolAddress: '0xPool0000000000000000000000000000000000000',
    screenshotTargetRowMarked: true,
    screenshotUrl: '/assets/tx-analysis-base-window.png',
    targetTrade: {
      hash: evmTx,
      poolAddress: '0xPool0000000000000000000000000000000000000',
      side: 'buy',
      summary: 'target buy',
      timestamp: new Date(Date.UTC(2026, 5, 10, 1, 0, 10)).toISOString(),
      traderAddress: '0xUser0000000000000000000000000000000000000',
    },
    tradeWindow: {
      after: [
        trade('0xback1', 'sell', '0xAttacker100000000000000000000000000000000', 11),
        trade('0xafter2', 'buy', '0xOtherAfter20000000000000000000000000000', 12),
        trade('0xafter3', 'sell', '0xOtherAfter3000000000000000000000000000', 13),
        trade('0xafter4', 'buy', '0xOtherAfter40000000000000000000000000000', 14),
        trade('0xafter5', 'sell', '0xOtherAfter5000000000000000000000000000', 15),
      ],
      before: [
        trade('0xfront1', 'buy', '0xAttacker100000000000000000000000000000000', 9),
        trade('0xbefore2', 'sell', '0xOtherBefore200000000000000000000000000', 6),
        trade('0xbefore3', 'buy', '0xOtherBefore3000000000000000000000000000', 7),
        trade('0xbefore4', 'sell', '0xOtherBefore400000000000000000000000000', 8),
        trade('0xbefore5', 'buy', '0xOtherBefore5000000000000000000000000000', 9),
      ],
    },
  };
}

function tradeInPool(
  hash: string,
  side: 'buy' | 'sell',
  traderAddress: string,
  secondsAfterStart: number,
  poolAddress: string,
) {
  return {
    ...trade(hash, side, traderAddress, secondsAfterStart),
    poolAddress,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, reject, resolve };
}
