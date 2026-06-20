import { describe, expect, it, vi } from 'vitest';

import {
  analyzeTransaction,
  createConfiguredTxAnalysisProvider,
  createConfiguredTxAnalysisReportReader,
} from './tx-analysis-runtime.js';
import {
  TxAnalysisProviderUnavailableError,
  TxAnalysisUnsupportedChainError,
} from './tx-analysis.js';

const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

describe('tx-analysis-runtime', () => {
  it('returns not_configured when provider is disabled', async () => {
    await expect(
      analyzeTransaction({
        input: { txHash: evmTx },
        provider: undefined,
      }),
    ).resolves.toEqual({
      failure: {
        message: 'Transaction analysis provider is not configured.',
        reason: 'not_configured',
      },
      status: 'failure',
    });
  });

  it('returns invalid_reference for malformed input', async () => {
    await expect(
      analyzeTransaction({
        input: { txHash: 'not-a-transaction' },
        provider: {
          analyze() {
            throw new Error('provider should not be called');
          },
        },
      }),
    ).resolves.toEqual({
      failure: {
        message: 'Transaction reference is invalid or ambiguous.',
        reason: 'invalid_reference',
      },
      status: 'failure',
    });
  });

  it('returns unsupported_chain for known unsupported chain input', async () => {
    await expect(
      analyzeTransaction({
        input: { chain: 'Polygon', txHash: evmTx },
        provider: {
          analyze() {
            throw new Error('provider should not be called');
          },
        },
      }),
    ).resolves.toEqual({
      failure: {
        message: 'Transaction analysis does not support Polygon.',
        metadata: { unsupportedChainHint: 'Polygon' },
        reason: 'unsupported_chain',
      },
      status: 'failure',
    });
  });

  it('returns unsupported_chain for explicit unsupported chain before parsing malformed txHash', async () => {
    let providerCalled = false;

    await expect(
      analyzeTransaction({
        input: { chain: 'Polygon', txHash: 'not-a-transaction' },
        provider: {
          analyze() {
            providerCalled = true;
            throw new Error('provider should not be called');
          },
        },
      }),
    ).resolves.toEqual({
      failure: {
        message: 'Transaction analysis does not support Polygon.',
        metadata: { unsupportedChainHint: 'Polygon' },
        reason: 'unsupported_chain',
      },
      status: 'failure',
    });
    expect(providerCalled).toBe(false);
  });

  it('returns success results from the provider', async () => {
    const analyzed = await analyzeTransaction({
      input: { chain: 'base', txHash: evmTx },
      provider: {
        analyze(reference) {
          return Promise.resolve({
            analyzedAt: '2026-06-14T00:00:00.000Z',
            chain: reference.chain,
            confidence: 0.6,
            dataSource: 'browser',
            evidence: [],
            relatedTransactions: [],
            summary: '未发现典型 sandwich。',
            txHash: reference.txHash,
            verdict: 'not_sandwiched',
          });
        },
      },
    });

    expect(analyzed).toMatchObject({
      result: {
        chain: 'base',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
      status: 'success',
    });
  });

  it('returns structured unsupported chain failures from the provider', async () => {
    await expect(
      analyzeTransaction({
        input: { chain: 'base', txHash: evmTx },
        provider: {
          analyze() {
            throw new TxAnalysisUnsupportedChainError('Browser does not support Base testnet', {
              metadata: { unsupportedChainHint: 'base testnet' },
              reportUrl: '/assets/tx-analysis-unsupported-base-testnet.json',
            });
          },
        },
      }),
    ).resolves.toEqual({
      failure: {
        message: 'Browser does not support Base testnet',
        metadata: { unsupportedChainHint: 'base testnet' },
        reason: 'unsupported_chain',
        reportUrl: '/assets/tx-analysis-unsupported-base-testnet.json',
      },
      status: 'failure',
    });
  });

  it('returns structured provider failures', async () => {
    await expect(
      analyzeTransaction({
        input: { chain: 'base', txHash: evmTx },
        provider: {
          analyze() {
            throw new TxAnalysisProviderUnavailableError('BaseScan timeout', 'timeout', {
              reportUrl: '/assets/tx-analysis-failure-base.json',
            });
          },
        },
      }),
    ).resolves.toEqual({
      failure: {
        message: 'BaseScan timeout',
        reason: 'timeout',
        reportUrl: '/assets/tx-analysis-failure-base.json',
      },
      status: 'failure',
    });
  });

  it('creates no provider when TX_ANALYSIS_PROVIDER is none', () => {
    expect(createConfiguredTxAnalysisProvider({ txAnalysisProvider: 'none' })).toBeUndefined();
  });

  it('preserves unsupported TX_ANALYSIS_PROVIDER error messages', () => {
    expect(() =>
      createConfiguredTxAnalysisProvider({ txAnalysisProvider: 'future-provider' }),
    ).toThrow('Unsupported TX_ANALYSIS_PROVIDER: future-provider');
  });

  it('preserves unsupported TX_ANALYSIS_REVIEWER error messages', () => {
    expect(() =>
      createConfiguredTxAnalysisProvider({
        txAnalysisProvider: 'browser',
        txAnalysisReviewer: 'future-reviewer',
      }),
    ).toThrow('Unsupported TX_ANALYSIS_REVIEWER: future-reviewer');
  });

  it('preserves unsupported TX_ANALYSIS_REPORT_STORE error messages', () => {
    expect(() =>
      createConfiguredTxAnalysisProvider({
        txAnalysisProvider: 'browser',
        txAnalysisReportStore: 'memory',
      }),
    ).toThrow('Unsupported TX_ANALYSIS_REPORT_STORE: memory');
  });

  it('creates a file report reader from config', () => {
    const reader = createConfiguredTxAnalysisReportReader({
      txAnalysisReportStore: 'file',
      txAnalysisScreenshotDir: '/tmp/xxyy-tx-analysis-reports',
    });

    expect(typeof reader.findReports).toBe('function');
    expect(typeof reader.summarizeReports).toBe('function');
  });

  it('defaults the report reader store to file for partial config', () => {
    const reader = createConfiguredTxAnalysisReportReader({});

    expect(typeof reader.findReports).toBe('function');
    expect(typeof reader.summarizeReports).toBe('function');
  });

  it('preserves unsupported report reader store error messages', () => {
    expect(() =>
      createConfiguredTxAnalysisReportReader({
        txAnalysisReportStore: 'memory',
      }),
    ).toThrow('Unsupported TX_ANALYSIS_REPORT_STORE: memory');
  });

  it('treats blank screenshot dir as the default report directory', async () => {
    const createBrowserProvider = vi.fn((options: unknown) => {
      void options;
      return {
        analyze() {
          return Promise.reject(new Error('provider should not be called'));
        },
      };
    });
    const createDriver = vi.fn(() => ({
      analyze() {
        return Promise.reject(new Error('driver should not be called'));
      },
      analyzeSolanaTransaction() {
        return Promise.reject(new Error('driver should not be called'));
      },
    }));
    const reportWriter = {
      writeFailureReport: vi.fn(),
      writeReport: vi.fn(),
    };
    const createFileReportWriter = vi.fn(() => reportWriter);
    const findReports = vi.fn().mockResolvedValue([]);
    const getReportDocument = vi.fn().mockResolvedValue(undefined);
    const summarizeReports = vi.fn().mockResolvedValue({
      chains: {},
      failureReasons: {},
      generatedAt: '2026-06-14T00:00:00.000Z',
      recentReports: [],
      reviewStatuses: {},
      statuses: {},
      totalReports: 0,
    });
    const updateReportReview = vi.fn().mockResolvedValue(undefined);

    vi.resetModules();
    vi.doMock('./browser-tx-analysis.js', () => ({
      createBrowserTxAnalysisProvider: createBrowserProvider,
    }));
    vi.doMock('./playwright-browser-tx-driver.js', () => ({
      createPlaywrightBrowserTxAnalysisDriver: createDriver,
    }));
    vi.doMock('./tx-analysis-report-store.js', () => ({
      createFileTxAnalysisReportWriter: createFileReportWriter,
      createPgTxAnalysisReportStore: vi.fn(),
      findFileTxAnalysisReports: findReports,
      getFileTxAnalysisReportDocument: getReportDocument,
      summarizeFileTxAnalysisReports: summarizeReports,
      updateFileTxAnalysisReportReview: updateReportReview,
    }));

    try {
      const {
        createConfiguredTxAnalysisProvider: createProvider,
        createConfiguredTxAnalysisReportReader: createReportReader,
      } = await import('./tx-analysis-runtime.js');

      createProvider({
        txAnalysisProvider: 'browser',
        txAnalysisScreenshotDir: '   ',
      });
      expect(createDriver).toHaveBeenCalledWith({
        headless: false,
        screenshotBaseUrl: '/assets',
        timeoutMs: 60000,
      });
      expect(createFileReportWriter).toHaveBeenCalledWith({
        reportBaseUrl: '/assets',
      });

      const reader = createReportReader({
        txAnalysisReportStore: 'file',
        txAnalysisScreenshotDir: '   ',
      });
      await reader.findReports({ limit: 2 });
      await reader.getReportDocument?.('report-id');
      await reader.summarizeReports();
      await reader.updateReportReview?.({ id: 'report-id', status: 'closed' });

      expect(findReports).toHaveBeenCalledWith({ limit: 2 });
      expect(getReportDocument).toHaveBeenCalledWith({ id: 'report-id' });
      expect(summarizeReports).toHaveBeenCalledWith({});
      expect(updateReportReview).toHaveBeenCalledWith({ id: 'report-id', status: 'closed' });
    } finally {
      vi.doUnmock('./browser-tx-analysis.js');
      vi.doUnmock('./playwright-browser-tx-driver.js');
      vi.doUnmock('./tx-analysis-report-store.js');
      vi.resetModules();
    }
  });

  it('applies browser defaults for partial config', async () => {
    const createBrowserProvider = vi.fn((options: unknown) => {
      void options;
      return {
        analyze() {
          return Promise.reject(new Error('provider should not be called'));
        },
      };
    });
    const createDriver = vi.fn(() => ({
      analyze() {
        return Promise.reject(new Error('driver should not be called'));
      },
      analyzeSolanaTransaction() {
        return Promise.reject(new Error('driver should not be called'));
      },
    }));

    vi.resetModules();
    vi.doMock('./browser-tx-analysis.js', () => ({
      createBrowserTxAnalysisProvider: createBrowserProvider,
    }));
    vi.doMock('./playwright-browser-tx-driver.js', () => ({
      createPlaywrightBrowserTxAnalysisDriver: createDriver,
    }));

    try {
      const { createConfiguredTxAnalysisProvider: createProvider } =
        await import('./tx-analysis-runtime.js');

      expect(createProvider({ txAnalysisProvider: 'browser' })).toBeDefined();
      expect(createDriver).toHaveBeenCalledWith({
        headless: false,
        screenshotBaseUrl: '/assets',
        timeoutMs: 60000,
      });
      expect(createBrowserProvider).toHaveBeenCalledTimes(1);

      const providerOptions = createBrowserProvider.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(providerOptions).toMatchObject({
        maxConcurrentAnalyses: 1,
        maxRetries: 1,
      });
      expect(providerOptions).not.toHaveProperty('analysisReviewer');
      const reportWriter = providerOptions?.reportWriter;
      expect(reportWriter).toEqual(expect.any(Object));
      const reportWriterRecord = reportWriter as Record<string, unknown>;
      expect(typeof reportWriterRecord.writeFailureReport).toBe('function');
      expect(typeof reportWriterRecord.writeReport).toBe('function');
    } finally {
      vi.doUnmock('./browser-tx-analysis.js');
      vi.doUnmock('./playwright-browser-tx-driver.js');
      vi.resetModules();
    }
  });
});
