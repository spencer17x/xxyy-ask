import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  calculateXxyyOriginalTargetRowY,
  calculateInitialXxyyOriginalTargetPosition,
  createXxyyOriginalTradeRowSelector,
  createXxyyTargetTimeSearchWindow,
  buildEvmExplorerTxUrl,
  buildXxyyEvmPoolUrl,
  buildXxyyTradeWindow,
  buildXxyySolPoolUrl,
  calculateXxyyOriginalTradeScrollTop,
  createEvmExplorerFailureMetadata,
  createXxyyTradeWindowQueryUnavailableError,
  createSolanaExplorerFailureMetadata,
  evmPoolCandidates,
  extractEvmAddressAfterLabel,
  extractEvmContractAddress,
  extractEvmPoolAddressFromExplorerText,
  extractEvmPoolAddressesFromExplorerText,
  extractEvmRouterAddressFromExplorerText,
  extractEvmTransactionFromAddress,
  extractEvmTransactionTime,
  extractLastPathSegment,
  extractSolanaExplorerTransactionTime,
  extractSolanaFmTransactionTime,
  inferEvmTradeSide,
  extractSolanaFmPoolCandidates,
  extractXxyyPoolAddressFromUrl,
  isExpectedXxyyEvmPoolUrl,
  openXxyyEvmPoolPage,
  openXxyyPoolPage,
  requireLocatedXxyyTradeWindow,
  selectEvmContractTokenCandidate,
  selectXxyyPoolCandidate,
  parseSolscanTransactionTime,
  queryXxyyTradeWindow,
  selectXxyyOriginalTargetRowCandidate,
  selectMatchingSearchItemIndex,
  xxyyTransactionHashMatches,
} from './playwright-browser-tx-driver.js';
import { TxAnalysisProviderUnavailableError } from './tx-analysis.js';

const SOLANA_TX =
  '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

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

describe('buildEvmExplorerTxUrl', () => {
  it('builds the public explorer URL for supported EVM chains', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(buildEvmExplorerTxUrl('base', txHash)).toBe(`https://basescan.org/tx/${txHash}`);
    expect(buildEvmExplorerTxUrl('ethereum', txHash)).toBe(`https://etherscan.io/tx/${txHash}`);
    expect(buildEvmExplorerTxUrl('bsc', txHash)).toBe(`https://bscscan.com/tx/${txHash}`);
  });
});

describe('extractEvmTransaction', () => {
  it('falls back to Base Blockscout when BaseScan navigation fails transiently', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        contractAddress?: string;
        explorerUrl?: string;
        signerAddress?: string;
      }>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        if (url.includes('basescan.org')) {
          return Promise.reject(new Error('BaseScan page.goto: ERR_EMPTY_RESPONSE'));
        }

        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash
              ${txHash}
              From
              ${signerAddress}
              Token Contract
              Example Meme Token (MEME)
              ${targetToken}
              Timestamp
              2026-06-11 12:00:01 UTC
            `);
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(visitedUrls).toEqual([
      `https://basescan.org/tx/${txHash}`,
      `https://base.blockscout.com/tx/${txHash}`,
    ]);
    expect(result).toMatchObject({
      contractAddress: targetToken,
      explorerUrl: `https://base.blockscout.com/tx/${txHash}`,
      signerAddress,
    });
  });

  it('falls back to Base Blockscout when BaseScan requires browser verification', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        contractAddress?: string;
        explorerUrl?: string;
        signerAddress?: string;
      }>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('basescan.org')) {
              return Promise.resolve('Just a moment Verifying you are human cf-chl challenge');
            }

            return Promise.resolve(`
              Transaction Details
              Transaction Hash
              ${txHash}
              From
              ${signerAddress}
              Token Contract
              Example Meme Token (MEME)
              ${targetToken}
              Timestamp
              2026-06-11 12:00:01 UTC
            `);
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(visitedUrls).toEqual([
      `https://basescan.org/tx/${txHash}`,
      `https://base.blockscout.com/tx/${txHash}`,
    ]);
    expect(result).toMatchObject({
      contractAddress: targetToken,
      explorerUrl: `https://base.blockscout.com/tx/${txHash}`,
      signerAddress,
    });
  });

  it('falls back to Ethereum Blockscout when Etherscan requires browser verification', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        contractAddress?: string;
        explorerUrl?: string;
        signerAddress?: string;
      }>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('etherscan.io')) {
              return Promise.resolve('Just a moment Verifying you are human cf-chl challenge');
            }

            return Promise.resolve(`
              Transaction Details
              Transaction Hash
              ${txHash}
              From
              ${signerAddress}
              Token Contract
              Example Meme Token (MEME)
              ${targetToken}
              Timestamp
              2026-06-11 12:00:01 UTC
            `);
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    const result = await driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, {
      timeoutMs: 1000,
    });

    expect(visitedUrls).toEqual([
      `https://etherscan.io/tx/${txHash}`,
      `https://eth.blockscout.com/tx/${txHash}`,
    ]);
    expect(result).toMatchObject({
      contractAddress: targetToken,
      explorerUrl: `https://eth.blockscout.com/tx/${txHash}`,
      signerAddress,
    });
  });

  it('falls back to BSCTrace when BscScan requires browser verification', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'bsc',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        contractAddress?: string;
        explorerUrl?: string;
        signerAddress?: string;
      }>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('bscscan.com')) {
              return Promise.resolve('Just a moment Verifying you are human cf-chl challenge');
            }

            return Promise.resolve(`
              Transaction Details
              Transaction Hash
              ${txHash}
              From
              ${signerAddress}
              Token Contract
              Example Meme Token (MEME)
              ${targetToken}
              Timestamp
              2026-06-11 12:00:01 UTC
            `);
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    const result = await driverModule.extractEvmTransaction?.(page, 'bsc', txHash, {
      timeoutMs: 1000,
    });

    expect(visitedUrls).toEqual([
      `https://bscscan.com/tx/${txHash}`,
      `https://bsctrace.com/tx/${txHash}`,
    ]);
    expect(result).toMatchObject({
      contractAddress: targetToken,
      explorerUrl: `https://bsctrace.com/tx/${txHash}`,
      signerAddress,
    });
  });

  it('reports provider unavailable when all EVM explorer fallbacks hit transient browser network errors', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const visitedUrls: string[] = [];
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        if (url.includes('basescan.org')) {
          return Promise.reject(new Error('page.goto: ERR_EMPTY_RESPONSE'));
        }

        return Promise.reject(new Error('page.goto: ERR_CONNECTION_ABORTED'));
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve('');
          },
        };
      },
      url() {
        return `https://base.blockscout.com/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      reason: 'provider_unavailable',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([
      `https://basescan.org/tx/${txHash}`,
      `https://base.blockscout.com/tx/${txHash}`,
    ]);
  });

  it('rejects a BSCTrace fallback page that displays a different transaction hash in the details heading', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'bsc',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('bscscan.com')) {
              return Promise.resolve('Just a moment Verifying you are human cf-chl challenge');
            }

            return Promise.resolve(`
              Transaction Hash Details
              ${otherTxHash}
              From
              ${signerAddress}
              Token Contract
              Example Meme Token (MEME)
              ${targetToken}
              Timestamp
              2026-06-11 12:00:01 UTC
            `);
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    let caughtError: unknown;
    try {
      await driverModule.extractEvmTransaction?.(page, 'bsc', txHash, { timeoutMs: 1000 });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const providerError = caughtError as TxAnalysisProviderUnavailableError;
    expect(providerError.message).toContain('BSCTrace');
    expect(providerError).toMatchObject({
      metadata: {
        explorerUrl: `https://bsctrace.com/tx/${txHash}`,
      },
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([
      `https://bscscan.com/tx/${txHash}`,
      `https://bsctrace.com/tx/${txHash}`,
    ]);
  });

  it('rejects a BSCTrace fallback page whose bare Hash field differs from the requested transaction', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'bsc',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('bscscan.com')) {
              return Promise.resolve('Just a moment Verifying you are human cf-chl challenge');
            }

            return Promise.resolve(`
              Transaction Details
              Hash
              ${otherTxHash}
              From
              ${signerAddress}
              Token Contract
              Example Meme Token (MEME)
              ${targetToken}
              Timestamp
              2026-06-11 12:00:01 UTC
            `);
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'bsc', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://bsctrace.com/tx/${txHash}`,
      },
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([
      `https://bscscan.com/tx/${txHash}`,
      `https://bsctrace.com/tx/${txHash}`,
    ]);
  });

  it('keeps browser verification as the EVM explorer failure reason when a fallback times out', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        if (url.includes('eth.blockscout.com')) {
          return Promise.reject(new Error('page.goto: net::ERR_TIMED_OUT'));
        }

        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('etherscan.io')) {
              return Promise.resolve('Just a moment Verifying you are human cf-chl challenge');
            }

            return Promise.resolve('');
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([
      `https://etherscan.io/tx/${txHash}`,
      `https://eth.blockscout.com/tx/${txHash}`,
    ]);
  });

  it('rejects an EVM explorer page that displays a different transaction hash', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'bsc',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash
              ${otherTxHash}
              From
              ${signerAddress}
              Token Contract
              Example Meme Token (MEME)
              ${targetToken}
              Timestamp
              2026-06-11 12:00:01 UTC
            `);
          },
        };
      },
      url() {
        return `https://bscscan.com/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'bsc', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer marks the transaction as failed', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x3333...3333');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Status:
              Fail
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333...3333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        targetTraderAddress: signerAddress,
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer marks the transaction status as failure', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Status:
              Failure
              Transaction Hash:
              ${txHash}
              From:
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer marks the transaction as reverted', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Status:
              Reverted
              Error:
              execution reverted
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://etherscan.io/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer only says Transaction Reverted', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Reverted
              Transaction Hash:
              ${txHash}
              From:
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://etherscan.io/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer says the transaction has been reverted', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              This transaction has been reverted.
              Transaction Hash:
              ${txHash}
              From:
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://etherscan.io/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('preserves tx_failed when EVM explorer link collection fails', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.reject(new Error('anchor collection failed'));
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Status:
              Fail
              Transaction Hash:
              ${txHash}
              From:
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer exposes receipt status zero', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'bsc',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Receipt Status:
              0
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://bscscan.com/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'bsc', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://bscscan.com/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer exposes hex receipt failure status', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Receipt Status:
              0x0
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer exposes a compact failed status value', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Status:
              0x0
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Token Contract:
              0x2222222222222222222222222222222222222222
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer exposes false receipt status', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Receipt Status:
              false
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://etherscan.io/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer exposes success false', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Success:
              false
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer exposes isError one', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'bsc',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              isError:
              1
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://bscscan.com/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'bsc', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://bscscan.com/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer exposes an error status', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Status:
              Error
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://etherscan.io/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer exposes an error result', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
              Result:
              Error
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://etherscan.io/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer exposes an unsuccessful status', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Receipt Status:
              Unsuccessful
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://etherscan.io/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_pending when the EVM explorer exposes a pending status', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x3333...3333');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Receipt Status:
              Pending
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333...3333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        targetTraderAddress: signerAddress,
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_pending when the EVM explorer exposes a pending result', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x3333...3333');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333...3333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
              Result:
              Pending
              Block:
              Waiting
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        targetTraderAddress: signerAddress,
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_pending when the EVM explorer marks the transaction as cancelled', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x3333...3333');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Status:
              Cancelled
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333...3333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://etherscan.io/tx/${txHash}`,
        targetTraderAddress: signerAddress,
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_pending when the EVM explorer exposes an awaiting confirmation status', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x3333...3333');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Status:
              Awaiting Confirmation
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333...3333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        targetTraderAddress: signerAddress,
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_pending when the EVM explorer title says pending transaction', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x3333...3333');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Pending Transaction
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333...3333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://etherscan.io/tx/${txHash}`,
        targetTraderAddress: signerAddress,
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_pending when the EVM explorer says the transaction is in the mempool', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x3333...3333');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              This transaction is in the mempool and has not yet been mined.
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333...3333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://etherscan.io/tx/${txHash}`,
        targetTraderAddress: signerAddress,
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when the EVM explorer reports a contract execution error', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Error encountered during contract execution [out of gas]
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              0x3333333333333333333333333333333333333333
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractEvmTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractEvmTransaction?.(page, 'base', txHash, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        targetTraderAddress: '0x3333333333333333333333333333333333333333',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('uses decoded input address fields to infer EVM side when token link text is unavailable', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string; side?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              0x3333333333333333333333333333333333333333
              Token Contract:
              ${targetToken}
              Decoded Input Data
              tokenIn:${quoteToken}
              tokenOut:${targetToken}
              fee 3000
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
    expect(result?.side).toBe('buy');
  });

  it('uses EVM token transfer rows to infer side when action text is unavailable', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string; side?: string; signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract:
              Example Meme Token (MEME)
              ${targetToken}
              ERC-20 Tokens Transferred
              From
              Uniswap V2: Pair
              ${poolAddress}
              To
              ${signerAddress}
              For
              1,200 MEME
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
    expect(result?.signerAddress).toBe(signerAddress);
    expect(result?.side).toBe('buy');
  });

  it('uses ERC-20 Token Transfers sections to infer EVM side', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string; side?: string; signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract:
              Example Meme Token (MEME)
              ${targetToken}
              ERC-20 Token Transfers
              From
              Uniswap V2: Pair
              ${poolAddress}
              To
              ${signerAddress}
              For
              1,200 MEME
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
    expect(result?.signerAddress).toBe(signerAddress);
    expect(result?.side).toBe('buy');
  });

  it('uses Amount labels in EVM token transfer rows to infer side', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'bsc',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string; side?: string; signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract:
              Example Meme Token (MEME)
              ${targetToken}
              Tokens Transferred
              From
              PancakeSwap V2: Pair
              ${poolAddress}
              To
              ${signerAddress}
              Amount
              1,200 MEME
            `);
          },
        };
      },
      url() {
        return `https://bscscan.com/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'bsc', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
    expect(result?.signerAddress).toBe(signerAddress);
    expect(result?.side).toBe('buy');
  });

  it('uses colon-labeled EVM token transfer rows to infer side', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'bsc',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string; side?: string; signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract:
              Example Meme Token (MEME)
              ${targetToken}
              Tokens Transferred
              From:
              PancakeSwap V2: Pair
              ${poolAddress}
              To:
              ${signerAddress}
              For:
              1,200 MEME
            `);
          },
        };
      },
      url() {
        return `https://bscscan.com/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'bsc', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
    expect(result?.signerAddress).toBe(signerAddress);
    expect(result?.side).toBe('buy');
  });

  it('uses Quantity labels in EVM token transfer rows to infer side', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'ethereum',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string; side?: string; signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract:
              Example Meme Token (MEME)
              ${targetToken}
              Token Transfers
              From
              ${signerAddress}
              To
              Uniswap V2: Pair
              ${poolAddress}
              Quantity
              1,200 MEME
            `);
          },
        };
      },
      url() {
        return `https://etherscan.io/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'ethereum', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
    expect(result?.signerAddress).toBe(signerAddress);
    expect(result?.side).toBe('sell');
  });

  it('uses amount-first EVM token transfer rows to infer side', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'bsc',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string; side?: string; signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract (BEP-20):
              Example Meme Token (MEME)
              ${targetToken}
              Pair:
              ${poolAddress}
              BEP-20 Token Transfers
              Transferred 1,200 MEME From PancakeSwap V2: Pair ${poolAddress} To ${signerAddress}
            `);
          },
        };
      },
      url() {
        return `https://bscscan.com/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'bsc', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
    expect(result?.signerAddress).toBe(signerAddress);
    expect(result?.side).toBe('buy');
  });

  it('uses parsed EVM pool addresses to infer transfer-row side when the row has no pool label', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string; poolAddress?: string; side?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract:
              Example Meme Token (MEME)
              ${targetToken}
              Decoded Input Data
              poolAddress
              ${poolAddress}
              amount0In
              Tokens Transferred
              From
              ${poolAddress}
              To
              ${signerAddress}
              For
              1,200 MEME
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
    expect(result?.poolAddress).toBe(poolAddress);
    expect(result?.side).toBe('buy');
  });

  it('treats target token transfer rows from signer to a parsed pool address as an EVM sell', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string; poolAddress?: string; side?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract:
              Example Meme Token (MEME)
              ${targetToken}
              Decoded Input Data
              poolAddress
              ${poolAddress}
              amountOutMin
              Tokens Transferred
              From
              ${signerAddress}
              To
              ${poolAddress}
              For
              1,200 MEME
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
    expect(result?.poolAddress).toBe(poolAddress);
    expect(result?.side).toBe('sell');
  });

  it('treats target token transfer rows from signer to a pool as an EVM sell', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string; side?: string; signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract:
              Example Meme Token (MEME)
              ${targetToken}
              Tokens Transferred
              From
              ${signerAddress}
              To
              PancakeSwap V2: Pair
              ${poolAddress}
              For
              1,200 MEME
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
    expect(result?.signerAddress).toBe(signerAddress);
    expect(result?.side).toBe('sell');
  });

  it('uses EVM explorer body text when link collection fails', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        contractAddress?: string;
        poolAddress?: string;
        side?: string;
        signerAddress?: string;
        transactionTime?: string;
      }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.reject(new Error('anchor collection failed'));
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract:
              Example Meme Token (MEME)
              ${targetToken}
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
              Uniswap V2 Pair
              ${poolAddress}
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      contractAddress: targetToken,
      poolAddress,
      side: 'buy',
      signerAddress,
      transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
    });
  });

  it('uses address link hrefs when the EVM explorer renders the pool address abbreviated', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ poolAddress?: string; poolCandidates?: Array<{ address: string }> }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${poolAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x4444...4444');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token (MEME)');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
              Tokens Transferred
              Uniswap V2 Pair
              0x4444...4444
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.poolAddress).toBe(poolAddress);
    expect(result?.poolCandidates).toEqual([{ address: poolAddress }]);
  });

  it('uses address link hrefs when the EVM explorer renders an abbreviated pool address before the pool label', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ poolAddress?: string; poolCandidates?: Array<{ address: string }> }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${poolAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x4444...4444');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token (MEME)');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
              Tokens Transferred
              0x4444...4444
              Address Label: PancakeSwap V2 LP
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.poolAddress).toBe(poolAddress);
    expect(result?.poolCandidates).toEqual([{ address: poolAddress }]);
  });

  it('uses LP token hrefs as EVM pool candidates without treating them as the target token', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        contractAddress?: string;
        poolAddress?: string;
        poolCandidates?: Array<{ address: string }>;
        side?: string;
      }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${poolAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('Uniswap V2: Pair 0x4444...4444');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token (MEME)');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Timestamp
              Jun-11-2026 12:00:01 PM +UTC
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
              ERC-20 Token Transfers
              From Uniswap V2: Pair 0x4444...4444
              To ${signerAddress}
              For 1200 MEME
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      contractAddress: targetToken,
      poolAddress,
      poolCandidates: [{ address: poolAddress }],
      side: 'buy',
    });
  });

  it('uses address link hrefs when the EVM explorer renders the token contract address abbreviated', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ contractAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('0x2222...2222');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract (ERC-20)
              Example Meme Token (MEME)
              0x2222...2222
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.contractAddress).toBe(targetToken);
  });

  it('uses token contract text near an href-completed contract address to infer EVM side', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ side?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('0x2222...2222');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Token Contract
              Example Meme Token (MEME)
              0x2222...2222
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.side).toBe('buy');
  });

  it('uses address link hrefs when the EVM explorer renders the router address abbreviated', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const routerAddress = '0x5555555555555555555555555555555555555555';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ routerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${routerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x5555...5555');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token (MEME)');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              ${signerAddress}
              Interacted With (To)
              0x5555...5555
              Contract Name: SwapRouter02
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.routerAddress).toBe(routerAddress);
  });

  it('uses address link hrefs when the EVM explorer renders the From address abbreviated', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x3333...3333');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token (MEME)');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              0x3333...3333
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.signerAddress).toBe(signerAddress);
  });

  it('uses address link hrefs when the EVM explorer renders the From address with two-dot abbreviation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x3333...3333');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token (MEME)');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              0x3333..3333
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.signerAddress).toBe(signerAddress);
  });

  it('uses address link hrefs when the EVM explorer spaces around an abbreviated From address ellipsis', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Wallet');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token (MEME)');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              0x3333 .. 3333
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.signerAddress).toBe(signerAddress);
  });

  it('uses address link hrefs when the EVM explorer renders only a From wallet label', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'base',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Wallet');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token (MEME)');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              From:
              Example Wallet
              Transaction Action
              Swap 0.5 ETH For 1200 MEME On Uniswap V2
            `);
          },
        };
      },
      url() {
        return `https://basescan.org/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'base', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.signerAddress).toBe(signerAddress);
  });

  it('uses address link hrefs when the EVM explorer renders the Sender address abbreviated', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractEvmTransaction?: (
        page: unknown,
        chain: 'bsc',
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ signerAddress?: string }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/address/${signerAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('0x3333...3333');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${targetToken}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token (MEME)');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Transaction Hash:
              ${txHash}
              Sender:
              0x3333...3333
              Transaction Action
              Swap 0.5 BNB For 1200 MEME On PancakeSwap V2
            `);
          },
        };
      },
      url() {
        return `https://bscscan.com/tx/${txHash}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    const result = await driverModule.extractEvmTransaction?.(page, 'bsc', txHash, {
      timeoutMs: 1000,
    });

    expect(result?.signerAddress).toBe(signerAddress);
  });
});

