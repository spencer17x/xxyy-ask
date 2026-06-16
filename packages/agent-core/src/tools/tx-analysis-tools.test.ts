import { describe, expect, it } from 'vitest';

import {
  type TxAnalysisProvider,
  type TxAnalysisReportReader,
  createMockTxAnalysisProvider,
} from '@xxyy/rag-core';

import { createToolRegistry } from '../tool-registry.js';
import { TX_ANALYSIS_TOOL_NAMES, createTxAnalysisTools } from './tx-analysis-tools.js';

describe('createTxAnalysisTools', () => {
  it('exports the transaction analysis tool names in registration order', () => {
    expect(TX_ANALYSIS_TOOL_NAMES).toEqual([
      'analyze_transaction',
      'get_analysis_report',
      'list_analysis_reports',
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

  it('wraps an existing report document in the get_analysis_report output shape', async () => {
    const registry = createToolRegistry();
    const document = {
      generatedAt: '2026-06-16T00:00:00.000Z',
      reference: {
        chain: 'base',
        txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      },
      result: {
        analyzedAt: '2026-06-16T00:00:00.000Z',
        chain: 'base',
        confidence: 0.62,
        evidence: [],
        relatedTransactions: [],
        summary: 'fixture',
        txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        verdict: 'not_sandwiched',
      },
      status: 'success',
      version: 1,
    } satisfies Awaited<ReturnType<NonNullable<TxAnalysisReportReader['getReportDocument']>>>;
    const reportReader: TxAnalysisReportReader = {
      findReports() {
        return Promise.resolve([]);
      },
      getReportDocument(id) {
        expect(id).toBe('report-id');
        return Promise.resolve(document);
      },
      summarizeReports() {
        return Promise.resolve({
          byChain: {},
          byRuleVersion: {},
          failureCount: 0,
          failureReasons: {},
          latestReports: [],
          successCount: 0,
          totalCount: 0,
        });
      },
    };

    for (const tool of createTxAnalysisTools({ provider: undefined, reportReader })) {
      registry.register(tool);
    }

    await expect(registry.execute('get_analysis_report', { id: 'report-id' })).resolves.toEqual({
      document,
    });
  });

  it('returns empty report results when no report reader is configured', async () => {
    const registry = createToolRegistry();

    for (const tool of createTxAnalysisTools({ provider: undefined })) {
      registry.register(tool);
    }

    await expect(registry.execute('list_analysis_reports', {})).resolves.toEqual({ reports: [] });
    await expect(
      registry.execute('get_analysis_report', { id: 'missing-report' }),
    ).resolves.toEqual({});
  });
});
