import { describe, expect, it } from 'vitest';

import { type TxAnalysisProvider, createMockTxAnalysisProvider } from '@xxyy/rag-core';

import { createToolRegistry } from '../tool-registry.js';
import {
  TX_ANALYSIS_TOOL_NAMES,
  analyzeTransactionInputSchema,
  createTxAnalysisTools,
} from './tx-analysis-tools.js';

describe('createTxAnalysisTools', () => {
  it('exports the transaction analysis tool names in registration order', () => {
    expect(TX_ANALYSIS_TOOL_NAMES).toEqual(['analyze_transaction']);
  });

  it('creates only the first-slice transaction analysis tool', () => {
    expect(createTxAnalysisTools({ provider: undefined }).map((tool) => tool.name)).toEqual([
      'analyze_transaction',
    ]);
  });

  it('registers analyze_transaction, strips channel, and returns success for a Base EVM transaction', async () => {
    const registry = createToolRegistry();
    const mockProvider = createMockTxAnalysisProvider({ analyzedAt: '2026-06-16T00:00:00.000Z' });
    let receivedReference: unknown;
    const provider: TxAnalysisProvider = {
      analyze(reference) {
        receivedReference = reference;
        return mockProvider.analyze(reference);
      },
    };

    for (const tool of createTxAnalysisTools({ provider })) {
      registry.register(tool);
    }

    await expect(
      registry.execute('analyze_transaction', {
        channel: 'web',
        chain: 'base',
        txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      }),
    ).resolves.toMatchObject({
      result: {
        analyzedAt: '2026-06-16T00:00:00.000Z',
        chain: 'base',
        dataSource: 'fixture',
        txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      },
      status: 'success',
    });
    expect(receivedReference).toEqual({
      chain: 'base',
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    });
  });

  it('rejects blank public MCP inputs at the schema boundary', () => {
    expect(analyzeTransactionInputSchema.safeParse({ txHash: '' }).success).toBe(false);
  });
});