describe('extractSolanaTransaction', () => {
  it('extracts current Solscan transaction details with Block & Timestamp text', async () => {
    const tokenMint = 'EJRwywQTDNC7Fe56EE7CB8hgav7DmXJbC2nC1iBtpump';
    const poolAddress = '3BKpH1vZ55nNwztYy9YRtRXDbrVq1aQZbXVCz7q6j5AM';
    const signerAddress = 'EJLVo2EZ3kYnBgL7RyTPd7ZC8DBK9YWiXwfLvsmVcxhA';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        contractAddress?: string;
        poolAddress?: string;
        signerAddress?: string;
        transactionTime?: string;
      }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${tokenMint}`);
                  },
                  innerText() {
                    return Promise.resolve('BRIM');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/account/${poolAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('Pump.fun AMM');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              OkxDex: Swap
              Summary
              Swap
              20,000
              BRIM
              for
              4.347093
              CASH
              on
              OKX: DEX Router
              Signature
              ${SOLANA_TX}
              Block & Timestamp
              425484076
              3 days ago
              05:41:34 Jun 10, 2026 (UTC)
              Result
              SUCCESS
              Finalized (MAX Confirmations)
              Signer
              ${signerAddress}
              Transaction Actions
              14 Transfer(s)
              Swap
              12,200
              BRIM
              for
              0.041573611
              WSOL
              on
              Pump.fun AMM
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(page, SOLANA_TX, {
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      contractAddress: tokenMint,
      poolAddress,
      signerAddress,
      transactionTime: '05:41:34 Jun 10, 2026 (UTC)',
    });
  });

  it('rejects public Solana explorer pages that display a different signature', async () => {
    const otherSignature = `${SOLANA_TX.slice(0, -1)}J`;
    const signerAddress = 'EJLVo2EZ3kYnBgL7RyTPd7ZC8DBK9YWiXwfLvsmVcxhA';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Details
              Signature
              ${otherSignature}
              Result
              SUCCESS
              Signer
              ${signerAddress}
              Block & Timestamp
              425484076
              05:41:34 Jun 10, 2026 (UTC)
              ${currentUrl.includes('solana.fm') ? 'Interacted with program 11111111111111111111111111111111' : ''}
            `);
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      reason: 'tx_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([
      `https://solscan.io/tx/${SOLANA_TX}`,
      `https://explorer.solana.com/tx/${SOLANA_TX}`,
      `https://solana.fm/tx/${SOLANA_TX}`,
    ]);
  });

  it('uses Solscan AMM account links as pool candidates', async () => {
    const tokenMint = '7vfCXTUXx5WJVd5JBF6FBfWDVYVDN2S7dczp4s1TCtci';
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';
    const signerAddress = '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        contractAddress?: string;
        poolAddress?: string;
        poolCandidates?: Array<{ address: string }>;
        signerAddress?: string;
      }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${tokenMint}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/account/${poolAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('Raydium AMM ID');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Signature
              ${SOLANA_TX}
              Signer
              ${signerAddress}
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
              Program
              Raydium AMM
              Swap
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(page, SOLANA_TX, {
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      contractAddress: tokenMint,
      poolAddress,
      poolCandidates: [{ address: poolAddress }],
      signerAddress,
    });
  });

  it('fills missing Solscan pool details from Solana RPC Pump AMM instructions', async () => {
    const tokenMint = '66pQgfLHEfbHSBgYSZSrKEdJHHaGiYbgCtNbz48Apump';
    const poolAddress = 'HZyqZRuAUCLdJaHqBfnoFHVBwXmuH3Sm1LyXnWu8Ee15';
    const signerAddress = 'B1d1V7FosamHHNgXpL7ZHpiKW4cdNeejXaiGDHWFoJfG';
    const rpcCalls: unknown[] = [];
    const fetch = vi.fn((input: string, init?: { body?: string }) => {
      rpcCalls.push({ input, body: init?.body });
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve({
            jsonrpc: '2.0',
            result: {
              blockTime: 1782270375,
              meta: {
                err: null,
                innerInstructions: [
                  {
                    index: 5,
                    instructions: [
                      {
                        accounts: [
                          poolAddress,
                          signerAddress,
                          'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw',
                          tokenMint,
                          'So11111111111111111111111111111111111111112',
                        ],
                        programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
                      },
                    ],
                  },
                ],
                postTokenBalances: [
                  {
                    accountIndex: 1,
                    mint: tokenMint,
                    owner: signerAddress,
                    uiTokenAmount: { amount: '152290841622', decimals: 6 },
                  },
                ],
                preTokenBalances: [
                  {
                    accountIndex: 1,
                    mint: tokenMint,
                    owner: signerAddress,
                    uiTokenAmount: { amount: '0', decimals: 6 },
                  },
                ],
              },
              transaction: {
                message: {
                  accountKeys: [{ pubkey: signerAddress, signer: true }],
                  instructions: [],
                },
              },
            },
          });
        },
      });
    });
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { fetch?: typeof fetch; solanaRpcUrl?: string; timeoutMs?: number },
      ) => Promise<{
        contractAddress?: string;
        poolAddress?: string;
        poolCandidates?: Array<{ address: string }>;
        side?: string;
        signerAddress?: string;
        transactionTime?: string;
      }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Signature
              ${SOLANA_TX}
              Result
              SUCCESS
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(page, SOLANA_TX, {
      fetch,
      solanaRpcUrl: 'https://rpc.example',
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      contractAddress: tokenMint,
      poolAddress,
      poolCandidates: [{ address: poolAddress }],
      side: 'buy',
      signerAddress,
      transactionTime: '2026-06-24T03:06:15.000Z',
    });
    expect(rpcCalls).toHaveLength(1);
  });

  it('uses Solscan Fee Payer labels as the signer address', async () => {
    const tokenMint = '7vfCXTUXx5WJVd5JBF6FBfWDVYVDN2S7dczp4s1TCtci';
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';
    const signerAddress = '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        signerAddress?: string;
      }>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([
                {
                  getAttribute() {
                    return Promise.resolve(`/token/${tokenMint}`);
                  },
                  innerText() {
                    return Promise.resolve('Example Meme Token');
                  },
                },
                {
                  getAttribute() {
                    return Promise.resolve(`/account/${poolAddress}`);
                  },
                  innerText() {
                    return Promise.resolve('Raydium AMM ID');
                  },
                },
              ]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Signature
              ${SOLANA_TX}
              Fee Payer
              ${signerAddress}
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
              Program
              Raydium AMM
              Swap
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(page, SOLANA_TX, {
      timeoutMs: 1000,
    });

    expect(result?.signerAddress).toBe(signerAddress);
  });

  it('falls back to public Solana explorers when Solscan returns a raw Chrome network error', async () => {
    const signerAddress = '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        signerAddress?: string;
      }>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        if (url.includes('solscan.io')) {
          return Promise.reject(new Error('Solscan page.goto: ERR_EMPTY_RESPONSE'));
        }

        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('explorer.solana.com')) {
              return Promise.resolve(`
                Transaction Details
                Signature
                ${SOLANA_TX}
                Fee payer
                ${signerAddress}
                Timestamp
                12:00:01 Jun 11, 2026 (UTC)
              `);
            }

            return Promise.resolve('No extra SolanaFM context');
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(page, SOLANA_TX, {
      timeoutMs: 1000,
    });

    expect(visitedUrls).toEqual([
      `https://solscan.io/tx/${SOLANA_TX}`,
      `https://explorer.solana.com/tx/${SOLANA_TX}`,
      `https://solana.fm/tx/${SOLANA_TX}`,
    ]);
    expect(result).toMatchObject({ signerAddress });
  });

  it('extracts Solana Explorer fallback fee payer labels with capitalization and a colon', async () => {
    const signerAddress = '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A';
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        signerAddress?: string;
      }>;
    };
    const page = {
      goto(url: string) {
        currentUrl = url;
        if (url.includes('solscan.io')) {
          return Promise.reject(new Error('Solscan page.goto: ERR_EMPTY_RESPONSE'));
        }

        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('explorer.solana.com')) {
              return Promise.resolve(`
                Transaction Details
                Signature
                ${SOLANA_TX}
                Fee Payer:
                ${signerAddress}
                Timestamp
                12:00:01 Jun 11, 2026 (UTC)
              `);
            }

            return Promise.resolve('No extra SolanaFM context');
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(page, SOLANA_TX, {
      timeoutMs: 1000,
    });

    expect(result?.signerAddress).toBe(signerAddress);
  });

  it('extracts SolanaFM fallback fee payer labels as the signer address', async () => {
    const signerAddress = '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A';
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        signerAddress?: string;
      }>;
    };
    const page = {
      goto(url: string) {
        currentUrl = url;
        if (url.includes('solscan.io')) {
          return Promise.reject(new Error('Solscan page.goto: ERR_EMPTY_RESPONSE'));
        }

        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('explorer.solana.com')) {
              return Promise.resolve('No Solana Explorer signer context');
            }

            return Promise.resolve(`
              Transaction
              ${SOLANA_TX}
              Fee Payer:
              ${signerAddress}
              Timestamp
              June 11, 2026 12:00:01 UTC
            `);
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(page, SOLANA_TX, {
      timeoutMs: 1000,
    });

    expect(result?.signerAddress).toBe(signerAddress);
  });

  it('does not use the SolanaFM transaction signature as a signer fallback', async () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        poolAddress?: string;
        signerAddress?: string;
      }>;
    };
    const page = {
      goto(url: string) {
        currentUrl = url;
        if (url.includes('solscan.io')) {
          return Promise.reject(new Error('Solscan page.goto: ERR_EMPTY_RESPONSE'));
        }

        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('explorer.solana.com')) {
              return Promise.resolve('No Solana Explorer signer context');
            }

            return Promise.resolve(`
              Transaction
              ${SOLANA_TX}
              ${poolAddress}
              sent
              0.041573611
              Wrapped SOL
              →
              ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn
            `);
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(page, SOLANA_TX, {
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({ poolAddress });
    expect(result?.signerAddress).toBeUndefined();
  });

  it('falls back to public Solana explorers when Solscan returns a raw Chrome tunnel error', async () => {
    const signerAddress = '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        signerAddress?: string;
      }>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        if (url.includes('solscan.io')) {
          return Promise.reject(new Error('Solscan page.goto: ERR_TUNNEL_CONNECTION_FAILED'));
        }

        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('explorer.solana.com')) {
              return Promise.resolve(`
                Transaction Details
                Signature
                ${SOLANA_TX}
                Fee payer
                ${signerAddress}
                Timestamp
                12:00:01 Jun 11, 2026 (UTC)
              `);
            }

            return Promise.resolve('No extra SolanaFM context');
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(page, SOLANA_TX, {
      timeoutMs: 1000,
    });

    expect(visitedUrls).toEqual([
      `https://solscan.io/tx/${SOLANA_TX}`,
      `https://explorer.solana.com/tx/${SOLANA_TX}`,
      `https://solana.fm/tx/${SOLANA_TX}`,
    ]);
    expect(result).toMatchObject({ signerAddress });
  });

  it('falls back to public Solana explorers when Solscan returns a raw Chrome proxy error', async () => {
    const signerAddress = '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{
        signerAddress?: string;
      }>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        if (url.includes('solscan.io')) {
          return Promise.reject(new Error('Solscan page.goto: ERR_PROXY_CONNECTION_FAILED'));
        }

        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('explorer.solana.com')) {
              return Promise.resolve(`
                Transaction Details
                Signature
                ${SOLANA_TX}
                Fee payer
                ${signerAddress}
                Timestamp
                12:00:01 Jun 11, 2026 (UTC)
              `);
            }

            return Promise.resolve('No extra SolanaFM context');
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(page, SOLANA_TX, {
      timeoutMs: 1000,
    });

    expect(visitedUrls).toEqual([
      `https://solscan.io/tx/${SOLANA_TX}`,
      `https://explorer.solana.com/tx/${SOLANA_TX}`,
      `https://solana.fm/tx/${SOLANA_TX}`,
    ]);
    expect(result).toMatchObject({ signerAddress });
  });

  it('reports tx_failed when Solscan marks the transaction as failed', async () => {
    const visitedUrls: string[] = [];
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Status:
              Failed
              Signature
              ${SOLANA_TX}
              Signer
              7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([`https://solscan.io/tx/${SOLANA_TX}`]);
  });

  it('reports tx_pending when a public Solana fallback marks the transaction as pending', async () => {
    const signerAddress = '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        if (url.includes('solscan.io')) {
          return Promise.reject(new Error('Solscan page.goto: ERR_PROXY_CONNECTION_FAILED'));
        }

        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            if (currentUrl.includes('explorer.solana.com')) {
              return Promise.resolve(`
                Transaction Details
                Status:
                Pending
                Signature
                ${SOLANA_TX}
                Fee payer
                ${signerAddress}
                Timestamp
                12:00:01 Jun 11, 2026 (UTC)
              `);
            }

            return Promise.resolve('SolanaFM should not be visited after pending status');
          },
        };
      },
      url() {
        return currentUrl;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://explorer.solana.com/tx/${SOLANA_TX}`,
        targetTraderAddress: signerAddress,
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([
      `https://solscan.io/tx/${SOLANA_TX}`,
      `https://explorer.solana.com/tx/${SOLANA_TX}`,
    ]);
  });

  it('reports tx_pending when Solscan marks the transaction as pending', async () => {
    const visitedUrls: string[] = [];
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Status:
              Pending
              Signature
              ${SOLANA_TX}
              Signer
              7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([`https://solscan.io/tx/${SOLANA_TX}`]);
  });

  it('reports tx_pending when Solscan marks the transaction as dropped and replaced', async () => {
    const visitedUrls: string[] = [];
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto(url: string) {
        visitedUrls.push(url);
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Status:
              Dropped & Replaced
              Signature
              ${SOLANA_TX}
              Signer
              7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_pending',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([`https://solscan.io/tx/${SOLANA_TX}`]);
  });

  it('reports tx_failed when Solscan exposes compact Err status', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Status:
              Err
              Signature
              ${SOLANA_TX}
              Signer
              7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when Solscan exposes result error status', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Result:
              Error
              Signature
              ${SOLANA_TX}
              Signer
              7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when Solscan only exposes an instruction error', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Instruction Error
              Signature
              ${SOLANA_TX}
              Signer
              7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when Solscan only exposes a program failed message', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Program failed to complete
              Signature
              ${SOLANA_TX}
              Signer
              7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when Solscan only says it failed to process the transaction', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Failed to process transaction
              Signature
              ${SOLANA_TX}
              Signer
              7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when Solscan only exposes compact InstructionError text', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              InstructionError
              Signature
              ${SOLANA_TX}
              Signer
              7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports tx_failed when Solscan exposes a numbered failed instruction', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: unknown,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'a[href]') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve(`
              Transaction Overview
              Instruction #3 Failed
              Signature
              ${SOLANA_TX}
              Signer
              7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A
              Timestamp
              12:00:01 Jun 11, 2026 (UTC)
            `);
          },
        };
      },
      url() {
        return `https://solscan.io/tx/${SOLANA_TX}`;
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    await expect(
      driverModule.extractSolanaTransaction?.(page, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '7GgNg9kX4qPduM8QHmBxbN7Y2VNJvBWfJ5G2W1nq3j8A',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });
});

describe('buildXxyyEvmPoolUrl', () => {
  it('builds direct XXYY pool URLs for supported EVM chains', () => {
    const poolAddress = '0x1234567890abcdef1234567890abcdef12345678';

    expect(buildXxyyEvmPoolUrl('https://www.xxyy.io/discover', 'base', poolAddress)).toBe(
      'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
    );
    expect(buildXxyyEvmPoolUrl('https://www.xxyy.io/discover', 'ethereum', poolAddress)).toBe(
      'https://www.xxyy.io/eth/0x1234567890abcdef1234567890abcdef12345678',
    );
    expect(buildXxyyEvmPoolUrl('https://www.xxyy.io/discover', 'bsc', poolAddress)).toBe(
      'https://www.xxyy.io/bsc/0x1234567890abcdef1234567890abcdef12345678',
    );
  });

  it('normalizes EVM pool address casing in direct XXYY pool URLs', () => {
    const poolAddress = '0xAbCdEf1234567890aBCdEF1234567890ABcDeF12';

    expect(buildXxyyEvmPoolUrl('https://www.xxyy.io/discover', 'base', poolAddress)).toBe(
      'https://www.xxyy.io/base/0xabcdef1234567890abcdef1234567890abcdef12',
    );
  });
});

describe('extractXxyyPoolAddressFromUrl', () => {
  it('extracts Solana and EVM pool addresses from XXYY pool URLs', () => {
    expect(extractXxyyPoolAddressFromUrl('https://www.xxyy.io/sol/Pool111')).toBe('Pool111');
    expect(extractXxyyPoolAddressFromUrl('https://www.xxyy.io/base/0xpool')).toBe('0xpool');
    expect(extractXxyyPoolAddressFromUrl('https://www.xxyy.io/eth/0xpool')).toBe('0xpool');
    expect(extractXxyyPoolAddressFromUrl('https://www.xxyy.io/bsc/0xpool')).toBe('0xpool');
  });

  it('normalizes EVM pool address casing while preserving Solana pool casing', () => {
    expect(extractXxyyPoolAddressFromUrl('https://www.xxyy.io/sol/PoolABC111')).toBe('PoolABC111');
    expect(
      extractXxyyPoolAddressFromUrl(
        'https://www.xxyy.io/base/0xAbCdEf1234567890aBCdEF1234567890ABcDeF12',
      ),
    ).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
  });
});

describe('isExpectedXxyyEvmPoolUrl', () => {
  it('accepts both eth and ethereum route aliases for Ethereum pool pages', () => {
    const poolAddress = '0xAbCdEf1234567890aBCdEF1234567890ABcDeF12';

    expect(
      isExpectedXxyyEvmPoolUrl(
        'https://www.xxyy.io/eth/0xabcdef1234567890abcdef1234567890abcdef12',
        'ethereum',
        poolAddress,
      ),
    ).toBe(true);
    expect(
      isExpectedXxyyEvmPoolUrl(
        'https://www.xxyy.io/ethereum/0xabcdef1234567890abcdef1234567890abcdef12',
        'ethereum',
        poolAddress,
      ),
    ).toBe(true);
  });
});

