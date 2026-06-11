import { describe, expect, it } from 'vitest';

import {
  createMockTxAnalysisProvider,
  createTxAnalysisAnswer,
  TxAnalysisProviderUnavailableError,
} from './tx-analysis.js';

describe('transaction analysis', () => {
  it('creates a fixture analysis result from the mock provider', async () => {
    const provider = createMockTxAnalysisProvider();

    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(result.txHash).toBe(
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    );
    expect(result.chain).toBe('base');
    expect(result.screenshotUrl).toBe('/assets/tx-analysis-fixture.svg');
    expect(result.summary).toContain('演示');
  });

  it('formats transaction analysis as a chat response with an image attachment', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 0.76,
      evidence: [
        {
          detail: '用户交易前后存在同向 swap 的 fixture 证据。',
          label: '前后交易模式',
          severity: 'warning',
        },
      ],
      relatedTransactions: [],
      screenshotUrl: '/assets/tx-analysis-fixture.svg',
      summary: '演示数据：疑似存在 sandwich 模式。',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
    });

    expect(response.intent).toBe('tx_sandwich_detection');
    expect(response.answer).toContain('疑似被夹');
    expect(response.answer).toContain('演示数据');
    expect(response.attachments).toEqual([
      {
        kind: 'image',
        mediaType: 'image/svg+xml',
        title: '交易分析截图',
        url: '/assets/tx-analysis-fixture.svg',
      },
    ]);
  });

  it('exposes a typed provider unavailable error', () => {
    expect(new TxAnalysisProviderUnavailableError('source down')).toBeInstanceOf(Error);
  });
});
