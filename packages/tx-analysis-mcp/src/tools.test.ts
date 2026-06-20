import { describe, expect, it } from 'vitest';

import { createTxAnalysisToolHandlers } from './tools.js';

const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

describe('tx analysis MCP tool handlers', () => {
  it('analyzes a transaction with the configured provider', async () => {
    const handlers = createTxAnalysisToolHandlers({
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

    await expect(
      handlers.analyzeTransaction({ chain: 'base', txHash: evmTx }),
    ).resolves.toMatchObject({
      result: {
        chain: 'base',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
      status: 'success',
    });
  });

  it('accepts an MCP channel marker without passing it to the provider reference', async () => {
    let providerReference: unknown;
    const handlers = createTxAnalysisToolHandlers({
      provider: {
        analyze(reference) {
          providerReference = reference;
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

    await expect(
      handlers.analyzeTransaction({ chain: 'base', channel: 'agent', txHash: evmTx }),
    ).resolves.toMatchObject({
      result: {
        chain: 'base',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
      status: 'success',
    });
    expect(providerReference).not.toHaveProperty('channel');
  });

  it('returns not_configured when the provider is missing', async () => {
    const handlers = createTxAnalysisToolHandlers({ provider: undefined });

    await expect(handlers.analyzeTransaction({ txHash: evmTx })).resolves.toEqual({
      failure: {
        message: 'Transaction analysis provider is not configured.',
        reason: 'not_configured',
      },
      status: 'failure',
    });
  });

  it('lists reports through the configured report reader', async () => {
    const handlers = createTxAnalysisToolHandlers({
      provider: undefined,
      reportReader: {
        findReports(input) {
          expect(input).toEqual({ chain: 'base', limit: 2 });
          return Promise.resolve([
            {
              chain: 'base',
              confidence: 0.6,
              generatedAt: '2026-06-14T00:00:00.000Z',
              reportUrl: '/assets/tx-analysis-report-base.json',
              status: 'success',
              txHash: evmTx,
              verdict: 'not_sandwiched',
            },
          ]);
        },
        summarizeReports() {
          throw new Error('summarize should not be called');
        },
      },
    });

    await expect(handlers.listAnalysisReports({ chain: 'base', limit: 2 })).resolves.toEqual({
      reports: [
        expect.objectContaining({
          chain: 'base',
          txHash: evmTx,
        }),
      ],
    });
  });

  it('gets a report document by id through the configured report reader', async () => {
    const handlers = createTxAnalysisToolHandlers({
      provider: undefined,
      reportReader: {
        findReports() {
          throw new Error('find should not be called');
        },
        getReportDocument(id) {
          expect(id).toBe('tx-analysis-report-base');
          return Promise.resolve({
            generatedAt: '2026-06-14T00:00:00.000Z',
            reference: { chain: 'base', txHash: evmTx },
            result: {
              analyzedAt: '2026-06-14T00:00:00.000Z',
              chain: 'base',
              confidence: 0.6,
              dataSource: 'browser',
              evidence: [],
              relatedTransactions: [],
              summary: '未发现典型 sandwich。',
              txHash: evmTx,
              verdict: 'not_sandwiched',
            },
            status: 'success',
            version: 1,
          });
        },
        summarizeReports() {
          throw new Error('summarize should not be called');
        },
      },
    });

    const output = await handlers.getAnalysisReport({ id: 'tx-analysis-report-base' });

    expect(output.document).toMatchObject({
      reference: { chain: 'base', txHash: evmTx },
      status: 'success',
    });
  });

  it('returns empty report lookup results when no report reader is configured', async () => {
    const handlers = createTxAnalysisToolHandlers({ provider: undefined });

    await expect(handlers.listAnalysisReports({ chain: 'base' })).resolves.toEqual({
      reports: [],
    });
    await expect(handlers.getAnalysisReport({ id: 'missing-report' })).resolves.toEqual({});
  });
});