describe('openXxyyPoolPage', () => {
  it('does not swallow Solana XXYY pool page navigation timeouts', async () => {
    const page = {
      goto() {
        return Promise.reject(new Error('page.goto: net::ERR_TIMED_OUT'));
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return 'https://www.xxyy.io/discover';
      },
    };

    await expect(
      openXxyyPoolPage(
        page as unknown as Parameters<typeof openXxyyPoolPage>[0],
        '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7',
        {
          timeoutMs: 1000,
        },
      ),
    ).rejects.toThrow('net::ERR_TIMED_OUT');
  });

  it('does not swallow EVM XXYY pool page navigation timeouts', async () => {
    const page = {
      goto() {
        return Promise.reject(new Error('page.goto: net::ERR_TIMED_OUT'));
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return 'https://www.xxyy.io/discover';
      },
    };

    await expect(
      openXxyyEvmPoolPage(
        page as unknown as Parameters<typeof openXxyyEvmPoolPage>[0],
        'base',
        '0x1234567890abcdef1234567890abcdef12345678',
        {
          timeoutMs: 1000,
        },
      ),
    ).rejects.toThrow('net::ERR_TIMED_OUT');
  });

  it('detects browser verification on Solana XXYY pool pages even when the route matches', async () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve('Checking if the site connection is secure before proceeding');
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return `https://www.xxyy.io/sol/${poolAddress}`;
      },
    };

    await expect(
      openXxyyPoolPage(page as unknown as Parameters<typeof openXxyyPoolPage>[0], poolAddress, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('detects browser verification on EVM XXYY pool pages even when the route matches', async () => {
    const poolAddress = '0x1234567890abcdef1234567890abcdef12345678';
    const page = {
      goto() {
        return Promise.resolve();
      },
      locator(selector: string) {
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve('Please verify you are not a robot');
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return `https://www.xxyy.io/base/${poolAddress}`;
      },
    };

    await expect(
      openXxyyEvmPoolPage(
        page as unknown as Parameters<typeof openXxyyEvmPoolPage>[0],
        'base',
        poolAddress,
        {
          timeoutMs: 1000,
        },
      ),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });
});

describe('extractXxyyEvmPoolWindow', () => {
  it('keeps EVM explorer metadata when direct XXYY pool navigation times out', async () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const explorer = {
      chain: 'base',
      contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
      poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      poolCandidates: [{ address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
      routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      signerAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      side: 'buy',
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    const page = {
      goto() {
        return Promise.reject(new Error('page.goto: net::ERR_TIMED_OUT'));
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return 'https://www.xxyy.io/discover';
      },
    };
    type FakeEvmPoolWindowPage = typeof page;
    type FakeEvmExplorer = typeof explorer;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyEvmPoolWindow?: (
        page: FakeEvmPoolWindowPage,
        txHash: string,
        explorer: FakeEvmExplorer,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    expect(driverModule.extractXxyyEvmPoolWindow).toBeTypeOf('function');
    await expect(
      driverModule.extractXxyyEvmPoolWindow?.(page, evmTx, explorer, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        targetTraderAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'timeout',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('preserves tx_failed when direct XXYY pool navigation errors contain transaction failure text', async () => {
    const evmTx = '0x1334567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const explorer = {
      chain: 'base',
      contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
      poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      poolCandidates: [{ address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
      routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      signerAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      side: 'buy',
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    const page = {
      goto() {
        return Promise.reject(new Error('page.goto: execution reverted while opening pool'));
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return 'https://www.xxyy.io/discover';
      },
    };
    type FakeEvmPoolFailurePage = typeof page;
    type FakeEvmFailureExplorer = typeof explorer;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyEvmPoolWindow?: (
        page: FakeEvmPoolFailurePage,
        txHash: string,
        explorer: FakeEvmFailureExplorer,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyEvmPoolWindow?.(page, evmTx, explorer, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        targetTraderAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('keeps EVM explorer metadata when direct XXYY pool navigation timeout includes challenge markup', async () => {
    const evmTx = '0x1334567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const explorer = {
      chain: 'base',
      contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
      poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      poolCandidates: [{ address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
      routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      signerAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      side: 'buy',
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    const page = {
      goto() {
        return Promise.reject(
          new Error('page.goto: Timeout 1000ms exceeded while loading cf-turnstile-response'),
        );
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return 'https://www.xxyy.io/discover';
      },
    };
    type FakeEvmPoolWindowPage = typeof page;
    type FakeEvmExplorer = typeof explorer;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyEvmPoolWindow?: (
        page: FakeEvmPoolWindowPage,
        txHash: string,
        explorer: FakeEvmExplorer,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    expect(driverModule.extractXxyyEvmPoolWindow).toBeTypeOf('function');
    await expect(
      driverModule.extractXxyyEvmPoolWindow?.(page, evmTx, explorer, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        targetTraderAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports pool_not_found when EVM contract search does not enter a pool page', async () => {
    const evmTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const explorer = {
      chain: 'base',
      contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
      poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      poolCandidates: [{ address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
      routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      signerAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      side: 'buy',
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    const page = {
      evaluate() {
        return Promise.resolve({ afterTrades: [], beforeTrades: [] });
      },
      goto() {
        currentUrl = 'https://www.xxyy.io/discover';
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeEvmContractSearchPage = typeof page;
    type FakeEvmExplorerForSearch = typeof explorer;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyEvmPoolWindow?: (
        page: FakeEvmContractSearchPage,
        txHash: string,
        explorer: FakeEvmExplorerForSearch,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyEvmPoolWindow?.(page, evmTx, explorer, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        targetTraderAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'pool_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports pool_not_found when EVM contract search enters a pool page on the wrong chain', async () => {
    const evmTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const poolAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const explorer = {
      chain: 'base',
      contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
      poolAddress,
      poolCandidates: [{ address: poolAddress }],
      routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      signerAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      side: 'buy',
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    const searchItem = {
      evaluate() {
        currentUrl = `https://www.xxyy.io/bsc/${poolAddress}`;
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve('Base result 0xbbbb...bbbb');
      },
    };
    const page = {
      evaluate() {
        return Promise.resolve({ afterTrades: [], beforeTrades: [] });
      },
      goto(url: string) {
        currentUrl = url.includes('/base/') ? 'https://www.xxyy.io/discover' : url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([searchItem]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeWrongChainSearchPage = typeof page;
    type FakeWrongChainExplorer = typeof explorer;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyEvmPoolWindow?: (
        page: FakeWrongChainSearchPage,
        txHash: string,
        explorer: FakeWrongChainExplorer,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyEvmPoolWindow?.(page, evmTx, explorer, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        poolAddress,
        routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        targetTraderAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'pool_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports pool_not_found when EVM contract search enters a different pool on the same chain', async () => {
    const evmTx = '0x5234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const expectedPoolAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const routedPoolAddress = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const explorer = {
      chain: 'base',
      contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
      poolAddress: expectedPoolAddress,
      poolCandidates: [{ address: expectedPoolAddress }],
      routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      signerAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      side: 'buy',
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    const searchItem = {
      evaluate() {
        currentUrl = `https://www.xxyy.io/base/${routedPoolAddress}`;
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve('Base result 0xbbbb...bbbb');
      },
    };
    const page = {
      evaluate() {
        return Promise.resolve({ afterTrades: [], beforeTrades: [] });
      },
      goto(url: string) {
        currentUrl = url.includes('/base/') ? 'https://www.xxyy.io/discover' : url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            innerText() {
              return Promise.resolve('XXYY pool page');
            },
          };
        }
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([searchItem]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeDifferentPoolSearchPage = typeof page;
    type FakeDifferentPoolExplorer = typeof explorer;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyEvmPoolWindow?: (
        page: FakeDifferentPoolSearchPage,
        txHash: string,
        explorer: FakeDifferentPoolExplorer,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyEvmPoolWindow?.(page, evmTx, explorer, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        poolAddress: expectedPoolAddress,
        routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        targetTraderAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'pool_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('allows EVM contract search to fall back to the first result when the explorer pool candidate is not an XXYY pool id', async () => {
    const evmTx = '0x6234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const explorerPoolAddress = '0x000000000004444c5dc75cb358380d2e3de08a90';
    const routedPoolAddress = '0x35650bdc37864a3fdca76cb979fabc8b12ffd7b9015e0d1b5d8e03afae05a041';
    const explorer = {
      chain: 'ethereum',
      contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      explorerUrl: `https://eth.blockscout.com/tx/${evmTx}`,
      poolAddress: explorerPoolAddress,
      poolCandidates: [{ address: explorerPoolAddress }],
      routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      signerAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      side: 'buy',
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    const searchItem = {
      evaluate() {
        currentUrl = `https://www.xxyy.io/eth/${routedPoolAddress}`;
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve('WCUP/WETH Token: 0xaaaa...aaaa Pair: 0x3565...a041');
      },
    };
    const page = {
      evaluate() {
        return Promise.resolve({
          afterTrades: [],
          beforeTrades: [],
          targetTrade: {
            maker: '0xdddddddddddddddddddddddddddddddddddddddd',
            timestamp: 1718064001000,
            txHash: evmTx,
            type: 'buy',
          },
        });
      },
      goto(url: string) {
        currentUrl = url.includes('/eth/') ? 'https://www.xxyy.io/discover' : url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            innerText() {
              return Promise.resolve('XXYY pool page');
            },
          };
        }
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([searchItem]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    const screenshotDir = await mkdtemp(path.join(tmpdir(), 'xxyy-evm-search-fallback-'));
    type FakeEvmFallbackSearchPage = typeof page;
    type FakeEvmFallbackExplorer = typeof explorer;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyEvmPoolWindow?: (
        page: FakeEvmFallbackSearchPage,
        txHash: string,
        explorer: FakeEvmFallbackExplorer,
        options: { screenshotDir?: string; timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyEvmPoolWindow?.(page, evmTx, explorer, {
        screenshotDir,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        poolAddress: routedPoolAddress,
        relatedTransactions: [
          {
            hash: evmTx,
            role: 'user',
            summary: 'XXYY buy',
          },
        ],
      },
      reason: 'screenshot_unavailable',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports browser_verification_required when EVM contract search enters a verification pool page', async () => {
    const evmTx = '0x4234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const poolAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const explorer = {
      chain: 'base',
      contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      explorerUrl: `https://basescan.org/tx/${evmTx}`,
      poolAddress,
      poolCandidates: [{ address: poolAddress }],
      routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      signerAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      side: 'buy',
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    let verificationPage = false;
    const searchItem = {
      evaluate() {
        currentUrl = `https://www.xxyy.io/base/${poolAddress}`;
        verificationPage = true;
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve('Base result 0xbbbb...bbbb');
      },
    };
    const page = {
      evaluate() {
        return Promise.resolve({ afterTrades: [], beforeTrades: [] });
      },
      goto(url: string) {
        currentUrl = url.includes('/base/') ? 'https://www.xxyy.io/discover' : url;
        verificationPage = false;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            innerText() {
              return Promise.resolve(
                verificationPage ? 'Please verify you are not a robot' : 'XXYY Discover',
              );
            },
          };
        }
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([searchItem]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeVerificationPoolSearchPage = typeof page;
    type FakeVerificationPoolExplorer = typeof explorer;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyEvmPoolWindow?: (
        page: FakeVerificationPoolSearchPage,
        txHash: string,
        explorer: FakeVerificationPoolExplorer,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyEvmPoolWindow?.(page, evmTx, explorer, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        poolAddress,
        routerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        targetTraderAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('uses the EVM native symbol after contract-search pool routing', async () => {
    const evmTx = '0x6234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const poolAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const explorer = {
      chain: 'bsc' as const,
      contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      explorerUrl: `https://bsctrace.com/tx/${evmTx}`,
      poolCandidates: [],
      signerAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      side: 'buy' as const,
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    const chainItem = {
      evaluate() {
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve('BSC');
      },
    };
    const searchItem = {
      evaluate() {
        currentUrl = `https://www.xxyy.io/bsc/${poolAddress}`;
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve(`BSC pair ${poolAddress}`);
      },
    };
    const page = {
      evaluate() {
        return Promise.resolve({
          afterTrades: [],
          beforeTrades: [],
          targetTrade: {
            maker: '0xdddddddddddddddddddddddddddddddddddddddd',
            nativeAmount: '0.25',
            timestamp: 1718064001000,
            txHash: evmTx,
            type: 'buy',
          },
        });
      },
      goto(url: string) {
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            innerText() {
              return Promise.resolve('XXYY pool page');
            },
          };
        }
        if (selector === '.chain-menu .menu-item') {
          return {
            all() {
              return Promise.resolve([chainItem]);
            },
          };
        }
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([searchItem]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    const screenshotDir = await mkdtemp(path.join(tmpdir(), 'xxyy-evm-native-symbol-'));
    type FakeContractSearchSuccessPage = typeof page;
    type FakeBscExplorer = typeof explorer;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyEvmPoolWindow?: (
        page: FakeContractSearchSuccessPage,
        txHash: string,
        explorer: FakeBscExplorer,
        options: { screenshotDir?: string; timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyEvmPoolWindow?.(page, evmTx, explorer, {
        screenshotDir,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        relatedTransactions: [
          {
            hash: evmTx,
            role: 'user',
            summary: 'XXYY buy 0.25 BNB',
          },
        ],
      },
      reason: 'screenshot_unavailable',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });
});

describe('extractXxyyPoolWindow', () => {
  it('keeps Solana explorer metadata when direct XXYY pool navigation times out', async () => {
    const solscan = {
      contractAddress: 'So11111111111111111111111111111111111111112',
      poolAddress: '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7',
      poolCandidates: [{ address: '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7' }],
      side: 'buy',
      signerAddress: '11111111111111111111111111111111',
      solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    const page = {
      goto() {
        return Promise.reject(new Error('page.goto: net::ERR_TIMED_OUT'));
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return 'https://www.xxyy.io/discover';
      },
    };
    type FakeSolanaPoolWindowPage = typeof page;
    type FakeSolscan = typeof solscan;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyPoolWindow?: (
        page: FakeSolanaPoolWindowPage,
        txHash: string,
        solscan: FakeSolscan,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    expect(driverModule.extractXxyyPoolWindow).toBeTypeOf('function');
    await expect(
      driverModule.extractXxyyPoolWindow?.(page, SOLANA_TX, solscan, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress: '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7',
        targetTraderAddress: '11111111111111111111111111111111',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'timeout',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports pool_not_found when Solana contract search does not enter a pool page', async () => {
    const solscan = {
      contractAddress: 'So11111111111111111111111111111111111111112',
      poolCandidates: [],
      side: 'buy',
      signerAddress: '11111111111111111111111111111111',
      solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    const page = {
      goto(url: string) {
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeSolanaContractSearchPage = typeof page;
    type FakeSolscanForContractSearch = typeof solscan;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyPoolWindow?: (
        page: FakeSolanaContractSearchPage,
        txHash: string,
        solscan: FakeSolscanForContractSearch,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyPoolWindow?.(page, SOLANA_TX, solscan, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '11111111111111111111111111111111',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'pool_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports browser_verification_required when Solana contract search opens an XXYY verification page', async () => {
    const solscan = {
      contractAddress: 'So11111111111111111111111111111111111111112',
      poolCandidates: [],
      side: 'buy',
      signerAddress: '11111111111111111111111111111111',
      solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    const page = {
      goto(url: string) {
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            innerText() {
              return Promise.resolve('Please verify you are not a robot');
            },
          };
        }
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeSolanaVerificationSearchPage = typeof page;
    type FakeSolscanForVerificationSearch = typeof solscan;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyPoolWindow?: (
        page: FakeSolanaVerificationSearchPage,
        txHash: string,
        solscan: FakeSolscanForVerificationSearch,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyPoolWindow?.(page, SOLANA_TX, solscan, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        targetTraderAddress: '11111111111111111111111111111111',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('reports browser_verification_required when Solana contract search enters a verification pool page', async () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';
    const solscan = {
      contractAddress: 'So11111111111111111111111111111111111111112',
      poolAddress,
      poolCandidates: [],
      side: 'buy',
      signerAddress: '11111111111111111111111111111111',
      solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    let verificationPage = false;
    const searchItem = {
      evaluate() {
        currentUrl = `https://www.xxyy.io/sol/${poolAddress}`;
        verificationPage = true;
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve('Solana result 9hXD...MyJ7');
      },
    };
    const page = {
      evaluate() {
        return Promise.resolve({ afterTrades: [], beforeTrades: [] });
      },
      goto(url: string) {
        currentUrl = url;
        verificationPage = false;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            innerText() {
              return Promise.resolve(
                verificationPage ? 'Please verify you are not a robot' : 'XXYY Discover',
              );
            },
          };
        }
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([searchItem]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeSolanaVerificationPoolPage = typeof page;
    type FakeSolscanForVerificationPool = typeof solscan;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyPoolWindow?: (
        page: FakeSolanaVerificationPoolPage,
        txHash: string,
        solscan: FakeSolscanForVerificationPool,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyPoolWindow?.(page, SOLANA_TX, solscan, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress,
        targetTraderAddress: '11111111111111111111111111111111',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('uses the Solana pool route discovered by contract search for later failure metadata', async () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';
    const solscan = {
      contractAddress: 'So11111111111111111111111111111111111111112',
      poolCandidates: [],
      side: 'buy',
      signerAddress: '11111111111111111111111111111111',
      solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    const searchItem = {
      evaluate() {
        currentUrl = `https://www.xxyy.io/sol/${poolAddress}`;
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve('Solana result 9hXD...MyJ7');
      },
    };
    const page = {
      evaluate() {
        return Promise.resolve({ afterTrades: [], beforeTrades: [] });
      },
      goto(url: string) {
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            innerText() {
              return Promise.resolve('XXYY pool page');
            },
          };
        }
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([searchItem]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeSolanaDiscoveredPoolPage = typeof page;
    type FakeSolscanWithDiscoveredPool = typeof solscan;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyPoolWindow?: (
        page: FakeSolanaDiscoveredPoolPage,
        txHash: string,
        solscan: FakeSolscanWithDiscoveredPool,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyPoolWindow?.(page, SOLANA_TX, solscan, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress,
        targetTraderAddress: '11111111111111111111111111111111',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'target_trade_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
  });

  it('selects the Solana chain before using XXYY contract search fallback', async () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';
    const selectedChains: string[] = [];
    const solscan = {
      contractAddress: 'So11111111111111111111111111111111111111112',
      poolCandidates: [],
      side: 'buy',
      signerAddress: '11111111111111111111111111111111',
      solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    let selectedChain = 'BSC';
    const chainItem = (label: string) => ({
      evaluate() {
        selectedChain = label;
        selectedChains.push(label);
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve(`${label} $1.00`);
      },
    });
    const searchItem = {
      evaluate() {
        currentUrl = `https://www.xxyy.io/sol/${poolAddress}`;
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve('Solana result 9hXD...MyJ7');
      },
    };
    const page = {
      evaluate() {
        return Promise.resolve({ afterTrades: [], beforeTrades: [] });
      },
      goto(url: string) {
        currentUrl = url;
        selectedChain = 'BSC';
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            innerText() {
              return Promise.resolve('XXYY pool page');
            },
          };
        }
        if (selector === '.chain-menu .menu-item') {
          return {
            all() {
              return Promise.resolve([chainItem('SOL'), chainItem('BSC')]);
            },
          };
        }
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve(selectedChain === 'SOL' ? [searchItem] : []);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeSolanaChainSearchPage = typeof page;
    type FakeSolscanWithoutPool = typeof solscan;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyPoolWindow?: (
        page: FakeSolanaChainSearchPage,
        txHash: string,
        solscan: FakeSolscanWithoutPool,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractXxyyPoolWindow?.(page, SOLANA_TX, solscan, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      metadata: {
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress,
        targetTraderAddress: '11111111111111111111111111111111',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'target_trade_not_found',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(selectedChains).toEqual(['SOL']);
  });

  it('adds a failure screenshot when the XXYY pool page is open but the target trade is missing', async () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';
    const screenshotDir = await mkdtemp(path.join(tmpdir(), 'xxyy-target-missing-screenshot-'));
    const screenshotPaths: string[] = [];
    const solscan = {
      contractAddress: 'So11111111111111111111111111111111111111112',
      poolCandidates: [],
      side: 'buy',
      signerAddress: '11111111111111111111111111111111',
      solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    const searchItem = {
      evaluate() {
        currentUrl = `https://www.xxyy.io/sol/${poolAddress}`;
        return Promise.resolve();
      },
      innerText() {
        return Promise.resolve('Solana result 9hXD...MyJ7');
      },
    };
    const page = {
      evaluate() {
        return Promise.resolve({ afterTrades: [], beforeTrades: [] });
      },
      goto(url: string) {
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            innerText() {
              return Promise.resolve('XXYY original pool page with latest trades');
            },
          };
        }
        if (selector === '.search-token-item') {
          return {
            all() {
              return Promise.resolve([searchItem]);
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      screenshot(input: { path: string }) {
        screenshotPaths.push(input.path);
        return Promise.resolve(Buffer.from('png'));
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeMissingTargetScreenshotPage = typeof page;
    type FakeSolscanForMissingTargetScreenshot = typeof solscan;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyPoolWindow?: (
        page: FakeMissingTargetScreenshotPage,
        txHash: string,
        solscan: FakeSolscanForMissingTargetScreenshot,
        options: { screenshotBaseUrl?: string; screenshotDir?: string; timeoutMs?: number },
      ) => Promise<unknown>;
    };

    let caughtError: unknown;
    try {
      await driverModule.extractXxyyPoolWindow?.(page, SOLANA_TX, solscan, {
        screenshotBaseUrl: '/failure-shots',
        screenshotDir,
        timeoutMs: 1000,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const error = caughtError as TxAnalysisProviderUnavailableError;
    expect(error).toMatchObject({
      metadata: {
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress,
        targetTraderAddress: '11111111111111111111111111111111',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'target_trade_not_found',
    });
    expect(error.metadata?.screenshotUrl).toMatch(
      /^\/failure-shots\/tx-analysis-[a-f0-9]{16}\.png$/u,
    );
    expect(screenshotPaths).toHaveLength(1);
    expect(screenshotPaths[0]).toContain(screenshotDir);
  });

  it('returns screenshot_unavailable with a failure screenshot when the marked original screenshot cannot be generated', async () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';
    const screenshotDir = await mkdtemp(path.join(tmpdir(), 'xxyy-marked-screenshot-failure-'));
    const screenshotPaths: string[] = [];
    const beforeTx =
      '6uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';
    const afterTx =
      '7uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';
    const solscan = {
      contractAddress: 'So11111111111111111111111111111111111111112',
      poolAddress,
      poolCandidates: [{ address: poolAddress }],
      side: 'buy',
      signerAddress: '11111111111111111111111111111111',
      solscanUrl: `https://solscan.io/tx/${SOLANA_TX}`,
      transactionTime: '2026-06-11T12:00:01.000Z',
    };
    let currentUrl = 'https://www.xxyy.io/discover';
    const page = {
      evaluate() {
        return Promise.resolve({
          afterTrades: [
            {
              maker: 'after-trader',
              timestamp: 1781179202000,
              txHash: afterTx,
              type: 'sell',
            },
          ],
          beforeTrades: [
            {
              maker: 'before-trader',
              timestamp: 1781179200000,
              txHash: beforeTx,
              type: 'buy',
            },
          ],
          targetTrade: {
            maker: '11111111111111111111111111111111',
            timestamp: 1781179201000,
            txHash: SOLANA_TX,
            type: 'buy',
          },
        });
      },
      goto(url: string) {
        currentUrl = url;
        return Promise.resolve();
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            innerText() {
              return Promise.resolve('XXYY original pool page');
            },
          };
        }

        return {
          first() {
            return {
              click() {
                return Promise.resolve();
              },
              evaluate() {
                return Promise.resolve();
              },
              screenshot() {
                throw new Error('trade list screenshot should not be reached');
              },
              waitFor() {
                return Promise.reject(new Error(`missing visible selector ${selector}`));
              },
            };
          },
        };
      },
      screenshot(input: { path: string }) {
        screenshotPaths.push(input.path);
        return Promise.resolve(Buffer.from('png'));
      },
      setViewportSize() {
        return Promise.resolve();
      },
      viewportSize() {
        return { height: 720, width: 1280 };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
      url() {
        return currentUrl;
      },
    };
    type FakeMarkedScreenshotFailurePage = typeof page;
    type FakeSolscanForMarkedScreenshotFailure = typeof solscan;
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractXxyyPoolWindow?: (
        page: FakeMarkedScreenshotFailurePage,
        txHash: string,
        solscan: FakeSolscanForMarkedScreenshotFailure,
        options: { screenshotBaseUrl?: string; screenshotDir?: string; timeoutMs?: number },
      ) => Promise<unknown>;
    };

    let caughtError: unknown;
    try {
      await driverModule.extractXxyyPoolWindow?.(page, SOLANA_TX, solscan, {
        screenshotBaseUrl: '/failure-shots',
        screenshotDir,
        timeoutMs: 1000,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    const error = caughtError as TxAnalysisProviderUnavailableError;
    expect(error).toMatchObject({
      metadata: {
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress,
        targetTraderAddress: '11111111111111111111111111111111',
        transactionTime: '2026-06-11T12:00:01.000Z',
      },
      reason: 'screenshot_unavailable',
    });
    expect(error.metadata?.screenshotUrl).toMatch(
      /^\/failure-shots\/tx-analysis-[a-f0-9]{16}\.png$/u,
    );
    expect(error.metadata?.relatedTransactions).toEqual([
      expect.objectContaining({
        explorerUrl: `https://solscan.io/tx/${beforeTx}`,
        hash: beforeTx,
        role: 'related',
      }),
      expect.objectContaining({
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        hash: SOLANA_TX,
        role: 'user',
      }),
      expect.objectContaining({
        explorerUrl: `https://solscan.io/tx/${afterTx}`,
        hash: afterTx,
        role: 'related',
      }),
    ]);
    expect(screenshotPaths).toHaveLength(1);
    expect(screenshotPaths[0]).toContain(screenshotDir);
  });
});

describe('extractLastPathSegment', () => {
  it('ignores query strings and hash fragments on explorer token links', () => {
    expect(
      extractLastPathSegment(
        'https://etherscan.io/token/0x1234567890abcdef1234567890abcdef12345678?a=holder#code',
      ),
    ).toBe('0x1234567890abcdef1234567890abcdef12345678');
  });
});

describe('extractEvmPoolAddressFromExplorerText', () => {
  it('extracts an EVM pool address when the explorer renders the address after a Pair label', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Tokens Transferred:
        From Uniswap V2: Pair 0x1111111111111111111111111111111111111111
        To 0x2222222222222222222222222222222222222222
      `),
    ).toBe('0x1111111111111111111111111111111111111111');
  });

  it('extracts an EVM pool address when the explorer renders the LP label after the address', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Interacted With (To): 0x3333333333333333333333333333333333333333
        Address Label: PancakeSwap V2: LP
      `),
    ).toBe('0x3333333333333333333333333333333333333333');
  });

  it('extracts an EVM pool address when the explorer uses a compact Pair contract label', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        PancakePair
        0x1212121212121212121212121212121212121212
        Swap
      `),
    ).toBe('0x1212121212121212121212121212121212121212');
  });

  it('extracts an EVM pool address when the label and address are separated by an Address row', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Tokens Transferred:
        Uniswap V3: Pool
        Address
        0x5555555555555555555555555555555555555555
      `),
    ).toBe('0x5555555555555555555555555555555555555555');
  });

  it('extracts an EVM pool address when token pair text appears between the pool label and address row', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Tokens Transferred:
        Uniswap V3: Pool
        MEME / WETH 0.3%
        Address
        0x4545454545454545454545454545454545454545
      `),
    ).toBe('0x4545454545454545454545454545454545454545');
  });

  it('extracts an EVM pool address from a Swap event emitter Address row', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Swap
        Address
        0x9090909090909090909090909090909090909090
        Topics
        amount0In
      `),
    ).toBe('0x9090909090909090909090909090909090909090');
  });

  it('extracts an EVM pool address from Swap event emitter labels', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Swap
        Emitted by
        0x9191919191919191919191919191919191919191
        Topics
        amount0In
      `),
    ).toBe('0x9191919191919191919191919191919191919191');
  });

  it('extracts an EVM pool address from Swap event emitted-from labels', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Swap
        Emitted from
        0x9292929292929292929292929292929292929292
        Topics
        amount1Out
      `),
    ).toBe('0x9292929292929292929292929292929292929292');
  });

  it('extracts an EVM pool address from event field names such as poolAddress', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Swap
        poolAddress
        0x6666666666666666666666666666666666666666
        recipient
        0x7777777777777777777777777777777777777777
      `),
    ).toBe('0x6666666666666666666666666666666666666666');
  });

  it('extracts an EVM pool address from snake case pair address fields', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        pair_address: 0x8888888888888888888888888888888888888888
        amountIn: 1000000000000000000
      `),
    ).toBe('0x8888888888888888888888888888888888888888');
  });

  it('extracts an EVM pool address from ABI word event fields', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        PairCreated
        pair
        0000000000000000000000002222222222222222222222222222222222222222
      `),
    ).toBe('0x2222222222222222222222222222222222222222');
  });

  it('extracts an EVM pool address from 0x-prefixed ABI word event fields', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Swap
        pool
        0x0000000000000000000000003333333333333333333333333333333333333333
        recipient
        0x4444444444444444444444444444444444444444
      `),
    ).toBe('0x3333333333333333333333333333333333333333');
  });

  it('extracts an EVM pool address from wrapped ABI word event fields', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Swap
        pool
        0x00000000000000000000000033333333333333333333
        33333333333333333333
        recipient
        0x4444444444444444444444444444444444444444
      `),
    ).toBe('0x3333333333333333333333333333333333333333');
  });

  it('extracts an EVM pool address from addr shorthand field names', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        pool_addr: 0x1234567890abcdef1234567890abcdef12345678
        amountIn: 1000000000000000000
      `),
    ).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        pairAddr
        0x8888888888888888888888888888888888888888
      `),
    ).toBe('0x8888888888888888888888888888888888888888');
  });

  it('extracts an EVM pool address from camel case liquidity pool fields', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        liquidityPool
        0x7777777777777777777777777777777777777777
      `),
    ).toBe('0x7777777777777777777777777777777777777777');
  });

  it('extracts an EVM pool address from AMM and market field names', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Swap
        ammAddress
        0x1212121212121212121212121212121212121212
      `),
    ).toBe('0x1212121212121212121212121212121212121212');
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        market_address: 0x3434343434343434343434343434343434343434
      `),
    ).toBe('0x3434343434343434343434343434343434343434');
  });

  it('extracts an EVM pool address from bare AMM and Market labels', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        AMM
        0x1212121212121212121212121212121212121212
      `),
    ).toBe('0x1212121212121212121212121212121212121212');
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        Market
        0x3434343434343434343434343434343434343434
      `),
    ).toBe('0x3434343434343434343434343434343434343434');
  });

  it('does not treat EVM market cap text as a pool label', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Token Overview
        Market Cap
        $42,000,000
        Contract
        0x1212121212121212121212121212121212121212
      `),
    ).toBeUndefined();
  });

  it('extracts an EVM pool address from pair or pool contract field names', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Swap
        pairContract
        0x9999999999999999999999999999999999999999
        poolContract: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      `),
    ).toBe('0x9999999999999999999999999999999999999999');
  });

  it('extracts an EVM pool address from pair or pool id field names', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Swap
        poolId
        0x1010101010101010101010101010101010101010
      `),
    ).toBe('0x1010101010101010101010101010101010101010');
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        pair_id: 0x2020202020202020202020202020202020202020
      `),
    ).toBe('0x2020202020202020202020202020202020202020');
  });

  it('extracts an EVM pool address from leading-underscore pair or pool fields', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        _pool
        0x3030303030303030303030303030303030303030
      `),
    ).toBe('0x3030303030303030303030303030303030303030');
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        _pair: 0x4040404040404040404040404040404040404040
      `),
    ).toBe('0x4040404040404040404040404040404040404040');
  });

  it('extracts an EVM pool address from DEX-prefixed camelCase pair or pool fields', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        PairCreated
        uniswapV2PairAddress
        0xabababababababababababababababababababab
        token0
        0x1111111111111111111111111111111111111111
      `),
    ).toBe('0xabababababababababababababababababababab');
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        uniswapV3PoolAddress: 0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
      `),
    ).toBe('0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd');
  });

  it('extracts an EVM pool address from LP token field names', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        lpToken
        0x3434343434343434343434343434343434343434
      `),
    ).toBe('0x3434343434343434343434343434343434343434');
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        lp_token: 0x5656565656565656565656565656565656565656
      `),
    ).toBe('0x5656565656565656565656565656565656565656');
  });

  it('extracts an EVM pool address from LP token address field names', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        lpTokenAddress
        0x7878787878787878787878787878787878787878
      `),
    ).toBe('0x7878787878787878787878787878787878787878');
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        lp_token_address: 0x8989898989898989898989898989898989898989
      `),
    ).toBe('0x8989898989898989898989898989898989898989');
  });

  it('extracts an EVM pool address from liquidity pool field names', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        liquidityPoolAddress
        0xabababababababababababababababababababab
      `),
    ).toBe('0xabababababababababababababababababababab');
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Decoded Input Data
        liquidity_pool: 0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
      `),
    ).toBe('0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd');
  });

  it('extracts EVM pool addresses from equals and arrow event field separators', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Swap
        pool = 0x4545454545454545454545454545454545454545
        sender = 0x1111111111111111111111111111111111111111
      `),
    ).toBe('0x4545454545454545454545454545454545454545');
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        Sync
        pair => 0x5656565656565656565656565656565656565656
        reserve0 => 100
      `),
    ).toBe('0x5656565656565656565656565656565656565656');
  });

  it('extracts EVM pool addresses when explorer text splits the address with whitespace', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Event Logs
        pairContract
        0x99999999999999999999
        999999999999999999999999
      `),
    ).toBe('0x9999999999999999999999999999999999999999');
  });

  it('extracts ordered unique EVM pool candidates from explorer text', () => {
    expect(
      extractEvmPoolAddressesFromExplorerText(`
        Event Logs
        poolAddress
        0x1111111111111111111111111111111111111111
        pairContract
        0x2222222222222222222222222222222222222222
        Duplicate Pool
        0x1111111111111111111111111111111111111111
      `),
    ).toEqual([
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ]);
  });

  it('does not treat a router address as a pool address without a Pair, Pool, or LP label', () => {
    expect(
      extractEvmPoolAddressFromExplorerText(`
        Interacted With (To): Uniswap V2 Router 0x4444444444444444444444444444444444444444
      `),
    ).toBeUndefined();
  });
});

describe('evmPoolCandidates', () => {
  it('keeps ordered unique EVM pool candidates from explorer extraction', () => {
    expect(
      evmPoolCandidates({
        poolAddress: '0x1111111111111111111111111111111111111111',
        poolCandidates: [
          { address: '0x2222222222222222222222222222222222222222' },
          { address: '0x1111111111111111111111111111111111111111' },
          { address: 'not-an-evm-address' },
        ],
      }),
    ).toEqual([
      { address: '0x2222222222222222222222222222222222222222' },
      { address: '0x1111111111111111111111111111111111111111' },
    ]);
  });
});

describe('extractEvmAddressAfterLabel', () => {
  it('extracts an EVM address when explorer labels use a colon', () => {
    expect(
      extractEvmAddressAfterLabel(
        'Transaction Details From: 0x1234567890abcdef1234567890abcdef12345678 To: 0xRouter',
        'From',
      ),
    ).toBe('0x1234567890abcdef1234567890abcdef12345678');
  });

  it('extracts an EVM address when explorer labels and addresses are split across lines', () => {
    expect(
      extractEvmAddressAfterLabel(
        `
        From
        0xabcdefabcdefabcdefabcdefabcdefabcdefabcd
        To
        0x1111111111111111111111111111111111111111
      `,
        'From',
      ),
    ).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
  });

  it('extracts an EVM address when explorer text wraps the address across lines', () => {
    expect(
      extractEvmAddressAfterLabel(
        `
        From
        0xabcdefabcdefabcdefab
        cdefabcdefabcdefabcd
      `,
        'From',
      ),
    ).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
  });
});

describe('extractEvmTransactionFromAddress', () => {
  it('prefers the transaction detail From address over token transfer From rows', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Tokens Transferred:
        From 0x1111111111111111111111111111111111111111
        To 0x2222222222222222222222222222222222222222
        For 1000 TOKEN

        Transaction Details
        Transaction Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        From
        0x3333333333333333333333333333333333333333
        Interacted With (To)
        0x4444444444444444444444444444444444444444
      `),
    ).toBe('0x3333333333333333333333333333333333333333');
  });

  it('extracts the transaction From address when the address is wrapped across lines', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Transaction Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        From
        0x33333333333333333333
        333333333333333333333333
      `),
    ).toBe('0x3333333333333333333333333333333333333333');
  });

  it('extracts the transaction From address when explorer text inserts a wallet label before the address', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Tokens Transferred:
        From Uniswap V2: Pair 0x1111111111111111111111111111111111111111
        To 0x2222222222222222222222222222222222222222

        Transaction Details
        Transaction Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        From: Example Wallet
        0x3333333333333333333333333333333333333333
        Interacted With (To)
        0x4444444444444444444444444444444444444444
      `),
    ).toBe('0x3333333333333333333333333333333333333333');
  });

  it('extracts the transaction address from Initiated by labels', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Transaction Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Initiated by:
        Example Wallet
        0x3333333333333333333333333333333333333333
        Interacted With (To)
        0x4444444444444444444444444444444444444444
      `),
    ).toBe('0x3333333333333333333333333333333333333333');
  });

  it('extracts the transaction address from Submitted By labels', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Txn Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Submitted By:
        Example Wallet
        0x7777777777777777777777777777777777777777
        Interacted With (To)
        0x4444444444444444444444444444444444444444
      `),
    ).toBe('0x7777777777777777777777777777777777777777');
  });

  it('extracts the transaction address from caller and tx sender labels', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Txn Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Caller
        Example Wallet
        0x3333333333333333333333333333333333333333
        Interacted With (To)
        0x4444444444444444444444444444444444444444
      `),
    ).toBe('0x3333333333333333333333333333333333333333');
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Transaction Sender:
        Example Wallet
        0x5555555555555555555555555555555555555555
        Status
        Success
      `),
    ).toBe('0x5555555555555555555555555555555555555555');
  });

  it('extracts the transaction address from called by labels', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Transaction Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Method called by:
        Example Wallet
        0x6666666666666666666666666666666666666666
        Interacted With (To)
        0x4444444444444444444444444444444444444444
      `),
    ).toBe('0x6666666666666666666666666666666666666666');
  });

  it('extracts the transaction address from transaction origin labels', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Transaction Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Transaction Origin:
        Example Wallet
        0x7777777777777777777777777777777777777777
        Interacted With (To)
        0x4444444444444444444444444444444444444444
      `),
    ).toBe('0x7777777777777777777777777777777777777777');
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Txn Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Txn Origin:
        Example Wallet
        0x8888888888888888888888888888888888888888
        Status
        Success
      `),
    ).toBe('0x8888888888888888888888888888888888888888');
  });

  it('extracts the transaction address from originating address labels', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Transaction Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Originating Address:
        Example Wallet
        0xefefefefefefefefefefefefefefefefefefefef
        Status
        Success
      `),
    ).toBe('0xefefefefefefefefefefefefefefefefefefefef');
  });

  it('extracts the transaction address from transaction initiator labels', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Transaction Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Transaction Initiator:
        Example Wallet
        0x9999999999999999999999999999999999999999
        Interacted With (To)
        0x4444444444444444444444444444444444444444
      `),
    ).toBe('0x9999999999999999999999999999999999999999');
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Txn Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Tx Initiator:
        Example Wallet
        0xabababababababababababababababababababab
        Status
        Success
      `),
    ).toBe('0xabababababababababababababababababababab');
  });

  it('extracts the transaction address from initiator labels', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Transaction Details
        Transaction Hash:
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Initiator:
        Example Wallet
        0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
        Status
        Success
      `),
    ).toBe('0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd');
  });

  it('does not use decoded input caller fields as the transaction address', () => {
    expect(
      extractEvmTransactionFromAddress(`
        Decoded Input Data
        caller
        0x9999999999999999999999999999999999999999
        tokenIn
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      `),
    ).toBeUndefined();
  });
});

describe('extractEvmTransactionTime', () => {
  it('normalizes ISO-like UTC timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026-06-11 12:00:01 UTC
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes ISO-like EVM explorer timestamps with AM/PM markers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026-06-11 01:00:01 PM UTC
      `),
    ).toBe('13:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes minute-precision EVM explorer timestamps by defaulting seconds to zero', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026-06-11 12:00 UTC
      `),
    ).toBe('12:00:00 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        Jun 11, 2026 12:00 PM UTC
      `),
    ).toBe('12:00:00 Jun 11, 2026 (UTC)');
  });

  it('normalizes compact ISO hour-offset timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026-06-11T20:00:01+08
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes high-precision ISO timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026-06-11T12:00:01.123456Z
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes slash-separated ISO-like UTC timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026/06/11 12:00:01 UTC
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes slash-separated labeled ISO-like UTC timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Date (UTC): 2026/06/11 12:00:01
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes unambiguous slash-separated month-first EVM explorer timestamps', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        06/13/2026 12:00:01 UTC
      `),
    ).toBe('12:00:01 Jun 13, 2026 (UTC)');
  });

  it('normalizes unambiguous slash-separated EVM explorer timestamps with a comma before time', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        06/13/2026, 12:00:01 UTC
      `),
    ).toBe('12:00:01 Jun 13, 2026 (UTC)');
  });

  it('normalizes labeled unambiguous slash-separated EVM explorer timestamps', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Date (UTC): 06/13/2026 12:00:01
      `),
    ).toBe('12:00:01 Jun 13, 2026 (UTC)');
  });

  it('normalizes labeled unambiguous slash-separated EVM explorer timestamps with a comma before time', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Date (UTC): 06/13/2026, 12:00:01
      `),
    ).toBe('12:00:01 Jun 13, 2026 (UTC)');
  });

  it('normalizes Unix second timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Unix Timestamp
        1718064001
      `),
    ).toBe('00:00:01 Jun 11, 2024 (UTC)');
  });

  it('normalizes Unix millisecond timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Unix Timestamp
        1718064001000
      `),
    ).toBe('00:00:01 Jun 11, 2024 (UTC)');
  });

  it('normalizes Unix timestamps when EVM explorers put UTC labels beside the timestamp label', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Block Timestamp (UTC)
        1718064001
      `),
    ).toBe('00:00:01 Jun 11, 2024 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp [GMT]: 1718064001000
      `),
    ).toBe('00:00:01 Jun 11, 2024 (UTC)');
  });

  it('normalizes Unix timestamps when EVM explorers mark the timestamp label as Unix', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp (Unix): 1718064001
      `),
    ).toBe('00:00:01 Jun 11, 2024 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Unix Timestamp (UTC): 1718064001000
      `),
    ).toBe('00:00:01 Jun 11, 2024 (UTC)');
  });

  it('normalizes hex Unix timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Block Timestamp (Unix)
        0x6a2aa341
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes numeric block time labels from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Block Time
        1718064001
      `),
    ).toBe('00:00:01 Jun 11, 2024 (UTC)');
  });

  it('normalizes full English month UTC timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        June 11, 2026 12:00:01 UTC
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes EVM explorer timestamps with a comma after the year', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        June 11, 2026, 12:00:01 UTC
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes EVM explorer English timestamps with an at separator before the time', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        June 11, 2026 at 12:00:01 UTC
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        11 June 2026 at 12:00:01 GMT
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes explorer UTC timestamps with a relative-time suffix', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        Jun-11-2026 12:00:01 PM +UTC (2 mins ago)
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes ISO-like GMT timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026-06-11 12:00:01 GMT
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes ISO-like +UTC timestamps from EVM explorers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026-06-11 12:00:01 +UTC
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('uses UTC or GMT timestamp labels when the timestamp value omits a trailing timezone', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Date (UTC): 2026-06-11 12:00:01
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp (GMT): Jun-11-2026 12:00:01 PM (2 mins ago)
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('uses UTC or GMT timestamp labels for ISO-like values with AM/PM markers', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Date (UTC): 2026-06-11 01:00:01 PM
      `),
    ).toBe('13:00:01 Jun 11, 2026 (UTC)');
  });

  it('uses EVM explorer Age labels when they include an absolute UTC timestamp', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Age (UTC): 2026-06-11 12:00:01
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Age (UTC)
        Jun-11-2026 12:00:01 PM
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('uses +UTC timestamp labels when the timestamp value omits a trailing timezone', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Date (+UTC): 2026-06-11 12:00:01
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes lowercase EVM explorer block timestamp labels', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        block timestamp (utc+8): 2026-06-11 20:00:01
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        block timestamp (gmt): Jun-11-2026 12:00:01 PM
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes timestamps when EVM explorers wrap the timezone in parentheses', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026-06-11 12:00:01 (UTC)
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        Jun-11-2026 12:00:01 PM (GMT) (2 mins ago)
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes EVM explorer timestamps with numeric timezone offsets', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026-06-11 20:00:01 +08:00
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        Jun-11-2026 08:00:01 PM +0800 (2 mins ago)
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes EVM explorer timestamps with UTC or GMT prefixed offsets', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        Jun-11-2026 08:00:01 PM UTC+8
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Date (UTC+8): 2026-06-11 20:00:01
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes day-first EVM explorer timestamps', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        11 Jun 2026 12:00:01 UTC
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Date (GMT): 11 June 2026 12:00:01
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes EVM explorer timestamps with uppercase month names', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        JUN-11-2026 12:00:01 PM UTC
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        11 JUNE 2026 12:00:01 GMT
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes EVM explorer timestamps with lowercase timezone labels', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        Jun-11-2026 12:00:01 PM utc
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        Jun-11-2026 08:00:01 PM gmt+8
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('normalizes explorer GMT timestamps with a relative-time suffix', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        Jun-11-2026 12:00:01 PM GMT (2 mins ago)
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('ignores malformed EVM explorer timestamps instead of normalizing them into another date', () => {
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        2026-13-40 25:99:99 UTC
      `),
    ).toBeUndefined();
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        Jun-40-2026 25:99:99 PM +UTC
      `),
    ).toBeUndefined();
    expect(
      extractEvmTransactionTime(`
        Transaction Details
        Timestamp
        06/11/2026 12:00:01 UTC
      `),
    ).toBeUndefined();
  });
});

