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
            dataSource: 'fixture',
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
});