describe('extractSolana transaction time helpers', () => {
  it('normalizes valid public Solana explorer UTC timestamps', () => {
    expect(
      extractSolanaExplorerTransactionTime(`
        Transaction Details
        Timestamp Jun 11, 2026 at 20:00:01 China Standard Time
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractSolanaFmTransactionTime(`
        Transaction
        June 11, 2026 12:00:01 UTC
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractSolanaFmTransactionTime(`
        Transaction
        June 11, 2026 12:00:01 GMT
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractSolanaExplorerTransactionTime(`
        Transaction Details
        Timestamp Jun 11, 2026 at 12:00:01 UTC
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
    expect(
      extractSolanaExplorerTransactionTime(`
        Transaction Details
        Timestamp
        12:00:01 Jun 11, 2026 (UTC)
      `),
    ).toBe('12:00:01 Jun 11, 2026 (UTC)');
  });

  it('ignores malformed public Solana timestamps instead of normalizing them into another date', () => {
    expect(
      extractSolanaExplorerTransactionTime(`
        Transaction Details
        Timestamp Jun 40, 2026 at 25:99:99 China Standard Time
      `),
    ).toBeUndefined();
    expect(
      extractSolanaFmTransactionTime(`
        Transaction
        June 40, 2026 25:99:99 UTC
      `),
    ).toBeUndefined();
    expect(parseSolscanTransactionTime('25:99:99 Jun 40, 2026 (UTC)')).toBeUndefined();
  });

  it('does not assume unknown Solana Explorer timezones are UTC', () => {
    expect(
      extractSolanaExplorerTransactionTime(`
        Transaction Details
        Timestamp Jun 11, 2026 at 12:00:01 Example Local Time
      `),
    ).toBeUndefined();
  });
});

describe('extractEvmContractAddress', () => {
  it('extracts an EVM token contract address when explorer labels are split across rows', () => {
    expect(
      extractEvmContractAddress(`
        Token Contract
        Address
        0x9999999999999999999999999999999999999999
      `),
    ).toBe('0x9999999999999999999999999999999999999999');
  });

  it('extracts an EVM token contract address when explorer labels use a colon', () => {
    expect(
      extractEvmContractAddress(`
        Transaction Action
        Swap Exact Tokens
        Token Contract: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      `),
    ).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(
      extractEvmContractAddress(`
        Contract Address: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      `),
    ).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('extracts an EVM token contract address when the address is wrapped across lines', () => {
    expect(
      extractEvmContractAddress(`
        Token Contract
        Address
        0xaaaaaaaaaaaaaaaaaaaa
        aaaaaaaaaaaaaaaaaaaaaaaa
      `),
    ).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('prefers token contract labels over generic router contract labels', () => {
    expect(
      extractEvmContractAddress(`
        Interacted With (To)
        Contract 0x1111111111111111111111111111111111111111
        Contract Name: Example Router

        Tokens Transferred
        Token Contract
        0x2222222222222222222222222222222222222222
      `),
    ).toBe('0x2222222222222222222222222222222222222222');
  });

  it('extracts token contract labels that include an EVM token standard', () => {
    expect(
      extractEvmContractAddress(`
        Interacted With (To)
        Contract 0x1111111111111111111111111111111111111111
        Contract Name: Example Router

        Tokens Transferred
        Token Contract (BEP-20)
        0x2222222222222222222222222222222222222222
      `),
    ).toBe('0x2222222222222222222222222222222222222222');
  });

  it('extracts token contract labels when a token name appears before the address', () => {
    expect(
      extractEvmContractAddress(`
        Interacted With (To)
        Contract 0x1111111111111111111111111111111111111111
        Contract Name: Example Router

        Tokens Transferred
        Token Contract (ERC-20)
        Example Meme Token (MEME)
        0x2222222222222222222222222222222222222222
      `),
    ).toBe('0x2222222222222222222222222222222222222222');
  });

  it('extracts token tracker labels from EVM explorer text', () => {
    expect(
      extractEvmContractAddress(`
        Interacted With (To)
        Contract 0x1111111111111111111111111111111111111111
        Contract Name: Example Router

        Tokens Transferred
        Token Tracker
        Example Meme Token (MEME)
        0x2222222222222222222222222222222222222222
      `),
    ).toBe('0x2222222222222222222222222222222222222222');
  });

  it('extracts token contract labels from 0x-prefixed ABI word fields', () => {
    expect(
      extractEvmContractAddress(`
        Tokens Transferred
        Token Contract
        0x0000000000000000000000002222222222222222222222222222222222222222
      `),
    ).toBe('0x2222222222222222222222222222222222222222');
  });

  it('extracts token contract labels from wrapped ABI word fields', () => {
    expect(
      extractEvmContractAddress(`
        Tokens Transferred
        Token Contract
        0x00000000000000000000000022222222222222222222
        22222222222222222222
      `),
    ).toBe('0x2222222222222222222222222222222222222222');
  });

  it('does not treat a generic token transfer row as the EVM target contract address', () => {
    expect(
      extractEvmContractAddress(`
        Tokens Transferred
        Token 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        From 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        To 0xcccccccccccccccccccccccccccccccccccccccc
      `),
    ).toBeUndefined();
  });
});

describe('inferEvmTradeSide', () => {
  it('treats swap native for token as a buy when explorer text uses the token symbol', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH For 1,200 MEME On Uniswap V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats arrow swap action text into the target token as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH -> 1,200 MEME On Aerodrome',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats compact arrow swap action text into the target token as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH→1,200 MEME On Aerodrome',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats compact single-angle swap action text into the target token as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH>1,200 MEME On Aerodrome',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 1,200 MEME›0.5 ETH On Aerodrome',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('treats arrow swap action text out of the target token as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 1,200 MEME -> 0.5 ETH On Aerodrome',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('treats swapExactETHForTokens function text as a target token buy', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapExactETHForTokensSupportingFeeOnTransferTokens Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats swapETHForExactTokens function text as a target token buy', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapETHForExactTokens Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats swapped native for token as a buy when explorer action text uses the past tense', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swapped 0.5 ETH For 1,200 MEME On Uniswap V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats exchanged native for token as a buy when explorer action text uses exchange wording', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Exchanged 0.5 ETH For 1,200 MEME On Uniswap V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats traded native for token as a buy when explorer action text uses trade wording', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Traded 0.5 ETH For 1,200 MEME On Uniswap V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Transaction Action Trade 1,200 MEME For 0.5 ETH On Uniswap V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('treats converted native to token as a buy when explorer action text uses convert wording', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Converted 0.5 ETH To 1,200 MEME On Aggregator',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats converted native into token as a buy when explorer action text uses into wording', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Converted 0.5 ETH Into 1,200 MEME On Aggregator',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats redeemed native for token as a buy when explorer action text uses redeem wording', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Redeemed 0.5 ETH For 1,200 MEME On Aggregator',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats receive-in-exchange action text into the target token as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Received 1,200 MEME in exchange for 0.5 ETH via Aggregator',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats pay-to-receive action text out of the target token as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Paid 1,200 MEME to receive 0.5 ETH via Aggregator',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('treats spent-to-receive action text into the target token as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Spent 0.5 ETH to receive 1,200 MEME via Aggregator',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('treats paid-for action text out of the target token as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Paid 1,200 MEME for 0.5 ETH via Aggregator',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('does not treat bought-action via venue names as EVM target token transfers', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Bought 1.2 ETH With 300 USDC via MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat sold-action via venue names as EVM target token transfers', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Sold 1.2 ETH For 300 USDC via MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat bought-action at venue names as EVM target token transfers', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Bought 1.2 ETH With 300 USDC at MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat bought-action from venue names as EVM target token transfers', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Bought 1.2 ETH With 300 USDC from MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat sold-action at venue names as EVM target token transfers', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Sold 1.2 ETH For 300 USDC at MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat sold-action from venue names as EVM target token transfers', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Sold 1.2 ETH For 300 USDC from MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('uses a trailing uppercase ticker from EVM token link text when no parentheses are present', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH For 1,200 MEME On Uniswap V2',
        'Example Meme Token MEME',
      ),
    ).toBe('buy');
  });

  it('uses the token name without its ticker suffix to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH For 1,200 Blue Rocket Token On Uniswap V2',
        'Blue Rocket Token (BRT)',
      ),
    ).toBe('buy');
  });

  it('treats swap token for native as a sell when explorer text uses lowercase wording', () => {
    expect(
      inferEvmTradeSide(
        'transaction action swap 1200 meme for 0.5 eth on uniswap v2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('treats swapExactTokensForETH function text as a target token sell', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForETHSupportingFeeOnTransferTokens Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('treats swapTokensForExactETH function text as a target token sell', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapTokensForExactETH Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses token-to-token router function summaries to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens path: USDC -> MEME Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swapTokensForExactTokens path: MEME -> USDC Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses compact token-to-token path summaries to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens path:USDC->MEME Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens path:MEME->USDC Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses compact single-angle token path separators to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens path:USDC>MEME Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens path:MEME›USDC Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses token contract addresses in token-to-token paths to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens path:${quoteToken}->${targetToken} Transaction Action Method ID`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens path:[${targetToken}, ${quoteToken}] Transaction Action Method ID`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses indexed token-to-token path fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens path[0] ${quoteToken} path[1] ${targetToken} Transaction Action Method ID`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens path[0] ${targetToken} path[1] ${quoteToken} Transaction Action Method ID`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses address array token-to-token path fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens path address[] [0] ${quoteToken} [1] ${targetToken} Transaction Action Method ID`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens path address[] [0] ${targetToken} [1] ${quoteToken} Transaction Action Method ID`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses whitespace-separated EVM address path fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens Decoded Input Data path ${quoteToken} ${targetToken} recipient 0x3333333333333333333333333333333333333333`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens Decoded Input Data path ${targetToken} ${quoteToken} recipient 0x3333333333333333333333333333333333333333`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('stops whitespace-separated EVM address paths before receiver fields', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const receiverAddress = '0x3333333333333333333333333333333333333333';

    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens Decoded Input Data path ${quoteToken} ${targetToken} receiver ${receiverAddress}`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
  });

  it('stops whitespace-separated EVM address paths before beneficiary fields', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const beneficiaryAddress = '0x3333333333333333333333333333333333333333';

    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens Decoded Input Data path ${quoteToken} ${targetToken} beneficiary ${beneficiaryAddress}`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
  });

  it('stops whitespace-separated EVM address paths before refund receiver fields', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const refundReceiverAddress = '0x3333333333333333333333333333333333333333';

    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens Decoded Input Data path ${quoteToken} ${targetToken} refundReceiver ${refundReceiverAddress}`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
  });

  it('stops whitespace-separated EVM address paths before snake_case recipient fields', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const recipientAddress = '0x3333333333333333333333333333333333333333';

    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens Decoded Input Data path ${quoteToken} ${targetToken} recipient_address ${recipientAddress}`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
  });

  it('stops whitespace-separated EVM address paths before snake_case refund fields', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const refundReceiverAddress = '0x3333333333333333333333333333333333333333';

    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens Decoded Input Data path ${quoteToken} ${targetToken} refund_receiver ${refundReceiverAddress}`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
  });

  it('uses packed Uniswap V3 exactInput path fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const feeTier = '000bb8';

    expect(
      inferEvmTradeSide(
        `Function: exactInput Decoded Input Data path 0x${quoteToken.slice(
          2,
        )}${feeTier}${targetToken.slice(2)} recipient 0x3333333333333333333333333333333333333333`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: exactInput Decoded Input Data path 0x${targetToken.slice(
          2,
        )}${feeTier}${quoteToken.slice(2)} recipient 0x3333333333333333333333333333333333333333`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses wrapped packed Uniswap V3 exactInput path fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const feeTier = '000bb8';

    expect(
      inferEvmTradeSide(
        `Function: exactInput Decoded Input Data path 0x${quoteToken.slice(
          2,
        )}${feeTier} ${targetToken.slice(2, 22)}
        ${targetToken.slice(22)} recipient 0x3333333333333333333333333333333333333333`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
  });

  it('uses packed Uniswap V3 exactInput path fields without a 0x prefix', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const feeTier = '000bb8';

    expect(
      inferEvmTradeSide(
        `Function: exactInput Decoded Input Data path ${quoteToken.slice(
          2,
        )}${feeTier}${targetToken.slice(2)} recipient 0x3333333333333333333333333333333333333333`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
  });

  it('uses encoded packed path aliases to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const feeTier = '000bb8';

    expect(
      inferEvmTradeSide(
        `Function: exactInput Decoded Input Data encodedPath 0x${quoteToken.slice(
          2,
        )}${feeTier}${targetToken.slice(2)} recipient 0x3333333333333333333333333333333333333333`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: exactInput Decoded Input Data pathBytes 0x${targetToken.slice(
          2,
        )}${feeTier}${quoteToken.slice(2)} recipient 0x3333333333333333333333333333333333333333`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses reversed packed Uniswap V3 exactOutput path fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';
    const feeTier = '000bb8';

    expect(
      inferEvmTradeSide(
        `Function: exactOutput Decoded Input Data path 0x${targetToken.slice(
          2,
        )}${feeTier}${quoteToken.slice(2)} recipient 0x3333333333333333333333333333333333333333`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: exactOutput Decoded Input Data path 0x${quoteToken.slice(
          2,
        )}${feeTier}${targetToken.slice(2)} recipient 0x3333333333333333333333333333333333333333`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses underscored decoded path fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens _path (address[]) [0] ${quoteToken} [1] ${targetToken} Transaction Action Method ID`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swapExactTokensForTokens _path (address[]) [0] ${targetToken} [1] ${quoteToken} Transaction Action Method ID`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses list-style token paths to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens path: [USDC, MEME] Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens path: [MEME, USDC] Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses route-style token paths to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens route = [USDC, MEME] Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens routes = [MEME, USDC] Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses whitespace-separated token path fields to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens path USDC MEME recipient 0x1111111111111111111111111111111111111111',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens path MEME USDC amountOutMin 1 Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses composite route path decoded fields to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens swapPath: [USDC, MEME] Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokens tokenPath = [MEME, USDC] Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses fee-on-transfer token-to-token router function summaries to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokensSupportingFeeOnTransferTokens path: [USDC, MEME] Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swapExactTokensForTokensSupportingFeeOnTransferTokens path: [MEME, USDC] Transaction Action Method ID',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses compact tokenIn and tokenOut decoded input fields to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: exactInputSingle Decoded Input Data tokenIn:USDC tokenOut:MEME fee 3000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: exactInputSingle Decoded Input Data tokenIn:MEME tokenOut:USDC fee 3000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses inputToken and outputToken decoded input fields to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swap Decoded Input Data inputToken:USDC outputToken:MEME amount 1000000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swap Decoded Input Data inputCurrency:MEME outputCurrency:USDC amount 1000000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses inToken and outToken decoded input fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data inToken:${quoteToken} outToken:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data outTokenAddress ${quoteToken} inTokenAddress ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses dotted decoded input token fields to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: exactInputSingle Decoded Input Data params.tokenIn:USDC params.tokenOut:MEME params.fee 3000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: exactInputSingle Decoded Input Data params.tokenIn:MEME params.tokenOut:USDC params.fee 3000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses underscored token input and output decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        'Function: exactInputSingle Decoded Input Data token_in:USDC token_out:MEME fee 3000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: exactInputSingle Decoded Input Data _tokenIn ${targetToken} _tokenOut ${quoteToken} fee 3000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses aggregator token pair decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        'Function: swap Decoded Input Data srcToken:USDC dstToken:MEME amount 1000000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data sellToken ${targetToken} buyToken ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses token address decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data srcTokenAddress:${quoteToken} dstTokenAddress:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data sellTokenAddress ${targetToken} buyTokenAddress ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses tokenAddressIn and tokenAddressOut decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data tokenAddressIn:${quoteToken} tokenAddressOut:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data token_address_in ${targetToken} token_address_out ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses token symbol decoded field suffixes to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swap Decoded Input Data tokenInSymbol:USDC tokenOutSymbol:MEME amount 1000000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swap Decoded Input Data fromTokenSymbol MEME toTokenSymbol USDC amount 1000000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses token name decoded field suffixes to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: swap Decoded Input Data tokenInName:USD Coin tokenOutName:Example Meme Token amount 1000000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: swap Decoded Input Data fromTokenName Example Meme Token toTokenName USD Coin amount 1000000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('uses ABI word token address decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data tokenIn:0x000000000000000000000000${quoteToken.slice(
          2,
        )} tokenOut:0x000000000000000000000000${targetToken.slice(2)} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
  });

  it('uses wrapped ABI word token address decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data tokenIn:${quoteToken} tokenOut:0x000000000000000000000000${targetToken.slice(
          2,
          22,
        )} ${targetToken.slice(22)} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
  });

  it('uses asset and currency decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        'Function: swap Decoded Input Data assetIn:USDC assetOut:MEME amount 1000000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data inputAsset ${targetToken} outputAsset ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data currencyIn:${quoteToken} currencyOut:${targetToken} amountIn 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
  });

  it('uses source and destination asset decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data srcAsset:${quoteToken} dstAsset:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data sourceAsset ${targetToken} destinationAsset ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses source and destination currency decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data srcCurrency:${quoteToken} dstCurrency:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data sourceCurrency ${targetToken} destinationCurrency ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses assetFrom and assetTo decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data assetFrom:${quoteToken} assetTo:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data asset_from ${targetToken} asset_to ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses fromAsset and toAsset decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data fromAsset:${quoteToken} toAsset:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data from_asset ${targetToken} to_asset ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses pay and receive asset or currency decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data payAsset:${quoteToken} receiveAsset:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data received_currency ${quoteToken} spent_currency ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses tokenSold and tokenBought decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data tokenSold ${quoteToken} tokenBought ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data token_sold ${targetToken} token_bought ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses soldToken and boughtToken decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data soldToken:${quoteToken} boughtToken:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data bought_token ${quoteToken} sold_token ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses pay and receive token decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data payToken ${quoteToken} receiveToken ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data receive_token ${quoteToken} pay_token ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses spent and received token decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data spentToken ${quoteToken} receivedToken ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data received_token ${quoteToken} spent_token ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses taker and maker token decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: fillOrder Decoded Input Data takerToken ${quoteToken} makerToken ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: fillOrder Decoded Input Data taker_token ${targetToken} maker_token ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses taker and maker asset decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: fillOrder Decoded Input Data takerAsset ${quoteToken} makerAsset ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: fillOrder Decoded Input Data maker_asset ${quoteToken} taker_asset ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses asset and currency sold/bought decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data assetSold:${quoteToken} assetBought:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data currency_bought ${quoteToken} currency_sold ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses sold/bought asset and currency decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data soldAsset:${quoteToken} boughtAsset:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data bought_currency ${quoteToken} sold_currency ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses assetAddressIn and currencyAddressOut decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data assetAddressIn:${quoteToken} assetAddressOut:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data currency_address_in ${targetToken} currency_address_out ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses plural assetAddressesIn and currencyAddrsOut decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data assetAddressesIn:${quoteToken} assetAddressesOut:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data currency_addrs_out ${quoteToken} currency_addrs_in ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses currencyFrom and currencyTo decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data currencyFrom:${quoteToken} currencyTo:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data currency_to ${quoteToken} currency_from ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses tokenFrom and tokenTo decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data tokenFromAddress:${quoteToken} tokenToAddress:${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data tokenFrom ${targetToken} tokenTo ${quoteToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses plural inputTokens and outputTokens decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data inputTokens ${quoteToken} outputTokens ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data output_tokens ${quoteToken} input_tokens ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses plural tokensIn and tokensOut decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data tokensIn ${quoteToken} tokensOut ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data tokens_out ${quoteToken} tokens_in ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses plural inputTokenAddresses and outputTokenAddresses decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data inputTokenAddresses ${quoteToken} outputTokenAddresses ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data output_token_addresses ${quoteToken} input_token_addresses ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses plural inputTokenAddrs and outputTokenAddrs decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data inputTokenAddrs ${quoteToken} outputTokenAddrs ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data dst_token_addrs ${quoteToken} src_token_addrs ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses plural source and destination token decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data srcTokens ${quoteToken} dstTokens ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data destination_tokens ${quoteToken} source_tokens ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses reversed token pair decoded fields to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        'Function: swap Decoded Input Data dstToken:MEME srcToken:USDC amount 1000000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: swap Decoded Input Data buyToken ${quoteToken} sellToken ${targetToken} amount 1000000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses spaced Token In and Token Out decoded input labels to infer EVM trade side', () => {
    const quoteToken = '0x1111111111111111111111111111111111111111';
    const targetToken = '0x2222222222222222222222222222222222222222';

    expect(
      inferEvmTradeSide(
        `Function: exactInputSingle Decoded Input Data Token In ${quoteToken} Token Out ${targetToken} fee 3000`,
        undefined,
        targetToken,
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        `Function: exactInputSingle Decoded Input Data Token In ${targetToken} Token Out ${quoteToken} fee 3000`,
        undefined,
        targetToken,
      ),
    ).toBe('sell');
  });

  it('uses tokenIn and tokenOut decoded input fields to infer EVM trade side', () => {
    expect(
      inferEvmTradeSide(
        'Function: exactInputSingle Decoded Input Data tokenIn USDC tokenOut MEME fee 3000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
    expect(
      inferEvmTradeSide(
        'Function: exactInputSingle Decoded Input Data tokenIn MEME tokenOut USDC fee 3000',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('does not require explorer swap action text to include an On suffix', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH For 1,200 MEME Transaction Fee 0.0001 ETH',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('supports explorer swap action text that uses To instead of For', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 1,200 MEME To 0.5 ETH On PancakeSwap',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('treats via as a swap action venue suffix', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH For 1,200 MEME via Aggregator',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('does not infer a trade from target token text that only appears in a via venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH For 1,200 USDC via MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not infer a trade from target token text that only appears in a using venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH For 1,200 USDC using MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not infer a trade from target token text that only appears in a through venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH For 1,200 USDC through MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not infer a trade from target token text that only appears in an at venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH For 1,200 USDC at MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not infer a trade from target token text that only appears in a from venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Swap 0.5 ETH For 1,200 USDC from MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('uses the swap route segment that contains the target token', () => {
    expect(
      inferEvmTradeSide(
        [
          'Transaction Action',
          'Swap 0.5 ETH For 1,000 USDC On Uniswap V3',
          'Swap 1,000 USDC For 1,200 MEME On Uniswap V2',
        ].join(' '),
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('does not let a swap route segment without an On suffix swallow the next segment', () => {
    expect(
      inferEvmTradeSide(
        [
          'Transaction Action',
          'Swap 0.5 ETH For 1,000 USDC',
          'Transaction Action',
          'Swap 1,200 MEME For 0.5 ETH',
          'Transaction Fee 0.0001 ETH',
        ].join(' '),
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('supports explorer action text that describes a token purchase as Bought', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Bought 1,200 MEME For 0.5 ETH On Uniswap V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('supports explorer action text that describes a token purchase as Purchased', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Purchased 1,200 MEME With 0.5 ETH On Uniswap V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('supports explorer action text that describes a token sale as Sold', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Sold 1,200 MEME For 0.5 ETH On Uniswap V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('treats received target token action text as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Received 1,200 MEME From PancakeSwap V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('does not treat received target token from a plain wallet as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Received 1,200 MEME From Example Wallet',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('treats received target token from the parsed pool address as an EVM buy', () => {
    const poolAddress = '0x4444444444444444444444444444444444444444';

    expect(
      inferEvmTradeSide(
        `Transaction Action Received 1,200 MEME From ${poolAddress}`,
        'Example Meme Token (MEME)',
        undefined,
        undefined,
        [poolAddress],
      ),
    ).toBe('buy');
  });

  it('treats received target token from common aggregator venue text as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Received 1,200 MEME From 0x Exchange Proxy',
        'Example Meme Token (MEME)',
      ),
    ).toBe('buy');
  });

  it('does not treat remove-liquidity received target token text as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Removed Liquidity Received 1,200 MEME From Uniswap V2 Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat unwrap received target token text as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Unwrapped 1,200 MEME Received 1,200 MEME From Uniswap V2 Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat withdraw received target token text as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Withdraw 1,200 MEME Received 1,200 MEME From PancakeSwap Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat claim-reward received target token text as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Claimed Reward 1,200 MEME Received 1,200 MEME From Staking Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat borrow received target token text as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Borrowed 1,200 MEME Received 1,200 MEME From Lending Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat bridge received target token text as an EVM buy', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Bridged 1,200 MEME Received 1,200 MEME From Bridge Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not infer received action side from target token text that only appears in a using venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Received 1,200 USDC using MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not infer received action side from target token text that only appears in a through venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Received 1,200 USDC through MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not infer received action side from target token text that only appears in an at venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Received 1,200 USDC at MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('treats sent target token action text as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Sent 1,200 MEME To PancakeSwap V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('does not treat sent target token to a plain wallet as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Sent 1,200 MEME To Example Wallet',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('treats sent target token to the parsed pool address as an EVM sell', () => {
    const poolAddress = '0x4444444444444444444444444444444444444444';

    expect(
      inferEvmTradeSide(
        `Transaction Action Sent 1,200 MEME To ${poolAddress}`,
        'Example Meme Token (MEME)',
        undefined,
        undefined,
        [poolAddress],
      ),
    ).toBe('sell');
  });

  it('treats sent target token to common aggregator venue text as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Sent 1,200 MEME To DODO V2',
        'Example Meme Token (MEME)',
      ),
    ).toBe('sell');
  });

  it('does not treat add-liquidity sent target token text as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Added Liquidity Sent 1,200 MEME To Uniswap V2 Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat wrap sent target token text as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Wrapped 1,200 MEME Sent 1,200 MEME To Uniswap V2 Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat deposit sent target token text as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Deposit 1,200 MEME Sent 1,200 MEME To PancakeSwap Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat stake sent target token text as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Staked 1,200 MEME Sent 1,200 MEME To Staking Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat supply sent target token text as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Supplied 1,200 MEME Sent 1,200 MEME To Lending Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat repay sent target token text as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Repaid 1,200 MEME Sent 1,200 MEME To Lending Pool',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat approve sent target token text as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Approved 1,200 MEME For Uniswap V2 Router Sent 1,200 MEME To Uniswap V2 Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not treat permit sent target token text as an EVM sell', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Permit 1,200 MEME For PancakeSwap Router Sent 1,200 MEME To PancakeSwap Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not infer sent action side from target token text that only appears in a using venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Sent 1,200 USDC using MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not infer sent action side from target token text that only appears in a through venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Sent 1,200 USDC through MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('does not infer sent action side from target token text that only appears in an at venue', () => {
    expect(
      inferEvmTradeSide(
        'Transaction Action Sent 1,200 USDC at MEME Router',
        'Example Meme Token (MEME)',
      ),
    ).toBe('unknown');
  });

  it('uses abbreviated EVM addresses in token transfer rows to infer side', () => {
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';

    expect(
      inferEvmTradeSide(
        `
          ERC-20 Token Transfers
          From 0x4444...4444
          To 0x3333...3333
          For 1,200 MEME
        `,
        'Example Meme Token (MEME)',
        undefined,
        signerAddress,
        [poolAddress],
      ),
    ).toBe('buy');
  });

  it('uses sender and recipient token transfer labels to infer side', () => {
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';

    expect(
      inferEvmTradeSide(
        `
          ERC-20 Token Transfers
          Sender ${signerAddress}
          Recipient ${poolAddress}
          Amount 1,200 MEME
        `,
        'Example Meme Token (MEME)',
        undefined,
        signerAddress,
        [poolAddress],
      ),
    ).toBe('sell');
  });

  it('uses amount-first EVM token transfer rows without transfer verbs to infer side', () => {
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';

    expect(
      inferEvmTradeSide(
        `
          ERC-20 Token Transfers
          1,200 MEME
          From PancakeSwap V2: Pair ${poolAddress}
          To ${signerAddress}
        `,
        'Example Meme Token (MEME)',
        undefined,
        signerAddress,
        [poolAddress],
      ),
    ).toBe('buy');
  });

  it('uses destination-first EVM token transfer rows to infer side', () => {
    const signerAddress = '0x3333333333333333333333333333333333333333';
    const poolAddress = '0x4444444444444444444444444444444444444444';

    expect(
      inferEvmTradeSide(
        `
          ERC-20 Token Transfers
          To ${signerAddress}
          From PancakeSwap V2: Pair ${poolAddress}
          Amount 1,200 MEME
        `,
        'Example Meme Token (MEME)',
        undefined,
        signerAddress,
        [poolAddress],
      ),
    ).toBe('buy');

    expect(
      inferEvmTradeSide(
        `
          ERC-20 Token Transfers
          Recipient PancakeSwap V2: Pair ${poolAddress}
          Sender ${signerAddress}
          Value 1,200 MEME
        `,
        'Example Meme Token (MEME)',
        undefined,
        signerAddress,
        [poolAddress],
      ),
    ).toBe('sell');
  });
});

describe('extractEvmRouterAddressFromExplorerText', () => {
  it('extracts an EVM router address when the explorer renders the router label after the address', () => {
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Interacted With (To):
        0x7777777777777777777777777777777777777777
        Contract Name: Uniswap V2 Router
      `),
    ).toBe('0x7777777777777777777777777777777777777777');
  });

  it('extracts an EVM router address when the address is wrapped across lines', () => {
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Interacted With (To):
        0x77777777777777777777
        777777777777777777777777
        Contract Name: Uniswap V2 Router
      `),
    ).toBe('0x7777777777777777777777777777777777777777');
  });

  it('extracts an EVM router address when explorer labels use compact router names', () => {
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Interacted With (To):
        0x1212121212121212121212121212121212121212
        Contract Name: SwapRouter02
      `),
    ).toBe('0x1212121212121212121212121212121212121212');
  });

  it('extracts an EVM router address when explorer labels aggregator contracts as exchange proxies', () => {
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Interacted With (To):
        0x2323232323232323232323232323232323232323
        Contract Name: 0x: Exchange Proxy
      `),
    ).toBe('0x2323232323232323232323232323232323232323');
  });

  it('extracts an EVM router address from decoded router address fields', () => {
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Decoded Input Data
        routerAddress
        0x3434343434343434343434343434343434343434
      `),
    ).toBe('0x3434343434343434343434343434343434343434');
  });

  it('extracts an EVM router address from 0x-prefixed ABI word fields', () => {
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Decoded Input Data
        routerAddress
        0x0000000000000000000000003434343434343434343434343434343434343434
      `),
    ).toBe('0x3434343434343434343434343434343434343434');
  });

  it('extracts an EVM router address from wrapped ABI word fields', () => {
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Decoded Input Data
        routerAddress
        0x00000000000000000000000034343434343434343434
        34343434343434343434
      `),
    ).toBe('0x3434343434343434343434343434343434343434');
  });

  it('extracts an EVM router address from aggregator spender fields', () => {
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Decoded Input Data
        allowanceTarget
        0x4545454545454545454545454545454545454545
      `),
    ).toBe('0x4545454545454545454545454545454545454545');
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Decoded Input Data
        spender: 0x5656565656565656565656565656565656565656
      `),
    ).toBe('0x5656565656565656565656565656565656565656');
  });

  it('extracts an EVM router address from aggregator permit2 fields', () => {
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Decoded Input Data
        permit2Address
        0x7878787878787878787878787878787878787878
      `),
    ).toBe('0x7878787878787878787878787878787878787878');
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Decoded Input Data
        permit2_addr: 0x8989898989898989898989898989898989898989
      `),
    ).toBe('0x8989898989898989898989898989898989898989');
  });

  it('does not treat a pool or pair address as an EVM router address', () => {
    expect(
      extractEvmRouterAddressFromExplorerText(`
        Interacted With (To):
        0x8888888888888888888888888888888888888888
        Contract Name: Uniswap V2 Pair
      `),
    ).toBeUndefined();
  });
});

describe('selectEvmContractTokenCandidate', () => {
  it('prefers a non-stable token over common quote token links from EVM explorers', () => {
    const selected = selectEvmContractTokenCandidate([
      {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        text: 'USD Coin (USDC)',
      },
      {
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        text: 'Wrapped Ether (WETH)',
      },
      {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        text: 'Example Meme Token (MEME)',
      },
    ]);

    expect(selected).toEqual({
      address: '0x1234567890abcdef1234567890abcdef12345678',
      text: 'Example Meme Token (MEME)',
    });
  });

  it('falls back to the first token link when every EVM token is a common quote token', () => {
    const selected = selectEvmContractTokenCandidate([
      {
        address: '0x4200000000000000000000000000000000000006',
        text: 'Wrapped Ether (WETH)',
      },
      {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        text: 'USD Coin (USDC)',
      },
    ]);

    expect(selected?.address).toBe('0x4200000000000000000000000000000000000006');
  });

  it('uses token text to avoid unknown-address EVM quote tokens', () => {
    const selected = selectEvmContractTokenCandidate([
      {
        address: '0x1111111111111111111111111111111111111111',
        text: 'New chain USD Coin (USDC)',
      },
      {
        address: '0x2222222222222222222222222222222222222222',
        text: 'Wrapped Native Token (WETH)',
      },
      {
        address: '0x3333333333333333333333333333333333333333',
        text: 'Fresh Launch Token (FRESH)',
      },
    ]);

    expect(selected?.address).toBe('0x3333333333333333333333333333333333333333');
  });
});

describe('isBrowserVerificationPageText', () => {
  it('detects common explorer browser verification pages', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      isBrowserVerificationPageText?: (text: string) => boolean;
    };

    expect(driverModule.isBrowserVerificationPageText).toBeTypeOf('function');
    expect(driverModule.isBrowserVerificationPageText?.('Just a moment...')).toBe(true);
    expect(
      driverModule.isBrowserVerificationPageText?.(
        'Please enable JavaScript and cookies to continue',
      ),
    ).toBe(true);
    expect(driverModule.isBrowserVerificationPageText?.('Attention Required! | Cloudflare')).toBe(
      true,
    );
    expect(
      driverModule.isBrowserVerificationPageText?.(
        'Checking if the site connection is secure before proceeding',
      ),
    ).toBe(true);
    expect(
      driverModule.isBrowserVerificationPageText?.(
        'www.xxyy.io needs to review the security of your connection before proceeding',
      ),
    ).toBe(true);
    expect(
      driverModule.isBrowserVerificationPageText?.(
        'This website is using a security service to protect itself from online attacks. The action you just performed triggered the security solution.',
      ),
    ).toBe(true);
    expect(driverModule.isBrowserVerificationPageText?.('Please verify you are not a robot')).toBe(
      true,
    );
    expect(driverModule.isBrowserVerificationPageText?.('Access denied Error code 1020')).toBe(
      true,
    );
    expect(driverModule.isBrowserVerificationPageText?.('cf-turnstile challenge widget')).toBe(
      true,
    );
    expect(driverModule.isBrowserVerificationPageText?.('cf-chl-widget challenge markup')).toBe(
      true,
    );
    expect(driverModule.isBrowserVerificationPageText?.('DDoS-GUARD Protection')).toBe(true);
    expect(
      driverModule.isBrowserVerificationPageText?.(
        'Please wait while your request is being verified',
      ),
    ).toBe(true);
    expect(driverModule.isBrowserVerificationPageText?.('Transaction Details From 0xabc')).toBe(
      false,
    );
  });
});

describe('createSolanaPublicFallbackUnavailableError', () => {
  it('falls back to public Solana explorers when Solscan navigation times out', async () => {
    const signerAddress = '11111111111111111111111111111111';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const fakePage = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        if (url.startsWith('https://solscan.io/tx/')) {
          return Promise.reject(new Error('page.goto: net::ERR_TIMED_OUT'));
        }

        return Promise.resolve();
      },
      locator() {
        return {
          innerText() {
            if (currentUrl.startsWith('https://explorer.solana.com/tx/')) {
              return Promise.resolve(`Fee payer ${signerAddress}`);
            }

            return Promise.resolve('No extra SolanaFM context');
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: typeof fakePage,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<{ signerAddress?: string; solscanUrl: string }>;
    };

    expect(driverModule.extractSolanaTransaction).toBeTypeOf('function');
    const result = await driverModule.extractSolanaTransaction?.(fakePage, SOLANA_TX, {
      timeoutMs: 1000,
    });

    expect(result?.signerAddress).toBe(signerAddress);
    expect(result?.solscanUrl).toBe(`https://solana.fm/tx/${SOLANA_TX}`);
    expect(visitedUrls).toEqual([
      `https://solscan.io/tx/${SOLANA_TX}`,
      `https://explorer.solana.com/tx/${SOLANA_TX}`,
      `https://solana.fm/tx/${SOLANA_TX}`,
    ]);
  });

  it('preserves tx_failed when a public Solana fallback marks the transaction as failed', async () => {
    const signerAddress = '11111111111111111111111111111111';
    const visitedUrls: string[] = [];
    let currentUrl = '';
    const fakePage = {
      goto(url: string) {
        visitedUrls.push(url);
        currentUrl = url;
        if (url.startsWith('https://solscan.io/tx/')) {
          return Promise.reject(new Error('page.goto: net::ERR_TIMED_OUT'));
        }

        return Promise.resolve();
      },
      locator() {
        return {
          innerText() {
            if (currentUrl.startsWith('https://explorer.solana.com/tx/')) {
              return Promise.resolve(`
                Transaction Details
                Status:
                Failed
                Fee payer ${signerAddress}
                Timestamp Jun 11, 2026 at 12:00:01 UTC
              `);
            }

            return Promise.resolve('SolanaFM should not be reached');
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: typeof fakePage,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractSolanaTransaction?.(fakePage, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      metadata: {
        explorerUrl: `https://explorer.solana.com/tx/${SOLANA_TX}`,
        targetTraderAddress: signerAddress,
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      },
      reason: 'tx_failed',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([
      `https://solscan.io/tx/${SOLANA_TX}`,
      `https://explorer.solana.com/tx/${SOLANA_TX}`,
    ]);
  });

  it('keeps browser verification as the failure reason when public Solana fallbacks are blocked', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createSolanaPublicFallbackUnavailableError?: (
        cause: Error,
        fallbackErrors: unknown[],
      ) => TxAnalysisProviderUnavailableError;
    };
    const solscanError = new TxAnalysisProviderUnavailableError(
      'Solscan verification required',
      'browser_verification_required',
    );
    const explorerError = new TxAnalysisProviderUnavailableError(
      'Solana Explorer verification required',
      'browser_verification_required',
    );
    const solanaFmError = new TxAnalysisProviderUnavailableError(
      'SolanaFM verification required',
      'browser_verification_required',
    );

    expect(driverModule.createSolanaPublicFallbackUnavailableError).toBeTypeOf('function');
    const error = driverModule.createSolanaPublicFallbackUnavailableError?.(solscanError, [
      explorerError,
      solanaFmError,
    ]);

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error?.reason).toBe('browser_verification_required');
    expect(error?.message).toContain('公开交易浏览器');
  });

  it('does not wait for public Solana fallbacks after Solscan shows browser verification', async () => {
    const visitedUrls: string[] = [];
    const fakePage = {
      goto(url: string) {
        visitedUrls.push(url);
        return Promise.resolve();
      },
      locator(selector: string) {
        expect(selector).toBe('body');
        return {
          innerText() {
            return Promise.resolve('Checking if the site connection is secure before proceeding');
          },
        };
      },
      waitForTimeout() {
        return Promise.resolve();
      },
    };
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as unknown as {
      extractSolanaTransaction?: (
        page: typeof fakePage,
        txHash: string,
        options: { timeoutMs?: number },
      ) => Promise<unknown>;
    };

    await expect(
      driverModule.extractSolanaTransaction?.(fakePage, SOLANA_TX, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      reason: 'browser_verification_required',
    } satisfies Partial<TxAnalysisProviderUnavailableError>);
    expect(visitedUrls).toEqual([`https://solscan.io/tx/${SOLANA_TX}`]);
  });

  it('uses tx_not_found when public Solana fallbacks parse no transaction context for non-verification failures', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createSolanaPublicFallbackUnavailableError?: (
        cause: Error,
        fallbackErrors: unknown[],
      ) => TxAnalysisProviderUnavailableError;
    };

    const error = driverModule.createSolanaPublicFallbackUnavailableError?.(
      new Error('Solscan page did not contain transaction details'),
      [new Error('Solana Explorer missing transaction'), new Error('SolanaFM missing transaction')],
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error?.reason).toBe('tx_not_found');
  });

  it('keeps public Solana fallback timeouts retryable instead of reporting tx_not_found', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createSolanaPublicFallbackUnavailableError?: (
        cause: Error,
        fallbackErrors: unknown[],
      ) => TxAnalysisProviderUnavailableError;
    };

    const error = driverModule.createSolanaPublicFallbackUnavailableError?.(
      new Error('Solscan page.goto: net::ERR_TIMED_OUT'),
      [
        new Error('Solana Explorer page.goto: Timeout 1000ms exceeded.'),
        new Error('SolanaFM page.goto: net::ERR_TIMED_OUT'),
      ],
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error?.reason).toBe('timeout');
    expect(error?.message).toContain('公开交易浏览器');
  });

  it('keeps public Solana fallback NS_ERROR_NET_TIMEOUT failures retryable', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createSolanaPublicFallbackUnavailableError?: (
        cause: Error,
        fallbackErrors: unknown[],
      ) => TxAnalysisProviderUnavailableError;
    };

    const error = driverModule.createSolanaPublicFallbackUnavailableError?.(
      new Error('Solscan page.goto: NS_ERROR_NET_TIMEOUT'),
      [
        new Error('Solana Explorer page.goto: NS_ERROR_NET_TIMEOUT'),
        new Error('SolanaFM page.goto: NS_ERROR_NET_TIMEOUT'),
      ],
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error?.reason).toBe('timeout');
    expect(error?.message).toContain('公开交易浏览器');
  });

  it('keeps public Solana fallback low-level network timeouts retryable', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createSolanaPublicFallbackUnavailableError?: (
        cause: Error,
        fallbackErrors: unknown[],
      ) => TxAnalysisProviderUnavailableError;
    };

    const error = driverModule.createSolanaPublicFallbackUnavailableError?.(
      new Error('Solscan connect ETIMEDOUT 104.18.12.34:443'),
      [
        new Error('Solana Explorer connect ETIMEDOUT 104.18.13.34:443'),
        new Error('SolanaFM connect ETIMEDOUT 104.18.14.34:443'),
      ],
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error?.reason).toBe('timeout');
    expect(error?.message).toContain('公开交易浏览器');
  });

  it('keeps public Solana fallback transient Chrome network failures retryable', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createSolanaPublicFallbackUnavailableError?: (
        cause: Error,
        fallbackErrors: unknown[],
      ) => TxAnalysisProviderUnavailableError;
    };

    const error = driverModule.createSolanaPublicFallbackUnavailableError?.(
      new Error('Solscan page.goto: ERR_EMPTY_RESPONSE'),
      [
        new Error('Solana Explorer page.goto: ERR_NAME_NOT_RESOLVED'),
        new Error('SolanaFM page.goto: ERR_EMPTY_RESPONSE'),
      ],
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error?.reason).toBe('provider_unavailable');
    expect(error?.message).toContain('ERR_EMPTY_RESPONSE');
    expect(error?.message).toContain('公开交易浏览器');
  });

  it('keeps public Solana fallback connection-closed Chrome failures retryable', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createSolanaPublicFallbackUnavailableError?: (
        cause: Error,
        fallbackErrors: unknown[],
      ) => TxAnalysisProviderUnavailableError;
    };

    const error = driverModule.createSolanaPublicFallbackUnavailableError?.(
      new Error('Solscan page.goto: ERR_CONNECTION_CLOSED'),
      [
        new Error('Solana Explorer page.goto: ERR_CONNECTION_CLOSED'),
        new Error('SolanaFM page.goto: ERR_CONNECTION_CLOSED'),
      ],
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error?.reason).toBe('provider_unavailable');
    expect(error?.message).toContain('ERR_CONNECTION_CLOSED');
    expect(error?.message).toContain('公开交易浏览器');
  });

  it('keeps public Solana fallback connection-refused Chrome failures retryable', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createSolanaPublicFallbackUnavailableError?: (
        cause: Error,
        fallbackErrors: unknown[],
      ) => TxAnalysisProviderUnavailableError;
    };

    const error = driverModule.createSolanaPublicFallbackUnavailableError?.(
      new Error('Solscan page.goto: ERR_CONNECTION_REFUSED'),
      [
        new Error('Solana Explorer page.goto: ERR_CONNECTION_REFUSED'),
        new Error('SolanaFM page.goto: ERR_CONNECTION_REFUSED'),
      ],
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error?.reason).toBe('provider_unavailable');
    expect(error?.message).toContain('ERR_CONNECTION_REFUSED');
    expect(error?.message).toContain('公开交易浏览器');
  });

  it('keeps public Solana fallback aborted-navigation Chrome failures retryable', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createSolanaPublicFallbackUnavailableError?: (
        cause: Error,
        fallbackErrors: unknown[],
      ) => TxAnalysisProviderUnavailableError;
    };

    const error = driverModule.createSolanaPublicFallbackUnavailableError?.(
      new Error('Solscan page.goto: ERR_ABORTED'),
      [
        new Error('Solana Explorer page.goto: ERR_ABORTED'),
        new Error('SolanaFM page.goto: ERR_ABORTED'),
      ],
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error?.reason).toBe('provider_unavailable');
    expect(error?.message).toContain('ERR_ABORTED');
    expect(error?.message).toContain('公开交易浏览器');
  });
});

describe('createXxyyTradeWindowQueryUnavailableError', () => {
  it('keeps XXYY structured trade window query timeouts retryable', () => {
    const error = createXxyyTradeWindowQueryUnavailableError(
      new Error('page.evaluate: Timeout 60000ms exceeded.'),
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error.reason).toBe('timeout');
    expect(error.message).toContain('XXYY 结构化交易窗口查询失败');
  });

  it('keeps XXYY structured trade window Chrome timed-out network errors retryable', () => {
    const error = createXxyyTradeWindowQueryUnavailableError(
      new Error('page.goto: net::ERR_TIMED_OUT at https://www.xxyy.io/sol/pool'),
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error.reason).toBe('timeout');
  });

  it('keeps XXYY structured trade window browser verification actionable', () => {
    const error = createXxyyTradeWindowQueryUnavailableError(
      new Error('www.xxyy.io needs to review the security of your connection before proceeding'),
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error.reason).toBe('browser_verification_required');
    expect(error.message).toContain('XXYY 结构化交易窗口查询失败');
  });

  it('treats blocked XXYY structured trade HTTP statuses as browser verification', () => {
    for (const message of [
      'XXYY trade search HTTP 401',
      'XXYY trade search HTTP 403',
      'XXYY trade search HTTP 1020',
    ]) {
      const error = createXxyyTradeWindowQueryUnavailableError(new Error(message));

      expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
      expect(error.reason).toBe('browser_verification_required');
    }
  });

  it('preserves transaction failure browser errors as tx_failed', () => {
    const error = createXxyyTradeWindowQueryUnavailableError(
      new Error('page.evaluate: Error: execution reverted while reading transaction details'),
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error.reason).toBe('tx_failed');
  });

  it('preserves numbered Solana instruction failures as tx_failed', () => {
    const error = createXxyyTradeWindowQueryUnavailableError(
      new Error('page.evaluate: Error: Instruction #3 Failed while reading transaction details'),
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error.reason).toBe('tx_failed');
  });

  it('preserves Solana pending signature browser errors as tx_pending', () => {
    const error = createXxyyTradeWindowQueryUnavailableError(
      new Error('page.evaluate: Error: Signature is not finalized yet'),
    );

    expect(error).toBeInstanceOf(TxAnalysisProviderUnavailableError);
    expect(error.reason).toBe('tx_pending');
  });

  it('classifies specific browser error messages instead of provider_unavailable', () => {
    expect(
      createXxyyTradeWindowQueryUnavailableError(
        new Error('target transaction not found in XXYY trade list'),
      ).reason,
    ).toBe('target_trade_not_found');
    expect(
      createXxyyTradeWindowQueryUnavailableError(
        new Error('XXYY pool not found after contract search'),
      ).reason,
    ).toBe('pool_not_found');
    expect(
      createXxyyTradeWindowQueryUnavailableError(
        new Error('Unable to mark target transaction row in original screenshot'),
      ).reason,
    ).toBe('screenshot_unavailable');
    expect(
      createXxyyTradeWindowQueryUnavailableError(new Error('transaction not found on explorer'))
        .reason,
    ).toBe('tx_not_found');
    expect(
      createXxyyTradeWindowQueryUnavailableError(
        new Error('Sorry, we are unable to locate this TxnHash'),
      ).reason,
    ).toBe('tx_not_found');
    expect(
      createXxyyTradeWindowQueryUnavailableError(new Error('This transaction hash does not exist'))
        .reason,
    ).toBe('tx_not_found');
    expect(
      createXxyyTradeWindowQueryUnavailableError(
        new Error('Etherscan shows this transaction hash cannot be found'),
      ).reason,
    ).toBe('tx_not_found');
    expect(
      createXxyyTradeWindowQueryUnavailableError(
        new Error('BaseScan says could not locate this TxnHash'),
      ).reason,
    ).toBe('tx_not_found');
    expect(
      createXxyyTradeWindowQueryUnavailableError(new Error('Solscan says signature not found'))
        .reason,
    ).toBe('tx_not_found');
    expect(
      createXxyyTradeWindowQueryUnavailableError(
        new Error('Solana Explorer says unable to locate this signature'),
      ).reason,
    ).toBe('tx_not_found');
    expect(
      createXxyyTradeWindowQueryUnavailableError(
        new Error('Solana Explorer says this signature could not be found'),
      ).reason,
    ).toBe('tx_not_found');
    expect(
      createXxyyTradeWindowQueryUnavailableError(
        new Error('Solscan says no transaction found for this signature'),
      ).reason,
    ).toBe('tx_not_found');
  });
});

describe('failure metadata helpers', () => {
  it('keeps EVM explorer context for failure reports', () => {
    expect(
      createEvmExplorerFailureMetadata({
        chain: 'base',
        contractAddress: '0xToken000000000000000000000000000000000000',
        explorerUrl: 'https://basescan.org/tx/0xabc',
        poolAddress: '0xPool0000000000000000000000000000000000000',
        poolCandidates: [],
        routerAddress: '0xRouter0000000000000000000000000000000000',
        signerAddress: '0xUser0000000000000000000000000000000000000',
        side: 'buy',
        transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
      }),
    ).toEqual({
      contractAddress: '0xToken000000000000000000000000000000000000',
      explorerUrl: 'https://basescan.org/tx/0xabc',
      poolAddress: '0xPool0000000000000000000000000000000000000',
      routerAddress: '0xRouter0000000000000000000000000000000000',
      targetTraderAddress: '0xUser0000000000000000000000000000000000000',
      transactionTime: '12:00:01 Jun 11, 2026 (UTC)',
    });
  });

  it('keeps Solana explorer context for failure reports', () => {
    expect(
      createSolanaExplorerFailureMetadata({
        contractAddress: 'So11111111111111111111111111111111111111112',
        poolAddress: 'Pool1111111111111111111111111111111111111111',
        poolCandidates: [],
        signerAddress: 'UserTrader11111111111111111111111111111111111',
        side: 'buy',
        solscanUrl: 'https://solscan.io/tx/abc',
        transactionTime: '2026-06-11T00:00:01.000Z',
      }),
    ).toEqual({
      contractAddress: 'So11111111111111111111111111111111111111112',
      explorerUrl: 'https://solscan.io/tx/abc',
      poolAddress: 'Pool1111111111111111111111111111111111111111',
      targetTraderAddress: 'UserTrader11111111111111111111111111111111111',
      transactionTime: '2026-06-11T00:00:01.000Z',
    });
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

  it('matches abbreviated EVM pool addresses without depending on checksum casing', () => {
    const poolAddress = '0xAbCdEf1234567890aBCdEF1234567890ABcDeF12';

    const index = selectMatchingSearchItemIndex(
      [{ text: 'TOKEN / ETH Pair: 0xffff...ffff' }, { text: 'TOKEN / ETH Pair: 0xabc...ef12' }],
      poolAddress,
    );

    expect(index).toBe(1);
  });

  it('matches XXYY search results that show the full pool address', () => {
    const poolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';

    const index = selectMatchingSearchItemIndex(
      [
        { text: 'BRIM / SOL Pair: HgRhjDqfjiU3Eq2p9cJ9w1ZpKjX9wKZo8j7DGdcGdgNE' },
        { text: `BRIM / SOL Pair: ${poolAddress}` },
      ],
      poolAddress,
    );

    expect(index).toBe(1);
  });

  it('matches abbreviated pool addresses when XXYY search results use a single ellipsis character', () => {
    const evmPoolAddress = '0xAbCdEf1234567890aBCdEF1234567890ABcDeF12';
    const solanaPoolAddress = '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7';

    expect(
      selectMatchingSearchItemIndex(
        [{ text: 'TOKEN / ETH Pair: 0xffff…ffff' }, { text: 'TOKEN / ETH Pair: 0xabc…ef12' }],
        evmPoolAddress,
      ),
    ).toBe(1);
    expect(
      selectMatchingSearchItemIndex(
        [{ text: 'BRIM / SOL Pair: 1111…1111' }, { text: 'BRIM / SOL Pair: 9hXD…MyJ7' }],
        solanaPoolAddress,
      ),
    ).toBe(1);
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
        summary: 'XXYY sell $1 10 token 0.1 SOL',
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

  it('uses the configured chain native symbol in structured XXYY trade summaries', () => {
    const result = buildXxyyTradeWindow({
      afterTrades: [],
      beforeTrades: [],
      nativeSymbol: 'ETH',
      targetTrade: trade('target', 'target-maker', 'buy', 1000, { nativeAmount: '0.25' }),
    });

    expect(result.targetTrade.summary).toBe('XXYY buy $1 10 token 0.25 ETH');
    expect(result.targetTrade.summary).not.toContain('SOL');
  });

  it('normalizes numeric string timestamps from XXYY API trade records', () => {
    const result = buildXxyyTradeWindow({
      afterTrades: [],
      beforeTrades: [],
      targetTrade: {
        ...trade('target', 'target-maker', 'buy', 1000),
        timestamp: '1718064001000',
      },
    });

    expect(result.targetTrade.timestamp).toBe('2024-06-11T00:00:01.000Z');
  });
});

describe('createXxyyTargetTimeSearchWindow', () => {
  it('builds a narrow target-centered search range for XXYY trade lookup', () => {
    expect(createXxyyTargetTimeSearchWindow(1_000_000)).toEqual({
      timeEnd: 1_030_000,
      timeStart: 970_000,
    });
  });
});

describe('queryXxyyTradeWindow', () => {
  it('throws when the XXYY structured trade search returns a non-ok HTTP status', async () => {
    const fakeFetch = (() =>
      Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
        ok: false,
        status: 503,
      } as Response)) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    try {
      await expect(
        queryXxyyTradeWindow(
          {
            evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
          } as never,
          {
            poolAddress: 'pool-1',
            signerAddress: 'target-maker',
            txHash: 'target-tx',
          },
        ),
      ).rejects.toThrow('HTTP 503');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('sends the XXYY chain header inferred from the pool URL when querying EVM trade windows', async () => {
    const observedChainHeaders: Array<string | undefined> = [];
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;
      const headers =
        init?.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : Array.isArray(init?.headers)
            ? Object.fromEntries(init.headers)
            : ((init?.headers ?? {}) as Record<string, string>);
      const chainHeader = headers['x-chain'] ?? headers['X-Chain'];
      observedChainHeaders.push(chainHeader);

      let data: Array<Record<string, unknown>>;
      if (chainHeader !== 'bsc') {
        data = [];
      } else if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    const originalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
    vi.stubGlobal('fetch', fakeFetch);
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: new URL('https://www.xxyy.io/bsc/pool-1'),
    });
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      if (originalLocationDescriptor === undefined) {
        delete (globalThis as { location?: unknown }).location;
      } else {
        Object.defineProperty(globalThis, 'location', originalLocationDescriptor);
      }
    }

    expect(observedChainHeaders).toContain('bsc');
    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('normalizes nested transaction link aliases after the page query returns raw trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const afterTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const result = await queryXxyyTradeWindow(
      {
        evaluate: () =>
          Promise.resolve({
            afterTrades: [
              {
                maker: 'after-maker',
                signature: { signatureLink: `https://basescan.org/tx/${afterTx}` },
                timestamp: 1718064002000,
                type: 'buy',
              },
            ],
            beforeTrades: [
              {
                maker: 'before-maker',
                timestamp: 1718063999000,
                tx: { txLink: `https://basescan.org/tx/${beforeTx}` },
                type: 'sell',
              },
            ],
            targetTrade: {
              maker: 'target-maker',
              timestamp: 1718064001000,
              transaction: { link: `https://basescan.org/tx/${targetTx}` },
              type: 'buy',
            },
          }),
      } as never,
      {
        poolAddress: 'pool-1',
        signerAddress: 'target-maker',
        txHash: targetTx,
      },
    );

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });
  });

  it('preserves nested pool address objects from structured XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            pair: { address: 'pool-1' },
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            pool: { poolAddress: 'pool-1' },
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            poolInfo: { pair_address: 'pool-1' },
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ poolAddress: 'pool-1', txHash: 'after-tx' }],
      beforeTrades: [{ poolAddress: 'pool-1', txHash: 'before-tx' }],
      targetTrade: { poolAddress: 'pool-1', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.before[0]?.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.after[0]?.poolAddress).toBe('pool-1');
  });

  it('preserves pool address aliases from structured XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            pairAddress: 'pool-1',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            pair_address: 'pool-1',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            poolAddress: 'pool-1',
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ poolAddress: 'pool-1', txHash: 'after-tx' }],
      beforeTrades: [{ poolAddress: 'pool-1', txHash: 'before-tx' }],
      targetTrade: { poolAddress: 'pool-1', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.before[0]?.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.after[0]?.poolAddress).toBe('pool-1');
  });

  it('preserves compact pool address aliases from structured XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            pairAddr: 'pool-1',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            pool_addr: 'pool-1',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            poolInfo: { poolAddr: 'pool-1' },
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ poolAddress: 'pool-1', txHash: 'after-tx' }],
      beforeTrades: [{ poolAddress: 'pool-1', txHash: 'before-tx' }],
      targetTrade: { poolAddress: 'pool-1', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.before[0]?.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.after[0]?.poolAddress).toBe('pool-1');
  });

  it('preserves pool ID aliases from structured XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            poolId: 'pool-1',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            pair_id: 'pool-1',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            marketInfo: { marketId: 'pool-1' },
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ poolAddress: 'pool-1', txHash: 'after-tx' }],
      beforeTrades: [{ poolAddress: 'pool-1', txHash: 'before-tx' }],
      targetTrade: { poolAddress: 'pool-1', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.before[0]?.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.after[0]?.poolAddress).toBe('pool-1');
  });

  it('preserves pool contract aliases from structured XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            poolContract: 'pool-1',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            pair_contract: 'pool-1',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            poolInfo: { liquidityPoolAddress: 'pool-1' },
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ poolAddress: 'pool-1', txHash: 'after-tx' }],
      beforeTrades: [{ poolAddress: 'pool-1', txHash: 'before-tx' }],
      targetTrade: { poolAddress: 'pool-1', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.before[0]?.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.after[0]?.poolAddress).toBe('pool-1');
  });

  it('preserves market, AMM, and LP pool aliases from structured XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            marketAddress: 'pool-1',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            amm_id: 'pool-1',
            maker: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            lpAddress: 'pool-1',
            maker: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ poolAddress: 'pool-1', txHash: 'after-tx' }],
      beforeTrades: [{ poolAddress: 'pool-1', txHash: 'before-tx' }],
      targetTrade: { poolAddress: 'pool-1', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.before[0]?.poolAddress).toBe('pool-1');
    expect(tradeWindow.tradeWindow.after[0]?.poolAddress).toBe('pool-1');
  });

  it('normalizes pool URL aliases from structured XXYY trade records', async () => {
    const poolAddress = '0x1234567890abcdef1234567890abcdef12345678';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            pairUrl: `https://www.xxyy.io/base/${poolAddress.toUpperCase()}`,
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            pool_url: `https://www.xxyy.io/base/${poolAddress}`,
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            poolInfo: { url: `https://www.xxyy.io/base/${poolAddress}` },
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress,
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ poolAddress, txHash: 'after-tx' }],
      beforeTrades: [{ poolAddress, txHash: 'before-tx' }],
      targetTrade: { poolAddress, txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.poolAddress).toBe(poolAddress);
    expect(tradeWindow.tradeWindow.before[0]?.poolAddress).toBe(poolAddress);
    expect(tradeWindow.tradeWindow.after[0]?.poolAddress).toBe(poolAddress);
  });

  it('normalizes pool link aliases from structured XXYY trade records', async () => {
    const poolAddress = '0x1234567890abcdef1234567890abcdef12345678';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            pairLink: `https://www.xxyy.io/base/${poolAddress.toUpperCase()}`,
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            market_link: `https://www.xxyy.io/base/${poolAddress}`,
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            poolInfo: { link: `https://www.xxyy.io/base/${poolAddress}` },
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress,
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ poolAddress, txHash: 'after-tx' }],
      beforeTrades: [{ poolAddress, txHash: 'before-tx' }],
      targetTrade: { poolAddress, txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.poolAddress).toBe(poolAddress);
    expect(tradeWindow.tradeWindow.before[0]?.poolAddress).toBe(poolAddress);
    expect(tradeWindow.tradeWindow.after[0]?.poolAddress).toBe(poolAddress);
  });

  it('preserves compact trader address aliases from structured XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            makerAddr: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            timestamp: 1718063999000,
            trader_addr: 'before-maker',
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
            wallet: { walletAddr: 'after-maker' },
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.traderAddress).toBe('target-maker');
    expect(tradeWindow.tradeWindow.before[0]?.traderAddress).toBe('before-maker');
    expect(tradeWindow.tradeWindow.after[0]?.traderAddress).toBe('after-maker');
  });

  it('normalizes trader URL aliases from structured XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            makerUrl: 'https://solscan.io/account/target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
            wallet_url: 'https://solscan.io/account/before-maker',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            timestamp: 1718064002000,
            trader: { url: 'https://solscan.io/account/after-maker' },
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.traderAddress).toBe('target-maker');
    expect(tradeWindow.tradeWindow.before[0]?.traderAddress).toBe('before-maker');
    expect(tradeWindow.tradeWindow.after[0]?.traderAddress).toBe('after-maker');
  });

  it('normalizes wallet-prefixed trader aliases from structured XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            makerWallet: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            timestamp: 1718063999000,
            trader_wallet: 'before-maker',
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
            userWallet: 'after-maker',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.traderAddress).toBe('target-maker');
    expect(tradeWindow.tradeWindow.before[0]?.traderAddress).toBe('before-maker');
    expect(tradeWindow.tradeWindow.after[0]?.traderAddress).toBe('after-maker');
  });

  it('preserves owner sender and from address aliases from structured XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            owner: { ownerAddress: 'target-maker' },
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            sender_address: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            fromAddress: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.traderAddress).toBe('target-maker');
    expect(tradeWindow.tradeWindow.before[0]?.traderAddress).toBe('before-maker');
    expect(tradeWindow.tradeWindow.after[0]?.traderAddress).toBe('after-maker');
  });

  it('normalizes trade and block time field aliases from XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            trade_time: 1718064001,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timeStamp: '2024-06-11T00:00:00.000Z',
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            tradeTime: 1718064002,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ timestamp: 1718064002, txHash: 'after-tx' }],
      beforeTrades: [{ timestamp: '2024-06-11T00:00:00.000Z', txHash: 'before-tx' }],
      targetTrade: { timestamp: 1718064001, txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });
    expect(tradeWindow.targetTrade.timestamp).toBe('2024-06-11T00:00:01.000Z');
    expect(tradeWindow.tradeWindow.before[0]?.timestamp).toBe('2024-06-11T00:00:00.000Z');
    expect(tradeWindow.tradeWindow.after[0]?.timestamp).toBe('2024-06-11T00:00:02.000Z');
  });

  it('normalizes created and block timestamp aliases from XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            createdTime: 1718064001000,
            maker: 'target-maker',
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            block_timestamp: '2024-06-11T00:00:00.000Z',
            maker: 'before-maker',
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            blockTimestamp: 1718064002,
            maker: 'after-maker',
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ timestamp: 1718064002, txHash: 'after-tx' }],
      beforeTrades: [{ timestamp: '2024-06-11T00:00:00.000Z', txHash: 'before-tx' }],
      targetTrade: { timestamp: 1718064001000, txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });
    expect(tradeWindow.targetTrade.timestamp).toBe('2024-06-11T00:00:01.000Z');
    expect(tradeWindow.tradeWindow.before[0]?.timestamp).toBe('2024-06-11T00:00:00.000Z');
    expect(tradeWindow.tradeWindow.after[0]?.timestamp).toBe('2024-06-11T00:00:02.000Z');
  });

  it('normalizes event and transaction timestamp aliases from XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            eventTime: 1718064001000,
            maker: 'target-maker',
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            transacted_at: '2024-06-11T00:00:00.000Z',
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            transactionAt: 1718064002,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ timestamp: 1718064002, txHash: 'after-tx' }],
      beforeTrades: [{ timestamp: '2024-06-11T00:00:00.000Z', txHash: 'before-tx' }],
      targetTrade: { timestamp: 1718064001000, txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });
    expect(tradeWindow.targetTrade.timestamp).toBe('2024-06-11T00:00:01.000Z');
    expect(tradeWindow.tradeWindow.before[0]?.timestamp).toBe('2024-06-11T00:00:00.000Z');
    expect(tradeWindow.tradeWindow.after[0]?.timestamp).toBe('2024-06-11T00:00:02.000Z');
  });

  it('normalizes tx and execution timestamp aliases from XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            txHash: 'target-tx',
            txTime: 1718064001000,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            txn_time: '2024-06-11T00:00:00.000Z',
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            executedAt: 1718064002,
            maker: 'after-maker',
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ timestamp: 1718064002, txHash: 'after-tx' }],
      beforeTrades: [{ timestamp: '2024-06-11T00:00:00.000Z', txHash: 'before-tx' }],
      targetTrade: { timestamp: 1718064001000, txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });
    expect(tradeWindow.targetTrade.timestamp).toBe('2024-06-11T00:00:01.000Z');
    expect(tradeWindow.tradeWindow.before[0]?.timestamp).toBe('2024-06-11T00:00:00.000Z');
    expect(tradeWindow.tradeWindow.after[0]?.timestamp).toBe('2024-06-11T00:00:02.000Z');
  });

  it('normalizes millisecond timestamp aliases from XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestampMs: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            block_time_ms: 1718064000000,
            maker: 'before-maker',
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            createdAtMs: 1718064002000,
            maker: 'after-maker',
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ timestamp: 1718064002000, txHash: 'after-tx' }],
      beforeTrades: [{ timestamp: 1718064000000, txHash: 'before-tx' }],
      targetTrade: { timestamp: 1718064001000, txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });
    expect(tradeWindow.targetTrade.timestamp).toBe('2024-06-11T00:00:01.000Z');
    expect(tradeWindow.tradeWindow.before[0]?.timestamp).toBe('2024-06-11T00:00:00.000Z');
    expect(tradeWindow.tradeWindow.after[0]?.timestamp).toBe('2024-06-11T00:00:02.000Z');
  });

  it('skips empty timestamp aliases from XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            blockTime: 1718064001,
            maker: 'target-maker',
            time: '',
            timestamp: null,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            createdTime: 1718064000,
            maker: 'before-maker',
            timestamp: null,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            blockTimestamp: 1718064002,
            maker: 'after-maker',
            timestamp: ' ',
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ timestamp: 1718064002, txHash: 'after-tx' }],
      beforeTrades: [{ timestamp: 1718064000, txHash: 'before-tx' }],
      targetTrade: { timestamp: 1718064001, txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });
    expect(tradeWindow.targetTrade.timestamp).toBe('2024-06-11T00:00:01.000Z');
    expect(tradeWindow.tradeWindow.before[0]?.timestamp).toBe('2024-06-11T00:00:00.000Z');
    expect(tradeWindow.tradeWindow.after[0]?.timestamp).toBe('2024-06-11T00:00:02.000Z');
  });

  it('normalizes date time aliases from XXYY trade records', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            dateTime: '2024-06-11T00:00:01.000Z',
            maker: 'target-maker',
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            date_time: '2024-06-11T00:00:00.000Z',
            maker: 'before-maker',
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            datetime: '2024-06-11T00:00:02.000Z',
            maker: 'after-maker',
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ timestamp: '2024-06-11T00:00:02.000Z', txHash: 'after-tx' }],
      beforeTrades: [{ timestamp: '2024-06-11T00:00:00.000Z', txHash: 'before-tx' }],
      targetTrade: { timestamp: '2024-06-11T00:00:01.000Z', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });
    expect(tradeWindow.targetTrade.timestamp).toBe('2024-06-11T00:00:01.000Z');
    expect(tradeWindow.tradeWindow.before[0]?.timestamp).toBe('2024-06-11T00:00:00.000Z');
    expect(tradeWindow.tradeWindow.after[0]?.timestamp).toBe('2024-06-11T00:00:02.000Z');
  });

  it('treats Unix second timestamps from XXYY trade records as seconds', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;
      payloads.push(payload);

      const data =
        payload.makerAddress === 'target-maker'
          ? [
              {
                maker: 'target-maker',
                timestamp: 1718064001,
                txHash: 'target-tx',
                type: 'buy',
              },
            ]
          : [];

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result.targetTrade).toMatchObject({
      timestamp: 1718064001,
      txHash: 'target-tx',
    });
    expect(payloads[1]).toMatchObject({ timeEnd: 1718064000999 });
    expect(payloads[2]).toMatchObject({ timeStart: 1718064001001 });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: [],
      beforeTrades: [],
      targetTrade: result.targetTrade!,
    });
    expect(tradeWindow.targetTrade.timestamp).toBe('2024-06-11T00:00:01.000Z');
  });

  it('uses decimal Unix second timestamp strings from XXYY trade records', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;
      payloads.push(payload);

      const data =
        payload.makerAddress === 'target-maker'
          ? [
              {
                maker: 'target-maker',
                timestamp: '1718064001.234',
                txHash: 'target-tx',
                type: 'buy',
              },
            ]
          : [];

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result.targetTrade).toMatchObject({
      timestamp: '1718064001.234',
      txHash: 'target-tx',
    });
    expect(payloads[1]).toMatchObject({ timeEnd: 1718064001233 });
    expect(payloads[2]).toMatchObject({ timeStart: 1718064001235 });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: [],
      beforeTrades: [],
      targetTrade: result.targetTrade!,
    });
    expect(tradeWindow.targetTrade.timestamp).toBe('2024-06-11T00:00:01.234Z');
  });

  it('uses ISO timestamp strings from XXYY trade records for window queries', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;
      payloads.push(payload);

      const data =
        payload.makerAddress === 'target-maker'
          ? [
              {
                maker: 'target-maker',
                timestamp: '2024-06-11T00:00:01.000Z',
                txHash: 'target-tx',
                type: 'buy',
              },
            ]
          : [];

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result.targetTrade).toMatchObject({
      timestamp: '2024-06-11T00:00:01.000Z',
      txHash: 'target-tx',
    });
    expect(payloads[1]).toMatchObject({ timeEnd: 1718064000999 });
    expect(payloads[2]).toMatchObject({ timeStart: 1718064001001 });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: [],
      beforeTrades: [],
      targetTrade: result.targetTrade!,
    });
    expect(tradeWindow.targetTrade.timestamp).toBe('2024-06-11T00:00:01.000Z');
  });

  it('normalizes localized trade side aliases from structured XXYY responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            direction: '买入',
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            trade_type: '卖出',
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            action: 'Buy',
            maker: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ txHash: 'after-tx', type: 'buy' }],
      beforeTrades: [{ txHash: 'before-tx', type: 'sell' }],
      targetTrade: { txHash: 'target-tx', type: 'buy' },
    });
    expect(result.targetTrade).toBeDefined();

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.side).toBe('buy');
    expect(tradeWindow.tradeWindow.before[0]?.side).toBe('sell');
    expect(tradeWindow.tradeWindow.after[0]?.side).toBe('buy');
  });

  it('normalizes compact and orderbook trade side aliases from structured XXYY responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            side: 'bid',
            timestamp: 1718064001000,
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            direction: 'ask',
            maker: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            action: 'B',
            maker: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ txHash: 'after-tx', type: 'buy' }],
      beforeTrades: [{ txHash: 'before-tx', type: 'sell' }],
      targetTrade: { txHash: 'target-tx', type: 'buy' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.side).toBe('buy');
    expect(tradeWindow.tradeWindow.before[0]?.side).toBe('sell');
    expect(tradeWindow.tradeWindow.after[0]?.side).toBe('buy');
  });

  it('normalizes order event and transaction type side aliases from structured XXYY responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            orderSide: 'buy',
            timestamp: 1718064001000,
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            transaction_type: 'sell',
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            eventType: 'buy',
            maker: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ txHash: 'after-tx', type: 'buy' }],
      beforeTrades: [{ txHash: 'before-tx', type: 'sell' }],
      targetTrade: { txHash: 'target-tx', type: 'buy' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.side).toBe('buy');
    expect(tradeWindow.tradeWindow.before[0]?.side).toBe('sell');
    expect(tradeWindow.tradeWindow.after[0]?.side).toBe('buy');
  });

  it('normalizes composite trade side phrases from structured XXYY responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            direction: 'Swap Buy',
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            sideText: 'Token Sell',
            timestamp: 1718063999000,
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            action: 'buy_token',
            maker: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ txHash: 'after-tx', type: 'buy' }],
      beforeTrades: [{ txHash: 'before-tx', type: 'sell' }],
      targetTrade: { txHash: 'target-tx', type: 'buy' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.side).toBe('buy');
    expect(tradeWindow.tradeWindow.before[0]?.side).toBe('sell');
    expect(tradeWindow.tradeWindow.after[0]?.side).toBe('buy');
  });

  it('normalizes trade side field name aliases from structured XXYY responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            tradeSide: 'buy',
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            side_text: 'sell',
            timestamp: 1718063999000,
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            timestamp: 1718064002000,
            trade_side: 'buy',
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ txHash: 'after-tx', type: 'buy' }],
      beforeTrades: [{ txHash: 'before-tx', type: 'sell' }],
      targetTrade: { txHash: 'target-tx', type: 'buy' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.side).toBe('buy');
    expect(tradeWindow.tradeWindow.before[0]?.side).toBe('sell');
    expect(tradeWindow.tradeWindow.after[0]?.side).toBe('buy');
  });

  it('normalizes extended trade side field aliases from structured XXYY responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            tradeDirection: 'buy',
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            tx_side: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            buySell: 'buy',
            maker: 'after-maker',
            order_type: 'buy',
            timestamp: 1718064002000,
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ txHash: 'after-tx', type: 'buy' }],
      beforeTrades: [{ txHash: 'before-tx', type: 'sell' }],
      targetTrade: { txHash: 'target-tx', type: 'buy' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.side).toBe('buy');
    expect(tradeWindow.tradeWindow.before[0]?.side).toBe('sell');
    expect(tradeWindow.tradeWindow.after[0]?.side).toBe('buy');
  });

  it('normalizes direction-style side aliases from structured XXYY responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            orderDirection: 'buy',
            timestamp: 1718064001000,
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            swapDirection: 'sell',
            timestamp: 1718063999000,
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            timestamp: 1718064002000,
            transactionDirection: 'buy',
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ txHash: 'after-tx', type: 'buy' }],
      beforeTrades: [{ txHash: 'before-tx', type: 'sell' }],
      targetTrade: { txHash: 'target-tx', type: 'buy' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.side).toBe('buy');
    expect(tradeWindow.tradeWindow.before[0]?.side).toBe('sell');
    expect(tradeWindow.tradeWindow.after[0]?.side).toBe('buy');
  });

  it('normalizes boolean-like trade side flags from structured XXYY responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            isBuy: 1,
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            is_sell: 'true',
            maker: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            is_buy: '1',
            maker: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ txHash: 'after-tx', type: 'buy' }],
      beforeTrades: [{ txHash: 'before-tx', type: 'sell' }],
      targetTrade: { txHash: 'target-tx', type: 'buy' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.side).toBe('buy');
    expect(tradeWindow.tradeWindow.before[0]?.side).toBe('sell');
    expect(tradeWindow.tradeWindow.after[0]?.side).toBe('buy');
  });

  it('normalizes gerund trade side text from structured XXYY responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            side: 'Buying',
            timestamp: 1718064001000,
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            side: 'Selling',
            timestamp: 1718063999000,
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            side: 'Buying',
            timestamp: 1718064002000,
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ txHash: 'after-tx', type: 'buy' }],
      beforeTrades: [{ txHash: 'before-tx', type: 'sell' }],
      targetTrade: { txHash: 'target-tx', type: 'buy' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.side).toBe('buy');
    expect(tradeWindow.tradeWindow.before[0]?.side).toBe('sell');
    expect(tradeWindow.tradeWindow.after[0]?.side).toBe('buy');
  });

  it('normalizes false boolean trade side flags from structured XXYY responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            isBuy: false,
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            isSell: false,
            maker: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            is_buy: 'false',
            maker: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ txHash: 'after-tx', type: 'sell' }],
      beforeTrades: [{ txHash: 'before-tx', type: 'buy' }],
      targetTrade: { txHash: 'target-tx', type: 'sell' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.side).toBe('sell');
    expect(tradeWindow.tradeWindow.before[0]?.side).toBe('buy');
    expect(tradeWindow.tradeWindow.after[0]?.side).toBe('sell');
  });

  it('does not infer a trade side when boolean trade side flags conflict', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            isBuy: false,
            isSell: false,
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            side: 'buy',
            timestamp: 1718063999000,
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            side: 'sell',
            timestamp: 1718064002000,
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result.targetTrade).toBeUndefined();
    expect(result.beforeTrades).toEqual([]);
    expect(result.afterTrades).toEqual([]);
  });

  it('normalizes common transaction hash and trader address aliases from XXYY trades', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            timestamp: 1718064001000,
            traderAddress: 'target-maker',
            transactionHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            timestamp: 1718063999000,
            trader_address: 'before-maker',
            transaction_hash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            signature: 'after-tx',
            timestamp: 1718064002000,
            trader: 'after-maker',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('normalizes transaction signature aliases from XXYY trades', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            transactionSignature: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            tx_signature: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            timestamp: 1718064002000,
            txnSignature: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('normalizes transaction explorer URL aliases from XXYY trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const afterTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txUrl: `https://basescan.org/tx/${targetTx.toUpperCase()}`,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            explorerUrl: `https://basescan.org/tx/${beforeTx}`,
            maker: 'before-maker',
            timestamp: 1718063999000,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            timestamp: 1718064002000,
            transactionUrl: `https://basescan.org/tx/${afterTx}`,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: targetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.hash).toBe(targetTx);
    expect(tradeWindow.tradeWindow.before[0]?.hash).toBe(beforeTx);
    expect(tradeWindow.tradeWindow.after[0]?.hash).toBe(afterTx);
  });

  it('normalizes nested transaction url fields from XXYY trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const afterTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            transaction: { url: `https://basescan.org/tx/${targetTx.toUpperCase()}` },
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            tx: { url: `https://basescan.org/tx/${beforeTx}` },
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            timestamp: 1718064002000,
            txn: { url: `https://basescan.org/tx/${afterTx}` },
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: targetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.hash).toBe(targetTx);
    expect(tradeWindow.tradeWindow.before[0]?.hash).toBe(beforeTx);
    expect(tradeWindow.tradeWindow.after[0]?.hash).toBe(afterTx);
  });

  it('normalizes nested explorer link objects from XXYY trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const afterTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            explorer: { url: `https://basescan.org/tx/${targetTx.toUpperCase()}` },
            maker: 'target-maker',
            timestamp: 1718064001000,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            scan: { link: `https://basescan.org/tx/${beforeTx}` },
            timestamp: 1718063999000,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            blockExplorer: { href: `https://basescan.org/tx/${afterTx}` },
            maker: 'after-maker',
            timestamp: 1718064002000,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: targetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });
  });

  it('normalizes transaction id aliases from XXYY trades', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txId: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            transaction_id: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            timestamp: 1718064002000,
            txn: { txnId: 'after-tx' },
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.hash).toBe('target-tx');
    expect(tradeWindow.tradeWindow.before[0]?.hash).toBe('before-tx');
    expect(tradeWindow.tradeWindow.after[0]?.hash).toBe('after-tx');
  });

  it('normalizes generic url and id transaction aliases from XXYY trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const afterTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            type: 'buy',
            url: `https://basescan.org/tx/${targetTx.toUpperCase()}`,
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            id: beforeTx,
            maker: 'before-maker',
            timestamp: 1718063999000,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            timestamp: 1718064002000,
            type: 'buy',
            url: `https://basescan.org/tx/${afterTx}`,
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: targetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.hash).toBe(targetTx);
    expect(tradeWindow.tradeWindow.before[0]?.hash).toBe(beforeTx);
    expect(tradeWindow.tradeWindow.after[0]?.hash).toBe(afterTx);
  });

  it('normalizes generic hash and id link aliases from XXYY trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const afterTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            hashUrl: `https://basescan.org/tx/${targetTx.toUpperCase()}`,
            maker: 'target-maker',
            timestamp: 1718064001000,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            hash_link: `https://basescan.org/tx/${beforeTx}`,
            maker: 'before-maker',
            timestamp: 1718063999000,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            idUrl: `https://basescan.org/tx/${afterTx}`,
            maker: 'after-maker',
            timestamp: 1718064002000,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: targetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.hash).toBe(targetTx);
    expect(tradeWindow.tradeWindow.before[0]?.hash).toBe(beforeTx);
    expect(tradeWindow.tradeWindow.after[0]?.hash).toBe(afterTx);
  });

  it('normalizes hash-specific URL and link transaction aliases from XXYY trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const afterTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHashUrl: `https://basescan.org/tx/${targetTx.toUpperCase()}`,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            transaction_hash_link: `https://basescan.org/tx/${beforeTx}`,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            signature: { signatureHashUrl: `https://basescan.org/tx/${afterTx}` },
            timestamp: 1718064002000,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: targetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.hash).toBe(targetTx);
    expect(tradeWindow.tradeWindow.before[0]?.hash).toBe(beforeTx);
    expect(tradeWindow.tradeWindow.after[0]?.hash).toBe(afterTx);
  });

  it('normalizes hash-specific href transaction aliases from XXYY trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const afterTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHashHref: `https://basescan.org/tx/${targetTx.toUpperCase()}`,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            transaction_hash_href: `https://basescan.org/tx/${beforeTx}`,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            signature: { signatureHashHref: `https://basescan.org/tx/${afterTx}` },
            timestamp: 1718064002000,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: targetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.hash).toBe(targetTx);
    expect(tradeWindow.tradeWindow.before[0]?.hash).toBe(beforeTx);
    expect(tradeWindow.tradeWindow.after[0]?.hash).toBe(afterTx);
  });

  it('normalizes direct href transaction aliases from XXYY trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const afterTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHref: `https://basescan.org/tx/${targetTx.toUpperCase()}`,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            transaction_href: `https://basescan.org/tx/${beforeTx}`,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            signature: { signatureHref: `https://basescan.org/tx/${afterTx}` },
            timestamp: 1718064002000,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: targetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.hash).toBe(targetTx);
    expect(tradeWindow.tradeWindow.before[0]?.hash).toBe(beforeTx);
    expect(tradeWindow.tradeWindow.after[0]?.hash).toBe(afterTx);
  });

  it('normalizes explorer and scan transaction link aliases from XXYY trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const afterTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            explorerHref: `https://basescan.org/tx/${targetTx.toUpperCase()}`,
            maker: 'target-maker',
            timestamp: 1718064001000,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            scan_url: `https://basescan.org/tx/${beforeTx}`,
            timestamp: 1718063999000,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            timestamp: 1718064002000,
            transaction: { blockExplorerHref: `https://basescan.org/tx/${afterTx}` },
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: targetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.hash).toBe(targetTx);
    expect(tradeWindow.tradeWindow.before[0]?.hash).toBe(beforeTx);
    expect(tradeWindow.tradeWindow.after[0]?.hash).toBe(afterTx);
  });

  it('normalizes generic href transaction aliases from XXYY trades', async () => {
    const targetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const afterTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            href: `https://basescan.org/tx/${targetTx.toUpperCase()}`,
            maker: 'target-maker',
            timestamp: 1718064001000,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            tx: { href: `https://basescan.org/tx/${beforeTx}` },
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            signature: { href: `https://basescan.org/tx/${afterTx}` },
            timestamp: 1718064002000,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: targetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: { maker: 'target-maker', txHash: targetTx },
    });

    const tradeWindow = buildXxyyTradeWindow({
      afterTrades: result.afterTrades,
      beforeTrades: result.beforeTrades,
      targetTrade: result.targetTrade!,
    });

    expect(tradeWindow.targetTrade.hash).toBe(targetTx);
    expect(tradeWindow.tradeWindow.before[0]?.hash).toBe(beforeTx);
    expect(tradeWindow.tradeWindow.after[0]?.hash).toBe(afterTx);
  });

  it('normalizes initiator trader aliases from XXYY trades', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            initiatorAddress: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            initiator_address: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            initiator: { address: 'after-maker' },
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('normalizes taker trader aliases from XXYY trades', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            takerAddress: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            taker_address: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            taker: { address: 'after-maker' },
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('normalizes signer trader aliases from XXYY trades', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            signerAddress: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            signer_address: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            signer: { address: 'after-maker' },
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('normalizes nested trader and transaction objects from XXYY trades', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: { address: 'target-maker' },
            timestamp: 1718064001000,
            transaction: { hash: 'target-tx' },
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            account: { address: 'before-maker' },
            timestamp: 1718063999000,
            transaction: { txHash: 'before-tx' },
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            timestamp: 1718064002000,
            tx: { transaction_hash: 'after-tx' },
            type: 'buy',
            wallet: { address: 'after-maker' },
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('normalizes from and fee payer trader aliases from XXYY trades', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            from: { address: 'target-maker' },
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            payer_address: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            feePayer: { address: 'after-maker' },
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('normalizes trader link aliases from structured XXYY trade responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            makerLink: 'https://www.xxyy.io/account/target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            signerLink: 'https://www.xxyy.io/account/before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            timestamp: 1718064002000,
            trader: { link: 'https://www.xxyy.io/account/after-maker' },
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('reads trade rows from paginated XXYY response objects', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let list: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        list = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        list = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        list = [
          {
            maker: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        list = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: { list } }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('reads trade rows from named XXYY trade response containers', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      if (payload.makerAddress === 'target-maker') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                trades: [
                  {
                    maker: 'target-maker',
                    timestamp: 1718064001000,
                    txHash: 'target-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeEnd === 1718064000999) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                transactions: [
                  {
                    maker: 'before-maker',
                    timestamp: 1718063999000,
                    txHash: 'before-tx',
                    type: 'sell',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeStart === 1718064001001) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              result: {
                trades: [
                  {
                    maker: 'after-maker',
                    timestamp: 1718064002000,
                    txHash: 'after-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('reads trade rows from XXYY trade list response containers', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      if (payload.makerAddress === 'target-maker') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                tradeList: [
                  {
                    maker: 'target-maker',
                    timestamp: 1718064001000,
                    txHash: 'target-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeEnd === 1718064000999) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                tx_list: [
                  {
                    maker: 'before-maker',
                    timestamp: 1718063999000,
                    txHash: 'before-tx',
                    type: 'sell',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeStart === 1718064001001) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              result: {
                transactionList: [
                  {
                    maker: 'after-maker',
                    timestamp: 1718064002000,
                    txHash: 'after-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('reads trade rows from GraphQL-style edge and node containers', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      if (payload.makerAddress === 'target-maker') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                trades: {
                  edges: [
                    {
                      cursor: 'target-cursor',
                      node: {
                        maker: 'target-maker',
                        timestamp: 1718064001000,
                        txHash: 'target-tx',
                        type: 'buy',
                      },
                    },
                  ],
                },
              },
            }),
        } as Response);
      }
      if (payload.timeEnd === 1718064000999) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              result: {
                edges: [
                  {
                    node: {
                      maker: 'before-maker',
                      timestamp: 1718063999000,
                      txHash: 'before-tx',
                      type: 'sell',
                    },
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeStart === 1718064001001) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                transactionList: {
                  nodes: [
                    {
                      maker: 'after-maker',
                      timestamp: 1718064002000,
                      txHash: 'after-tx',
                      type: 'buy',
                    },
                  ],
                },
              },
            }),
        } as Response);
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('reads trade rows from common wrapped XXYY response containers', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      if (payload.makerAddress === 'target-maker') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              payload: {
                dataList: [
                  {
                    maker: 'target-maker',
                    timestamp: 1718064001000,
                    txHash: 'target-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeEnd === 1718064000999) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              result: {
                resultList: [
                  {
                    maker: 'before-maker',
                    timestamp: 1718063999000,
                    txHash: 'before-tx',
                    type: 'sell',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeStart === 1718064001001) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                dataRows: [
                  {
                    maker: 'after-maker',
                    timestamp: 1718064002000,
                    txHash: 'after-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('reads trade rows from table and order response containers', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      if (payload.makerAddress === 'target-maker') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                tableData: [
                  {
                    maker: 'target-maker',
                    timestamp: 1718064001000,
                    txHash: 'target-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeEnd === 1718064000999) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              result: {
                tradeRows: [
                  {
                    maker: 'before-maker',
                    timestamp: 1718063999000,
                    txHash: 'before-tx',
                    type: 'sell',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeStart === 1718064001001) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              payload: {
                orderRows: [
                  {
                    maker: 'after-maker',
                    timestamp: 1718064002000,
                    txHash: 'after-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('reads trade rows from paginated XXYY trade response containers', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      if (payload.makerAddress === 'target-maker') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                page: {
                  content: [
                    {
                      maker: 'target-maker',
                      timestamp: 1718064001000,
                      txHash: 'target-tx',
                      type: 'buy',
                    },
                  ],
                },
              },
            }),
        } as Response);
      }
      if (payload.timeEnd === 1718064000999) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              pageData: {
                rows: [
                  {
                    maker: 'before-maker',
                    timestamp: 1718063999000,
                    txHash: 'before-tx',
                    type: 'sell',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeStart === 1718064001001) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              result: {
                results: [
                  {
                    maker: 'after-maker',
                    timestamp: 1718064002000,
                    txHash: 'after-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('reads trade rows from fill, swap, and event response containers', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      if (payload.makerAddress === 'target-maker') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                fills: [
                  {
                    maker: 'target-maker',
                    timestamp: 1718064001000,
                    txHash: 'target-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeEnd === 1718064000999) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              result: {
                swaps: [
                  {
                    maker: 'before-maker',
                    timestamp: 1718063999000,
                    txHash: 'before-tx',
                    type: 'sell',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeStart === 1718064001001) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              payload: {
                events: [
                  {
                    maker: 'after-maker',
                    timestamp: 1718064002000,
                    txHash: 'after-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('reads trade rows from activity, history, and transaction row response containers', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      if (payload.makerAddress === 'target-maker') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                historyList: [
                  {
                    maker: 'target-maker',
                    timestamp: 1718064001000,
                    txHash: 'target-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeEnd === 1718064000999) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              result: {
                activityRows: [
                  {
                    maker: 'before-maker',
                    timestamp: 1718063999000,
                    txHash: 'before-tx',
                    type: 'sell',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeStart === 1718064001001) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              payload: {
                transactionRows: [
                  {
                    maker: 'after-maker',
                    timestamp: 1718064002000,
                    txHash: 'after-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('reads trade rows from latest and recent XXYY response containers', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      if (payload.makerAddress === 'target-maker') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                latestTrades: [
                  {
                    maker: 'target-maker',
                    timestamp: 1718064001000,
                    txHash: 'target-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeEnd === 1718064000999) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              result: {
                recentTrades: [
                  {
                    maker: 'before-maker',
                    timestamp: 1718063999000,
                    txHash: 'before-tx',
                    type: 'sell',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeStart === 1718064001001) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              payload: {
                recentTransactions: [
                  {
                    maker: 'after-maker',
                    timestamp: 1718064002000,
                    txHash: 'after-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('skips non-trade arrays before structured XXYY trade rows', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      if (payload.makerAddress === 'target-maker') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                items: [{ label: 'Time' }, { label: 'Amount' }],
                trades: [
                  {
                    maker: 'target-maker',
                    timestamp: 1718064001000,
                    txHash: 'target-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }
      if (payload.timeEnd === 1718064000999) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                items: [{ label: 'Before filters' }],
                page: {
                  content: [
                    {
                      maker: 'before-maker',
                      timestamp: 1718063999000,
                      txHash: 'before-tx',
                      type: 'sell',
                    },
                  ],
                },
              },
            }),
        } as Response);
      }
      if (payload.timeStart === 1718064001001) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              result: {
                items: [{ label: 'After filters' }],
                results: [
                  {
                    maker: 'after-maker',
                    timestamp: 1718064002000,
                    txHash: 'after-tx',
                    type: 'buy',
                  },
                ],
              },
            }),
        } as Response);
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data: [] }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('normalizes snake_case fields from structured XXYY trade responses', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;
      payloads.push(payload);

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker_address: 'target-maker',
            native_amount: '0.5',
            price_usd: '0.01',
            timestamp: '1718064001000',
            token_amount: '1200',
            tx_hash: 'target-tx',
            type: 'buy',
            usd_amount: '10',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker_address: 'before-maker',
            timestamp: 1718063999000,
            tx_hash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker_address: 'after-maker',
            timestamp: 1718064002000,
            tx_hash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(payloads.slice(0, 3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ makerAddress: 'target-maker' }),
        expect.objectContaining({ timeEnd: 1718064000999 }),
        expect.objectContaining({ timeStart: 1718064001001 }),
      ]),
    );
    expect(result).toMatchObject({
      afterTrades: [
        {
          maker: 'after-maker',
          txHash: 'after-tx',
        },
      ],
      beforeTrades: [
        {
          maker: 'before-maker',
          txHash: 'before-tx',
        },
      ],
      targetTrade: {
        maker: 'target-maker',
        nativeAmount: '0.5',
        priceUsd: '0.01',
        tokenAmount: '1200',
        txHash: 'target-tx',
        usdAmount: '10',
      },
    });
  });

  it('normalizes compact transaction id aliases from structured XXYY trade responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txid: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            transactionID: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            signatureID: 'after-tx',
            timestamp: 1718064002000,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: 'after-tx' }],
      beforeTrades: [{ maker: 'before-maker', txHash: 'before-tx' }],
      targetTrade: { maker: 'target-maker', txHash: 'target-tx' },
    });
  });

  it('normalizes signature hash aliases from structured XXYY trade responses', async () => {
    const beforeTx =
      'https://solscan.io/tx/3PC8RMbLr9E6qS27PhM9c13fAkxrh2hKZATqGr5NSt8pbZx5Cz54dxGHECCVqwkRZVabD7vWThkYXQmzLPQzhyxT';
    const afterTx =
      'https://solscan.io/tx/4BfXxq6trreR94JfqCpRNZbRUjJ7tU1T1kaGXHM3gAG1Pyh5UFNN7u5VsVM9Drr5HczphkyL17EqfCpzWbLDv1FK';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            signature_hash: SOLANA_TX,
            timestamp: 1718064001000,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            signatureUrl: beforeTx,
            timestamp: 1718063999000,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            signatureHash: afterTx,
            timestamp: 1718064002000,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: SOLANA_TX,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [
        {
          maker: 'after-maker',
          txHash:
            '4BfXxq6trreR94JfqCpRNZbRUjJ7tU1T1kaGXHM3gAG1Pyh5UFNN7u5VsVM9Drr5HczphkyL17EqfCpzWbLDv1FK',
        },
      ],
      beforeTrades: [
        {
          maker: 'before-maker',
          txHash:
            '3PC8RMbLr9E6qS27PhM9c13fAkxrh2hKZATqGr5NSt8pbZx5Cz54dxGHECCVqwkRZVabD7vWThkYXQmzLPQzhyxT',
        },
      ],
      targetTrade: {
        maker: 'target-maker',
        txHash: SOLANA_TX,
      },
    });
  });

  it('normalizes transaction link aliases from structured XXYY trade responses', async () => {
    const evmTargetTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const beforeTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const afterTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txLink: `https://basescan.org/tx/${evmTargetTx}`,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            timestamp: 1718063999000,
            transactionLink: `https://basescan.org/tx/${beforeTx}`,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            signatureLink: `https://basescan.org/tx/${afterTx}`,
            timestamp: 1718064002000,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: evmTargetTx,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [
        {
          maker: 'after-maker',
          txHash: afterTx,
        },
      ],
      beforeTrades: [
        {
          maker: 'before-maker',
          txHash: beforeTx,
        },
      ],
      targetTrade: {
        maker: 'target-maker',
        txHash: evmTargetTx,
      },
    });
  });

  it('normalizes nested signature objects from structured XXYY trade responses', async () => {
    const beforeTx =
      '3PC8RMbLr9E6qS27PhM9c13fAkxrh2hKZATqGr5NSt8pbZx5Cz54dxGHECCVqwkRZVabD7vWThkYXQmzLPQzhyxT';
    const afterTx =
      '4BfXxq6trreR94JfqCpRNZbRUjJ7tU1T1kaGXHM3gAG1Pyh5UFNN7u5VsVM9Drr5HczphkyL17EqfCpzWbLDv1FK';
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            signature: {
              hash: SOLANA_TX,
            },
            timestamp: 1718064001000,
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            maker: 'before-maker',
            signature: {
              url: `https://solscan.io/tx/${beforeTx}?cluster=mainnet`,
            },
            timestamp: 1718063999000,
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            maker: 'after-maker',
            signature: {
              id: afterTx,
            },
            timestamp: 1718064002000,
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: SOLANA_TX,
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ maker: 'after-maker', txHash: afterTx }],
      beforeTrades: [{ maker: 'before-maker', txHash: beforeTx }],
      targetTrade: {
        maker: 'target-maker',
        txHash: SOLANA_TX,
      },
    });
  });

  it('normalizes amount-first aliases from structured XXYY trade responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      const data =
        payload.makerAddress === 'target-maker'
          ? [
              {
                amountNative: '0.75',
                amountToken: '1500',
                amountUsd: '25',
                makerAddress: 'target-maker',
                priceUSD: '0.015',
                timestamp: 1718064001000,
                txHash: 'target-tx',
                type: 'buy',
              },
            ]
          : [];

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      targetTrade: {
        nativeAmount: '0.75',
        priceUsd: '0.015',
        tokenAmount: '1500',
        txHash: 'target-tx',
        usdAmount: '25',
      },
    });
  });

  it('normalizes token quantity aliases from structured XXYY trade responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            baseTokenAmount: '1500',
            makerAddress: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            makerAddress: 'before-maker',
            timestamp: 1718063999000,
            tokenQuantity: '1200',
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            amountBaseToken: '1800',
            makerAddress: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ tokenAmount: '1800', txHash: 'after-tx' }],
      beforeTrades: [{ tokenAmount: '1200', txHash: 'before-tx' }],
      targetTrade: { tokenAmount: '1500', txHash: 'target-tx' },
    });
  });

  it('normalizes base amount aliases from structured XXYY trade responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            baseAmount: '1500',
            makerAddress: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            base_amount: '1200',
            makerAddress: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            amountBase: '1800',
            makerAddress: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ tokenAmount: '1800', txHash: 'after-tx' }],
      beforeTrades: [{ tokenAmount: '1200', txHash: 'before-tx' }],
      targetTrade: { tokenAmount: '1500', txHash: 'target-tx' },
    });
  });

  it('normalizes native token amount aliases from structured XXYY trade responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            makerAddress: 'target-maker',
            solAmount: '0.75',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            eth_amount: '0.5',
            makerAddress: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
            type: 'sell',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            bnbAmount: '0.25',
            makerAddress: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
            type: 'buy',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [{ nativeAmount: '0.25', txHash: 'after-tx' }],
      beforeTrades: [{ nativeAmount: '0.5', txHash: 'before-tx' }],
      targetTrade: { nativeAmount: '0.75', txHash: 'target-tx' },
    });
  });

  it('normalizes buyer and seller boolean aliases from structured XXYY trade responses', async () => {
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            isBuyer: 'true',
            makerAddress: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
          },
        ];
      } else if (payload.timeEnd === 1718064000999) {
        data = [
          {
            is_seller: true,
            makerAddress: 'before-maker',
            timestamp: 1718063999000,
            txHash: 'before-tx',
          },
        ];
      } else if (payload.timeStart === 1718064001001) {
        data = [
          {
            isSeller: 'yes',
            makerAddress: 'after-maker',
            timestamp: 1718064002000,
            txHash: 'after-tx',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(result).toMatchObject({
      afterTrades: [
        {
          maker: 'after-maker',
          txHash: 'after-tx',
          type: 'sell',
        },
      ],
      beforeTrades: [
        {
          maker: 'before-maker',
          txHash: 'before-tx',
          type: 'sell',
        },
      ],
      targetTrade: {
        maker: 'target-maker',
        txHash: 'target-tx',
        type: 'buy',
      },
    });
  });

  it('uses numeric timestamp math for after-trade queries when XXYY returns string timestamps', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;
      payloads.push(payload);
      const data =
        payload.makerAddress === 'target-maker'
          ? [
              {
                maker: 'target-maker',
                timestamp: '1718064001000',
                txHash: 'target-tx',
                type: 'buy',
              },
            ]
          : [];

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    try {
      await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(payloads[1]).toMatchObject({ timeEnd: 1718064000999 });
    expect(payloads[2]).toMatchObject({ timeStart: 1718064001001 });
  });

  it('recovers same-timestamp neighbors from a centered XXYY window when strict edges are empty', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const fakeFetch = ((
      _resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = typeof init?.body === 'string' ? init.body : '{}';
      const payload = JSON.parse(requestBody) as Record<string, unknown>;
      payloads.push(payload);

      let data: Array<Record<string, unknown>>;
      if (payload.makerAddress === 'target-maker') {
        data = [
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
        ];
      } else if (payload.timeEnd === 1718064000999 || payload.timeStart === 1718064001001) {
        data = [];
      } else if (
        payload.timeStart === 1718063971000 &&
        payload.timeEnd === 1718064031000 &&
        payload.pageSize === 100
      ) {
        data = [
          {
            maker: 'after-later-maker',
            timestamp: 1718064001000,
            txHash: 'after-later-tx',
            type: 'sell',
          },
          {
            maker: 'after-maker',
            timestamp: 1718064001000,
            txHash: 'after-tx',
            type: 'sell',
          },
          {
            maker: 'target-maker',
            timestamp: 1718064001000,
            txHash: 'target-tx',
            type: 'buy',
          },
          {
            maker: 'before-maker',
            timestamp: 1718064001000,
            txHash: 'before-tx',
            type: 'buy',
          },
          {
            maker: 'before-older-maker',
            timestamp: 1718063999500,
            txHash: 'before-older-tx',
            type: 'sell',
          },
        ];
      } else {
        data = [];
      }

      return Promise.resolve({
        json: () => Promise.resolve({ data }),
      } as Response);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fakeFetch);
    let result: Awaited<ReturnType<typeof queryXxyyTradeWindow>>;
    try {
      result = await queryXxyyTradeWindow(
        {
          evaluate: (script: string) => Promise.resolve((0, eval)(script) as unknown),
        } as never,
        {
          poolAddress: 'pool-1',
          signerAddress: 'target-maker',
          txHash: 'target-tx',
        },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(payloads[3]).toMatchObject({
      pageSize: 100,
      timeEnd: 1718064031000,
      timeStart: 1718063971000,
    });
    expect(result).toMatchObject({
      afterTrades: [
        {
          maker: 'after-maker',
          txHash: 'after-tx',
        },
        {
          maker: 'after-later-maker',
          txHash: 'after-later-tx',
        },
      ],
      beforeTrades: [
        {
          maker: 'before-maker',
          txHash: 'before-tx',
        },
        {
          maker: 'before-older-maker',
          txHash: 'before-older-tx',
        },
      ],
      targetTrade: {
        maker: 'target-maker',
        txHash: 'target-tx',
      },
    });
  });
});

describe('requireLocatedXxyyTradeWindow', () => {
  it('throws target_trade_not_found when XXYY does not locate the submitted transaction', () => {
    expect(() => requireLocatedXxyyTradeWindow(undefined, 'target-tx')).toThrow(
      TxAnalysisProviderUnavailableError,
    );
    expect(() => requireLocatedXxyyTradeWindow(undefined, 'target-tx')).toThrow(
      '未在 XXYY 池子成交列表中定位目标交易',
    );
    try {
      requireLocatedXxyyTradeWindow(undefined, 'target-tx');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'target_trade_not_found' });
    }
  });
});

describe('xxyyTransactionHashMatches', () => {
  it('trims hashes and matches EVM hashes case-insensitively while preserving Solana casing', () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    expect(xxyyTransactionHashMatches(` ${evmTx.toUpperCase()}\n`, evmTx)).toBe(true);
    expect(xxyyTransactionHashMatches(` ${SOLANA_TX}\n`, SOLANA_TX)).toBe(true);
    expect(xxyyTransactionHashMatches(SOLANA_TX.toLowerCase(), SOLANA_TX)).toBe(false);
  });

  it('matches transaction explorer links against the submitted bare hash', () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      xxyyTransactionHashMatches(`https://basescan.org/tx/${evmTx.toUpperCase()}`, evmTx),
    ).toBe(true);
    expect(xxyyTransactionHashMatches(`https://solscan.io/tx/${SOLANA_TX}`, SOLANA_TX)).toBe(true);
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

describe('calculateInitialXxyyOriginalTargetPosition', () => {
  it('positions a near-top target trade without waiting for a new list response', () => {
    expect(
      calculateInitialXxyyOriginalTargetPosition({
        afterTradeCount: 2,
        clientHeight: 320,
        rowHeight: 40,
        scrollTop: 0,
      }),
    ).toEqual({
      rowHeight: 40,
      targetIndex: 2,
      targetRowY: 100,
    });
  });

  it('does not guess the initial target position when the newer-side window is capped', () => {
    expect(
      calculateInitialXxyyOriginalTargetPosition({
        afterTradeCount: 5,
        clientHeight: 320,
        rowHeight: 40,
        scrollTop: 0,
      }),
    ).toBeUndefined();
  });
});

describe('createXxyyOriginalTradeRowSelector', () => {
  it('covers common XXYY original trade row DOM shapes for target screenshot marking', () => {
    const selector = createXxyyOriginalTradeRowSelector();

    expect(selector).toContain('.row.row-clickable');
    expect(selector).toContain('.row');
    expect(selector).toContain('.trade-row');
    expect(selector).toContain('.transaction-row');
    expect(selector).toContain('[data-testid="trade-row"]');
    expect(selector).toContain('[data-testid="transaction-row"]');
    expect(selector).toContain('[data-role="trade-row"]');
    expect(selector).toContain('[data-role="transaction-row"]');
    expect(selector).toContain('.trade-table__row');
    expect(selector).toContain('.transaction-table__row');
    expect(selector).toContain('[role="row"]');
    expect(selector).toContain('tr');
    expect(selector).toContain('.vue-recycle-scroller__item-view');
  });

  it('covers data-grid and virtualized row shapes used by original trade tables', () => {
    const selector = createXxyyOriginalTradeRowSelector();

    expect(selector).toContain('.ag-row');
    expect(selector).toContain('.MuiDataGrid-row');
    expect(selector).toContain('.MuiTableRow-root');
    expect(selector).toContain('.ReactVirtualized__Table__row');
    expect(selector).toContain('[data-rowindex]');
    expect(selector).toContain('[data-row-index]');
    expect(selector).toContain('[data-row-key]');
    expect(selector).toContain('[data-record-key]');
  });
});

describe('createXxyyOriginalTradeListContainerSelector', () => {
  it('covers common XXYY original trade list container DOM shapes for target screenshots', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTradeListContainerSelector?: () => string;
    };

    expect(driverModule.createXxyyOriginalTradeListContainerSelector).toBeTypeOf('function');
    const selector = driverModule.createXxyyOriginalTradeListContainerSelector?.();

    expect(selector).toContain('.dashboard-bd-trades');
    expect(selector).toContain('[data-testid="trades"]');
    expect(selector).toContain('[data-testid="transactions"]');
    expect(selector).toContain('[data-testid="trade-list"]');
    expect(selector).toContain('[data-testid="transaction-list"]');
    expect(selector).toContain('[data-testid="tx-list"]');
    expect(selector).toContain('[data-testid="pool-trades"]');
    expect(selector).toContain('[data-testid="trades-table"]');
    expect(selector).toContain('[data-testid="transactions-table"]');
    expect(selector).toContain('[data-role="transactions"]');
    expect(selector).toContain('.trade-list');
    expect(selector).toContain('.transaction-list');
    expect(selector).toContain('.trades-list');
    expect(selector).toContain('.tx-list');
    expect(selector).toContain('.trade-table');
    expect(selector).toContain('.transactions-table');
    expect(selector).toContain('.pool-transactions');
    expect(selector).toContain('.latest-transactions');
    expect(selector).toContain('.ant-table-body');
    expect(selector).toContain('.el-table__body-wrapper');
    expect(selector).toContain('.arco-table-body');
    expect(selector).toContain('.n-data-table-base-table-body');
    expect(selector).toContain('.v-table__wrapper');
    expect(selector).toContain('.rc-virtual-list-holder');
    expect(selector).toContain('.virtuoso-scroller');
  });

  it('covers data-grid and virtualized trade list containers for target screenshots', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTradeListContainerSelector?: () => string;
    };

    const selector = driverModule.createXxyyOriginalTradeListContainerSelector?.();

    expect(selector).toContain('.ag-body-viewport');
    expect(selector).toContain('.ag-center-cols-viewport');
    expect(selector).toContain('.MuiDataGrid-virtualScroller');
    expect(selector).toContain('.MuiTableContainer-root');
    expect(selector).toContain('.ReactVirtualized__Grid');
    expect(selector).toContain('.ReactVirtualized__Grid__innerScrollContainer');
  });
});

describe('createXxyyOriginalTradeScrollerSelector', () => {
  it('covers virtual-list scrollers and plain scrollable trade list containers', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTradeScrollerSelector?: () => string;
    };

    expect(driverModule.createXxyyOriginalTradeScrollerSelector).toBeTypeOf('function');
    const selector = driverModule.createXxyyOriginalTradeScrollerSelector?.();

    expect(selector).toContain('.dashboard-bd-trades .vue-recycle-scroller');
    expect(selector).toContain('[data-testid="trade-list"] .vue-recycle-scroller');
    expect(selector).toContain('.dashboard-bd-trades');
    expect(selector).toContain('[data-testid="trade-list"]');
    expect(selector).toContain('.trades-list');
    expect(selector).toContain('[data-testid="transactions-table"] .vue-recycle-scroller');
    expect(selector).toContain('.transactions-table .vue-recycle-scroller');
    expect(selector).toContain('.pool-transactions');
  });
});

describe('createXxyyOriginalMetricRowSelector', () => {
  it('covers virtual-list items and plain table rows for screenshot scroll metrics', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalMetricRowSelector?: () => string;
    };

    expect(driverModule.createXxyyOriginalMetricRowSelector).toBeTypeOf('function');
    const selector = driverModule.createXxyyOriginalMetricRowSelector?.();

    expect(selector).toContain('.vue-recycle-scroller__item-view');
    expect(selector).toContain('.row.row-clickable');
    expect(selector).toContain('[data-testid="transaction-row"]');
    expect(selector).toContain('[role="row"]');
    expect(selector).toContain('tr');
    expect(selector).toContain('.ant-table-row');
    expect(selector).toContain('.el-table__row');
    expect(selector).toContain('.arco-table-tr');
    expect(selector).toContain('.n-data-table-tr');
    expect(selector).toContain('.v-data-table__tr');
    expect(selector).toContain('[data-index]');
  });
});

describe('createXxyyOriginalTargetRowAttributeNames', () => {
  it('collects explicit attributes and any custom data attribute from original trade rows', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      shouldCollectXxyyOriginalTargetRowAttributeName?: (name: string) => boolean;
    };

    const shouldCollect = driverModule.shouldCollectXxyyOriginalTargetRowAttributeName;

    expect(shouldCollect).toBeTypeOf('function');
    expect(shouldCollect?.('title')).toBe(true);
    expect(shouldCollect?.('aria-label')).toBe(true);
    expect(shouldCollect?.('data-order-tx-hash')).toBe(true);
    expect(shouldCollect?.('data-row_tx_url')).toBe(true);
    expect(shouldCollect?.('data-xxyy:signature')).toBe(true);
    expect(shouldCollect?.('class')).toBe(false);
    expect(shouldCollect?.('style')).toBe(false);
  });

  it('covers common DOM attributes that hide transaction hashes in XXYY rows', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    expect(driverModule.createXxyyOriginalTargetRowAttributeNames).toBeTypeOf('function');
    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('data-tx-hash');
    expect(attributeNames).toContain('data-txn');
    expect(attributeNames).toContain('data-txn-hash');
    expect(attributeNames).toContain('data-signature');
    expect(attributeNames).toContain('data-signature-hash');
    expect(attributeNames).toContain('data-tx-url');
    expect(attributeNames).toContain('data-txn-url');
    expect(attributeNames).toContain('data-transaction-url');
    expect(attributeNames).toContain('data-signature-url');
    expect(attributeNames).toContain('data-explorer-url');
    expect(attributeNames).toContain('data-href');
    expect(attributeNames).toContain('data-link');
    expect(attributeNames).toContain('data-url');
  });

  it('covers link-style DOM attributes that may store transaction explorer links', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('data-tx-link');
    expect(attributeNames).toContain('data-txn-link');
    expect(attributeNames).toContain('data-transaction-link');
    expect(attributeNames).toContain('data-signature-link');
    expect(attributeNames).toContain('data-explorer-link');
  });

  it('covers href-style DOM attributes that may store transaction explorer links', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('data-tx-href');
    expect(attributeNames).toContain('data-txn-href');
    expect(attributeNames).toContain('data-transaction-href');
    expect(attributeNames).toContain('data-signature-href');
    expect(attributeNames).toContain('data-explorer-href');
  });

  it('covers scan and block explorer DOM attributes that may store transaction explorer links', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('data-explorer');
    expect(attributeNames).toContain('data-scan');
    expect(attributeNames).toContain('data-scan-url');
    expect(attributeNames).toContain('data-scan-link');
    expect(attributeNames).toContain('data-scan-href');
    expect(attributeNames).toContain('data-block-explorer');
    expect(attributeNames).toContain('data-block-explorer-url');
    expect(attributeNames).toContain('data-block-explorer-link');
    expect(attributeNames).toContain('data-block-explorer-href');
  });

  it('covers generic hash and id URL/link/href attributes that may store transaction links', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('data-hash-url');
    expect(attributeNames).toContain('data-hash-link');
    expect(attributeNames).toContain('data-hash-href');
    expect(attributeNames).toContain('data-id-url');
    expect(attributeNames).toContain('data-id-link');
    expect(attributeNames).toContain('data-id-href');
  });

  it('covers native row href attributes that may store transaction explorer links', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('href');
  });

  it('covers common table row key attributes that may store the transaction hash', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('data-tx-id');
    expect(attributeNames).toContain('data-key');
    expect(attributeNames).toContain('data-id');
    expect(attributeNames).toContain('data-row-key');
    expect(attributeNames).toContain('data-row-id');
    expect(attributeNames).toContain('data-record-key');
    expect(attributeNames).toContain('data-record-id');
    expect(attributeNames).toContain('data-transaction-key');
  });

  it('covers compact transaction id attributes that may store transaction hashes', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('data-txid');
    expect(attributeNames).toContain('data-txnid');
    expect(attributeNames).toContain('data-transactionid');
    expect(attributeNames).toContain('data-signatureid');
  });

  it('covers compact and snake_case data attributes that may store transaction hashes', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('data-txhash');
    expect(attributeNames).toContain('data-tx_hash');
    expect(attributeNames).toContain('data-txn_hash');
    expect(attributeNames).toContain('data-transactionhash');
    expect(attributeNames).toContain('data-transaction_hash');
    expect(attributeNames).toContain('data-signaturehash');
    expect(attributeNames).toContain('data-signature_hash');
  });

  it('covers click and action attributes that may store transaction links', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('onclick');
    expect(attributeNames).toContain('data-onclick');
    expect(attributeNames).toContain('data-action');
    expect(attributeNames).toContain('data-row-action');
    expect(attributeNames).toContain('data-click-url');
    expect(attributeNames).toContain('data-clipboard');
  });

  it('covers copy and value attributes that may store hidden transaction hashes', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('data-copy-text');
    expect(attributeNames).toContain('data-copy-value');
    expect(attributeNames).toContain('data-clipboard-value');
    expect(attributeNames).toContain('data-value');
    expect(attributeNames).toContain('value');
  });

  it('covers copy URL and link attributes that may store hidden transaction links', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('data-copy-url');
    expect(attributeNames).toContain('data-copy-link');
    expect(attributeNames).toContain('data-copy-href');
    expect(attributeNames).toContain('data-clipboard-url');
    expect(attributeNames).toContain('data-clipboard-link');
    expect(attributeNames).toContain('data-clipboard-href');
  });

  it('covers tooltip and ARIA description attributes that may store hidden transaction hashes', async () => {
    const driverModule = (await import('./playwright-browser-tx-driver.js')) as {
      createXxyyOriginalTargetRowAttributeNames?: () => string[];
    };

    const attributeNames = driverModule.createXxyyOriginalTargetRowAttributeNames?.();

    expect(attributeNames).toContain('aria-description');
    expect(attributeNames).toContain('aria-describedby');
    expect(attributeNames).toContain('aria-labelledby');
    expect(attributeNames).toContain('data-tooltip');
    expect(attributeNames).toContain('data-tooltip-content');
    expect(attributeNames).toContain('data-tooltip-title');
    expect(attributeNames).toContain('data-tip');
  });
});

describe('selectXxyyOriginalTargetRowCandidate', () => {
  it('prefers the visible row containing the target transaction hash over the nearest row', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          {
            centerY: 98,
            hrefs: [
              'https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ],
            text: 'nearby unrelated trade',
          },
          {
            centerY: 150,
            hrefs: [`https://basescan.org/tx/${txHash}`],
            text: 'target row',
          },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(1);
  });

  it('matches common abbreviated transaction hash text in the original XXYY row', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 96, hrefs: [], text: '5uTP...Z4MH' },
          { centerY: 104, hrefs: [], text: 'Other trade' },
        ],
        targetTxHash: txHash,
        targetY: 104,
      }),
    ).toBe(0);
  });

  it('matches abbreviated transaction hash text when the original XXYY row uses a single ellipsis character', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 140, hrefs: [], text: '5uTP…Z4MH' },
          { centerY: 102, hrefs: [], text: 'nearby unrelated trade' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(0);
  });

  it('matches abbreviated transaction hash text when the original XXYY row uses two dots', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 140, hrefs: [], text: '5uTP..Z4MH' },
          { centerY: 102, hrefs: [], text: 'nearby unrelated trade' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(0);
  });

  it('matches abbreviated transaction hash text when the original XXYY row uses a horizontal ellipsis character', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 142, hrefs: [], text: '5uTP⋯Z4MH' },
          { centerY: 101, hrefs: [], text: 'nearby unrelated trade' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(0);
  });

  it('matches abbreviated EVM transaction hash text when spaces surround the ellipsis', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 101, hrefs: [], text: 'nearby unrelated trade' },
          { centerY: 150, hrefs: [], text: '0x1234 ... cdef' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(1);
  });

  it('matches URL-encoded abbreviated transaction hashes in original XXYY row links', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 101, hrefs: [], text: 'nearby unrelated trade' },
          {
            centerY: 150,
            hrefs: ['https://www.xxyy.io/base/pair?tx=0x1234%20...%20cdef'],
            text: 'open explorer',
          },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(1);
  });

  it('matches form-urlencoded abbreviated transaction hashes in original XXYY row links', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 101, hrefs: [], text: 'nearby unrelated trade' },
          {
            centerY: 150,
            hrefs: ['https://www.xxyy.io/base/pair?tx=0x1234+...+cdef'],
            text: 'open explorer',
          },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(1);
  });

  it('matches abbreviated EVM transaction hash text when newlines surround the ellipsis', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 101, hrefs: [], text: 'nearby unrelated trade' },
          { centerY: 150, hrefs: [], text: '0x1234   ...\n   cdef' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(1);
  });

  it('matches abbreviated transaction hash text when the original row uses dash separators', () => {
    const evmTxHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const solanaTxHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 101, hrefs: [], text: 'nearby unrelated trade' },
          { centerY: 150, hrefs: [], text: '0x1234 - cdef' },
        ],
        targetTxHash: evmTxHash,
        targetY: 100,
      }),
    ).toBe(1);
    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 101, hrefs: [], text: 'nearby unrelated trade' },
          {
            centerY: 150,
            hrefs: [],
            text: `${solanaTxHash.slice(0, 6)} — ${solanaTxHash.slice(-6)}`,
          },
        ],
        targetTxHash: solanaTxHash,
        targetY: 100,
      }),
    ).toBe(1);
  });

  it('matches longer abbreviated EVM transaction hash text in the original XXYY row', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 80, hrefs: [], text: 'nearby unrelated trade' },
          { centerY: 120, hrefs: [], text: 'target 0x1234567890...90abcdef buy' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(1);
  });

  it('matches target rows when the original XXYY row shows a 6-by-6 abbreviated Solana signature', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 101, hrefs: [], text: '9abcde...9abcde unrelated trade' },
          { centerY: 145, hrefs: [], text: `${txHash.slice(0, 6)}...${txHash.slice(-6)}` },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(1);
  });

  it('matches target rows when the original XXYY row stores the transaction hash in attributes', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const rows = [
      {
        attributes: [`Open transaction ${txHash}`],
        centerY: 150,
        hrefs: [],
        text: 'copy',
      },
      {
        attributes: [],
        centerY: 101,
        hrefs: [],
        text: 'nearby unrelated trade',
      },
    ];

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows,
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(0);
  });

  it('does not fall back to a nearby row when visible rows expose a different transaction hash', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          {
            centerY: 101,
            hrefs: [`https://basescan.org/tx/${otherTxHash}`],
            text: 'nearby unrelated trade',
          },
          { centerY: 170, hrefs: [], text: 'trade without visible hash' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(-1);
  });

  it('does not fall back to a nearby row when row attributes expose a different transaction hash', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const rows = [
      {
        attributes: [`Open transaction ${otherTxHash}`],
        centerY: 101,
        hrefs: [],
        text: 'copy',
      },
      {
        attributes: [],
        centerY: 120,
        hrefs: [],
        text: 'trade without visible hash',
      },
    ];

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows,
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(-1);
  });

  it('does not fall back to a nearby row when visible rows expose a different abbreviated transaction hash', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 101, hrefs: [], text: '0xaaaa...aaaa unrelated trade' },
          { centerY: 170, hrefs: [], text: 'trade without visible hash' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(-1);
  });

  it('does not fall back when visible rows expose a different URL-encoded abbreviated transaction hash', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          {
            centerY: 101,
            hrefs: ['https://www.xxyy.io/base/pair?tx=0xaaaa%20...%20aaaa'],
            text: 'nearby unrelated trade',
          },
          { centerY: 120, hrefs: [], text: 'trade without visible hash' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(-1);
  });

  it('does not fall back when visible rows expose a different form-urlencoded abbreviated transaction hash', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          {
            centerY: 101,
            hrefs: ['https://www.xxyy.io/base/pair?tx=0xaaaa+...+aaaa'],
            text: 'nearby unrelated trade',
          },
          { centerY: 120, hrefs: [], text: 'trade without visible hash' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(-1);
  });

  it('does not fall back when visible rows expose a different uppercase-prefix EVM transaction hash', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          {
            centerY: 101,
            hrefs: [],
            text: '0XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA unrelated trade',
          },
          { centerY: 170, hrefs: [], text: 'trade without visible hash' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(-1);
  });

  it('does not fall back when a different abbreviated transaction hash wraps around an ellipsis', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 101, hrefs: [], text: '0xaaaa   ...\n   aaaa unrelated trade' },
          { centerY: 120, hrefs: [], text: 'trade without visible hash' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(-1);
  });

  it('does not fall back when a different abbreviated transaction hash uses a dash separator', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 101, hrefs: [], text: '0xaaaa - aaaa unrelated trade' },
          { centerY: 120, hrefs: [], text: 'trade without visible hash' },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(-1);
  });

  it('does not match Solana target rows case-insensitively when marking the original screenshot', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 98, hrefs: [], text: txHash.toLowerCase() },
          { centerY: 142, hrefs: [], text: txHash },
        ],
        targetTxHash: txHash,
        targetY: 100,
      }),
    ).toBe(1);
  });

  it('falls back to the nearest visible row when the original row does not expose a hash', () => {
    expect(
      selectXxyyOriginalTargetRowCandidate({
        rowHeight: 40,
        rows: [
          { centerY: 60, hrefs: [], text: 'trade one' },
          { centerY: 101, hrefs: [], text: 'trade two' },
        ],
        targetTxHash: 'target-tx',
        targetY: 100,
      }),
    ).toBe(1);
  });
});

describe('markXxyyOriginalTargetTradeRow injected script', () => {
  it('keeps EVM transaction-reference detection case-insensitive before coordinate fallback', async () => {
    const source = await readFile(
      new URL('./playwright-browser-tx-driver.ts', import.meta.url),
      'utf8',
    );
    const markerStart = source.indexOf('async function markXxyyOriginalTargetTradeRow');
    const markerEnd = source.indexOf('function extractXxyyResponseTradeRows', markerStart);
    const markerSource = source.slice(markerStart, markerEnd);

    expect(markerSource).toContain('/\\\\b0x[a-fA-F0-9]{64}\\\\b/iu.test(haystackRaw)');
    expect(markerSource).toContain(
      '/\\\\b0x[a-fA-F0-9]{2,12}\\\\s*(?:\\\\.{2,3}|…|⋯|[-–—])\\\\s*[a-fA-F0-9]{4,12}\\\\b/iu.test(haystackRaw)',
    );
  });

  it('decodes URL-encoded row values before matching the target row', async () => {
    const source = await readFile(
      new URL('./playwright-browser-tx-driver.ts', import.meta.url),
      'utf8',
    );
    const markerStart = source.indexOf('async function markXxyyOriginalTargetTradeRow');
    const markerEnd = source.indexOf('function extractXxyyResponseTradeRows', markerStart);
    const markerSource = source.slice(markerStart, markerEnd);

    expect(markerSource).toContain('decodeURIComponent(value)');
  });

  it('normalizes form-urlencoded row values before matching the target row', async () => {
    const source = await readFile(
      new URL('./playwright-browser-tx-driver.ts', import.meta.url),
      'utf8',
    );
    const markerStart = source.indexOf('async function markXxyyOriginalTargetTradeRow');
    const markerEnd = source.indexOf('function extractXxyyResponseTradeRows', markerStart);
    const markerSource = source.slice(markerStart, markerEnd);

    expect(markerSource).toContain("const formEncodedValue = value.replace(/\\\\+/gu, ' ');");
  });

  it('reads live form-control values before matching the target row', async () => {
    const source = await readFile(
      new URL('./playwright-browser-tx-driver.ts', import.meta.url),
      'utf8',
    );
    const markerStart = source.indexOf('async function markXxyyOriginalTargetTradeRow');
    const markerEnd = source.indexOf('function extractXxyyResponseTradeRows', markerStart);
    const markerSource = source.slice(markerStart, markerEnd);

    expect(markerSource).toContain('element.value');
    expect(markerSource).toContain('HTMLInputElement');
    expect(markerSource).toContain('HTMLTextAreaElement');
    expect(markerSource).toContain('HTMLSelectElement');
    expect(markerSource).toContain('HTMLButtonElement');
  });

  it('follows ARIA tooltip references before matching the target row', async () => {
    const source = await readFile(
      new URL('./playwright-browser-tx-driver.ts', import.meta.url),
      'utf8',
    );
    const markerStart = source.indexOf('async function markXxyyOriginalTargetTradeRow');
    const markerEnd = source.indexOf('function extractXxyyResponseTradeRows', markerStart);
    const markerSource = source.slice(markerStart, markerEnd);

    expect(markerSource).toContain('aria-describedby');
    expect(markerSource).toContain('aria-labelledby');
    expect(markerSource).toContain('document.getElementById(referenceId)');
    expect(markerSource).toContain('const referencedText = referencedElement?.textContent;');
  });
});

describe('screenshotXxyyOriginalTradeList source safeguards', () => {
  it('applies XXYY original page time and trader filters before scrolling for the target row', async () => {
    const source = await readFile(
      new URL('./playwright-browser-tx-driver.ts', import.meta.url),
      'utf8',
    );
    const screenshotStart = source.indexOf('async function screenshotXxyyOriginalTradeList');
    const screenshotEnd = source.indexOf(
      'async function expandViewportForXxyyOriginalTradeListScreenshot',
      screenshotStart,
    );
    const screenshotSource = source.slice(screenshotStart, screenshotEnd);

    expect(screenshotSource).toContain(
      'await filterXxyyOriginalTradeListForTarget(page, tradeWindow, options);',
    );
    expect(source).toContain('async function filterXxyyOriginalTradeListForTarget');
    expect(source).toContain('#btn-filterTradeTimePopup');
    expect(source).toContain('#popup-filterTradeTimePopup input[placeholder=开始时间]');
    expect(source).toContain('#btn-filterTraderPopup');
    expect(source).toContain('#popup-filterTraderPopup input[placeholder=钱包地址]');
  });

  it('checks the filtered visible rows before waiting for more trade-list API responses', async () => {
    const source = await readFile(
      new URL('./playwright-browser-tx-driver.ts', import.meta.url),
      'utf8',
    );
    const scrollStart = source.indexOf('async function scrollXxyyOriginalTradeListToTarget');
    const scrollEnd = source.indexOf('async function readXxyyOriginalScrollerMetrics', scrollStart);
    const scrollSource = source.slice(scrollStart, scrollEnd);
    const visiblePositionIndex = scrollSource.indexOf(
      'const visiblePosition = await findVisibleXxyyOriginalTargetPosition',
    );
    const responseListenerIndex = scrollSource.indexOf('const responseListener = async');

    expect(visiblePositionIndex).toBeGreaterThanOrEqual(0);
    expect(responseListenerIndex).toBeGreaterThan(visiblePositionIndex);
    expect(source).toContain('function findVisibleXxyyOriginalTargetPosition');
    expect(source).toContain('formatXxyyOriginalVisibleTradeTime');
    expect(source).toContain('targetTraderAddress.slice(-6)');
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

  it('normalizes comma-grouped native SOL amounts from SolanaFM action text', () => {
    const candidates = extractSolanaFmPoolCandidates(`
      9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7
      sent
      1,234.500000
      Wrapped SOL
      →
      ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn
    `);

    expect(candidates).toEqual([
      {
        address: '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7',
        nativeAmount: '1234.5',
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

  it('matches native SOL amounts with thousands separators when selecting a pool', () => {
    const selected = selectXxyyPoolCandidate(
      [
        {
          address: '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7',
          nativeAmount: '42',
        },
        {
          address: 'HgRhWnmKZMJqNzjrhTixnJ5CSsM4GYPDjhBVnJd6dgNE',
          nativeAmount: '1,234.500000',
        },
      ],
      trade('target', 'target-maker', 'sell', 1000, { nativeAmount: '1234.5' }),
    );

    expect(selected?.address).toBe('HgRhWnmKZMJqNzjrhTixnJ5CSsM4GYPDjhBVnJd6dgNE');
  });

  it('matches comma-grouped SOL amounts from target trade summaries', () => {
    const selected = selectXxyyPoolCandidate(
      [
        {
          address: '9hXD8sti6UmCzAcYw1DjcyhsuHtry5MW8GPrx7rMMyJ7',
          nativeAmount: '42',
        },
        {
          address: 'HgRhWnmKZMJqNzjrhTixnJ5CSsM4GYPDjhBVnJd6dgNE',
          nativeAmount: '1234.5',
        },
      ],
      {
        hash: 'target-tx',
        side: 'buy',
        summary: 'XXYY buy 1,234.500000 SOL',
      },
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
