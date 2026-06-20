import { describe, expect, it } from 'vitest';

import {
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  TxAnalysisProviderUnavailableError,
} from './tx-analysis.js';

describe('transaction analysis', () => {
  it('formats transaction analysis as a chat response with an image attachment', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      analysisRuleVersion: 'sandwich-v1',
      chain: 'base',
      confidence: 0.76,
      dataSource: 'browser',
      evidence: [
        {
          detail: '用户交易前后存在同向 swap 的浏览器证据。',
          label: '前后交易模式',
          severity: 'warning',
        },
      ],
      contractAddress: '0xToken000000000000000000000000000000000000',
      relatedTransactions: [
        {
          explorerUrl:
            'https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          role: 'front_run',
          side: 'buy',
          summary: '疑似前置买入',
        },
      ],
      explorerUrl:
        'https://basescan.org/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      poolAddress: '0xPool0000000000000000000000000000000000000',
      reportUrl: '/assets/tx-analysis-report-base.json',
      routerAddress: '0xRouter0000000000000000000000000000000000',
      screenshotUrl: '/assets/tx-analysis-browser-window.svg',
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      targetTradeSide: 'buy',
      targetTraderAddress: '0xUser0000000000000000000000000000000000000',
      transactionTime: '2026-06-10T01:00:05.000Z',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
      xxyyPoolUrl: 'https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
    });

    expect(response.intent).toBe('tx_sandwich_detection');
    expect(response.answer).toContain('疑似被夹');
    expect(response.answer).toContain('浏览器取证');
    expect(response.answer).toContain(
      '交易浏览器：https://basescan.org/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    );
    expect(response.answer).toContain('交易地址：0xUser0000000000000000000000000000000000000');
    expect(response.answer).toContain('交易方向：买入');
    expect(response.answer).toContain('交易时间：2026-06-10T01:00:05.000Z');
    expect(response.answer).toContain('池子：0xPool0000000000000000000000000000000000000');
    expect(response.answer).toContain('合约：0xToken000000000000000000000000000000000000');
    expect(response.answer).toContain('路由合约：0xRouter0000000000000000000000000000000000');
    expect(response.answer).toContain('分析时间：2026-06-10T00:00:00.000Z');
    expect(response.answer).toContain('规则版本：sandwich-v1');
    expect(response.answer).toContain(
      'XXYY 池子页：https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
    );
    expect(response.answer).toContain('截图：/assets/tx-analysis-browser-window.svg');
    expect(response.answer).toContain(
      '前置交易：0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa，疑似前置买入，方向：买入，浏览器：https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(response.answer).toContain('/assets/tx-analysis-report-base.json');
    expect(response.attachments).toEqual([
      {
        kind: 'image',
        mediaType: 'image/svg+xml',
        title: '交易分析截图',
        url: '/assets/tx-analysis-browser-window.svg',
      },
    ]);
  });

  it('trims successful analysis report and screenshot URLs before formatting answers', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 0.76,
      dataSource: 'browser',
      evidence: [],
      relatedTransactions: [],
      reportUrl: '  /assets/tx-analysis-report-base.json  ',
      screenshotUrl: '  /assets/tx-analysis-browser-window.svg  ',
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
    });

    expect(response.answer).toContain('报告：/assets/tx-analysis-report-base.json');
    expect(response.answer).toContain('截图：/assets/tx-analysis-browser-window.svg');
    expect(response.answer).not.toContain('报告：  /assets');
    expect(response.answer).not.toContain('截图：  /assets');
    expect(response.attachments).toEqual([
      {
        kind: 'image',
        mediaType: 'image/svg+xml',
        title: '交易分析截图',
        url: '/assets/tx-analysis-browser-window.svg',
      },
    ]);
  });

  it('trims successful analysis evidence text before formatting answers', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 0.76,
      dataSource: 'browser',
      evidence: [
        {
          detail: '  用户交易前后存在同向 swap 证据。  ',
          label: '  前后交易模式  ',
          severity: 'warning',
        },
        {
          detail: '缺少标题，不应展示',
          label: '   ',
          severity: 'info',
        },
        {
          detail: '   ',
          label: '空内容证据',
          severity: 'info',
        },
      ],
      relatedTransactions: [],
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
    });

    expect(response.answer).toContain('前后交易模式（warning）：用户交易前后存在同向 swap 证据。');
    expect(response.answer).not.toContain('  前后交易模式');
    expect(response.answer).not.toContain('证据（info）：缺少标题');
    expect(response.answer).not.toContain('空内容证据（info）：');
  });

  it('removes human-review wording from customer-facing transaction answers', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 0.52,
      evidence: [
        {
          detail: '模型用 warn 表示需要人工关注。',
          label: '模型复核',
          severity: 'warning',
        },
      ],
      relatedTransactions: [],
      summary: '模型复核：证据偏弱，建议人工复查。',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'inconclusive',
    });

    expect(response.answer).toContain('摘要：模型复核：证据偏弱，建议复查。');
    expect(response.answer).toContain('模型复核（warning）：模型用 warn 表示需要关注。');
    expect(response.answer).not.toMatch(/人工复查|人工关注|人工接管|人工客服|转人工|工单/u);
  });

  it('clamps successful analysis confidence before formatting answers', () => {
    const highConfidenceResponse = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 1.42,
      evidence: [],
      relatedTransactions: [],
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
    });
    const lowConfidenceResponse = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: -0.2,
      evidence: [],
      relatedTransactions: [],
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
    });

    expect(highConfidenceResponse.answer).toContain('置信度 100%');
    expect(highConfidenceResponse.confidence).toBe(1);
    expect(lowConfidenceResponse.answer).toContain('置信度 0%');
    expect(lowConfidenceResponse.confidence).toBe(0);
  });

  it('normalizes successful analysis summary and analysis time before formatting answers', () => {
    const trimmedResponse = createTxAnalysisAnswer({
      analyzedAt: '  2026-06-10T00:00:00.000Z  ',
      chain: 'base',
      confidence: 0.76,
      evidence: [],
      relatedTransactions: [],
      summary: '  浏览器取证：疑似存在 sandwich 模式。  ',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
    });
    const blankSummaryResponse = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 0.76,
      evidence: [],
      relatedTransactions: [],
      summary: '   ',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'inconclusive',
    });

    expect(trimmedResponse.answer).toContain('摘要：浏览器取证：疑似存在 sandwich 模式。');
    expect(trimmedResponse.answer).toContain('分析时间：2026-06-10T00:00:00.000Z');
    expect(trimmedResponse.answer).not.toContain('摘要：  ');
    expect(trimmedResponse.answer).not.toContain('分析时间：  ');
    expect(blankSummaryResponse.answer).toContain('摘要：当前证据不足，无法确认是否被夹。');
  });

  it('omits blank successful analysis report and screenshot URLs from answers', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 0.76,
      evidence: [],
      relatedTransactions: [],
      reportUrl: '   ',
      screenshotUrl: '   ',
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
    });

    expect(response.answer).not.toContain('报告：');
    expect(response.answer).not.toContain('截图：');
    expect(response.attachments).toBeUndefined();
  });

  it('trims successful analysis review links and related transaction links before formatting answers', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 0.76,
      evidence: [],
      explorerUrl:
        '  https://basescan.org/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef  ',
      relatedTransactions: [
        {
          explorerUrl:
            '  https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ',
          hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          role: 'front_run',
          summary: '疑似前置买入',
        },
        {
          explorerUrl: '   ',
          hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          role: 'user',
          summary: '用户交易',
        },
      ],
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
      xxyyPoolUrl: '  https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000  ',
    });

    expect(response.answer).toContain(
      '交易浏览器：https://basescan.org/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    );
    expect(response.answer).toContain(
      'XXYY 池子页：https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
    );
    expect(response.answer).toContain(
      '前置交易：0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa，疑似前置买入，浏览器：https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(response.answer).toContain(
      '用户交易：0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb，用户交易',
    );
    expect(response.answer).not.toContain('交易浏览器：  https://');
    expect(response.answer).not.toContain('XXYY 池子页：  https://');
    expect(response.answer).not.toContain('浏览器：  https://');
    expect(response.answer).not.toContain('浏览器：   ');
  });

  it('trims successful analysis related transaction text before formatting answers', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 0.76,
      evidence: [],
      relatedTransactions: [
        {
          explorerUrl:
            'https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          hash: '  0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ',
          role: 'front_run',
          summary: '  疑似前置买入  ',
          timestamp: '  2026-06-10T01:00:01.000Z  ',
          traderAddress: '  0xAttacker000000000000000000000000000000000  ',
        },
        {
          hash: '   ',
          role: 'user',
          summary: '用户交易',
        },
        {
          hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          role: 'back_run',
          summary: '   ',
        },
      ],
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
    });

    expect(response.answer).toContain(
      '前置交易：0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa，疑似前置买入，交易者：0xAttacker000000000000000000000000000000000，时间：2026-06-10T01:00:01.000Z，浏览器：https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(response.answer).toContain(
      '后置交易：0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc，后置交易',
    );
    expect(response.answer).not.toContain('前置交易：  0x');
    expect(response.answer).not.toContain('，  疑似前置买入');
    expect(response.answer).not.toContain('交易者：  ');
    expect(response.answer).not.toContain('时间：  ');
    expect(response.answer).not.toContain('用户交易：   ');
  });

  it('deduplicates successful analysis related transactions before formatting answers', () => {
    const frontTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const userTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 0.76,
      evidence: [],
      relatedTransactions: [
        {
          hash: frontTx.toUpperCase(),
          role: 'related',
          summary: 'duplicate context front row',
        },
        {
          explorerUrl: `https://basescan.org/tx/${frontTx}`,
          hash: frontTx,
          role: 'front_run',
          summary: '疑似前置买入',
        },
        {
          hash: userTx.toUpperCase(),
          role: 'related',
          summary: 'duplicate target context row',
        },
        {
          explorerUrl: `https://basescan.org/tx/${userTx}`,
          hash: userTx,
          role: 'user',
          summary: '用户交易',
        },
      ],
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      txHash: userTx,
      verdict: 'sandwiched',
    });

    expect(response.answer).toContain(
      `前置交易：${frontTx}，疑似前置买入，浏览器：https://basescan.org/tx/${frontTx}`,
    );
    expect(response.answer).toContain(
      `用户交易：${userTx}，用户交易，浏览器：https://basescan.org/tx/${userTx}`,
    );
    expect(response.answer).not.toContain('duplicate context front row');
    expect(response.answer).not.toContain('duplicate target context row');
    expect(response.answer.match(/前置交易：/gu)).toHaveLength(1);
    expect(response.answer.match(/用户交易：/gu)).toHaveLength(1);
  });

  it('omits blank successful analysis review links before formatting answers', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      chain: 'base',
      confidence: 0.76,
      evidence: [],
      explorerUrl: '   ',
      relatedTransactions: [],
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
      xxyyPoolUrl: '   ',
    });

    expect(response.answer).not.toContain('交易浏览器：');
    expect(response.answer).not.toContain('XXYY 池子页：');
  });

  it('trims successful analysis review fields before formatting answers', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      analysisRuleVersion: '  sandwich-v1  ',
      chain: 'base',
      confidence: 0.76,
      contractAddress: '  0xToken000000000000000000000000000000000000  ',
      evidence: [],
      poolAddress: '  0xPool0000000000000000000000000000000000000  ',
      relatedTransactions: [],
      routerAddress: '  0xRouter0000000000000000000000000000000000  ',
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      targetTraderAddress: '  0xUser0000000000000000000000000000000000000  ',
      transactionTime: '  2026-06-10T01:00:05.000Z  ',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
    });

    expect(response.answer).toContain('交易地址：0xUser0000000000000000000000000000000000000');
    expect(response.answer).toContain('交易时间：2026-06-10T01:00:05.000Z');
    expect(response.answer).toContain('池子：0xPool0000000000000000000000000000000000000');
    expect(response.answer).toContain('合约：0xToken000000000000000000000000000000000000');
    expect(response.answer).toContain('路由合约：0xRouter0000000000000000000000000000000000');
    expect(response.answer).toContain('规则版本：sandwich-v1');
    expect(response.answer).not.toContain('交易地址：  ');
    expect(response.answer).not.toContain('交易时间：  ');
    expect(response.answer).not.toContain('池子：  ');
    expect(response.answer).not.toContain('合约：  ');
    expect(response.answer).not.toContain('路由合约：  ');
    expect(response.answer).not.toContain('规则版本：  ');
  });

  it('omits blank successful analysis review fields before formatting answers', () => {
    const response = createTxAnalysisAnswer({
      analyzedAt: '2026-06-10T00:00:00.000Z',
      analysisRuleVersion: '   ',
      chain: 'base',
      confidence: 0.76,
      contractAddress: '   ',
      evidence: [],
      poolAddress: '   ',
      relatedTransactions: [],
      routerAddress: '   ',
      summary: '浏览器取证：疑似存在 sandwich 模式。',
      targetTraderAddress: '   ',
      transactionTime: '   ',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verdict: 'sandwiched',
    });

    expect(response.answer).not.toContain('交易地址：');
    expect(response.answer).not.toContain('交易时间：');
    expect(response.answer).not.toContain('池子：');
    expect(response.answer).not.toContain('合约：');
    expect(response.answer).not.toContain('路由合约：');
    expect(response.answer).not.toContain('规则版本：');
  });

  it('exposes a typed provider unavailable error', () => {
    expect(new TxAnalysisProviderUnavailableError('source down')).toBeInstanceOf(Error);
  });

  it('explains unsupported browser chains without implying configured browser chains are unimplemented', () => {
    const response = createTxAnalysisUnavailableAnswer('unsupported_chain');

    expect(response.answer).toContain('Solana');
    expect(response.answer).toContain('已支持');
    expect(response.answer).toContain('Base、Ethereum、BSC');
    expect(response.answer).toContain('其他链');
  });

  it('formats specific browser transaction analysis failure reasons', () => {
    expect(createTxAnalysisUnavailableAnswer('browser_verification_required').answer).toContain(
      '浏览器安全验证',
    );
    expect(createTxAnalysisUnavailableAnswer('tx_not_found').answer).toContain('找不到这笔交易');
    expect(createTxAnalysisUnavailableAnswer('pool_not_found').answer).toContain('池子');
    expect(createTxAnalysisUnavailableAnswer('target_trade_not_found').answer).toContain(
      '目标交易',
    );
    expect(createTxAnalysisUnavailableAnswer('screenshot_unavailable').answer).toContain('截图');
    expect(createTxAnalysisUnavailableAnswer('timeout').answer).toContain('超时');
    expect(createTxAnalysisUnavailableAnswer('tx_failed').answer).toContain('执行失败');
    expect(createTxAnalysisUnavailableAnswer('tx_pending').answer).toContain('未确认');
  });

  it('includes a persisted failure report URL in unavailable answers', () => {
    const response = createTxAnalysisUnavailableAnswer('pool_not_found', {
      metadata: {
        contractAddress: '0xToken000000000000000000000000000000000000',
        explorerUrl:
          'https://basescan.org/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        poolAddress: '0xPool0000000000000000000000000000000000000',
        routerAddress: '0xRouter0000000000000000000000000000000000',
        screenshotUrl: '/assets/tx-analysis-failure-context.png',
        targetTraderAddress: '0xUser0000000000000000000000000000000000000',
        transactionTime: '2026-06-10T01:00:05.000Z',
        xxyyPoolUrl: 'https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
      },
      reportUrl: '/assets/tx-analysis-failure-solana.json',
    });

    expect(response.answer).toContain('池子');
    expect(response.answer).toContain('报告：/assets/tx-analysis-failure-solana.json');
    expect(response.answer).toContain(
      '交易浏览器：https://basescan.org/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    );
    expect(response.answer).toContain('交易地址：0xUser0000000000000000000000000000000000000');
    expect(response.answer).toContain('交易时间：2026-06-10T01:00:05.000Z');
    expect(response.answer).toContain('池子：0xPool0000000000000000000000000000000000000');
    expect(response.answer).toContain('合约：0xToken000000000000000000000000000000000000');
    expect(response.answer).toContain('路由合约：0xRouter0000000000000000000000000000000000');
    expect(response.answer).toContain(
      'XXYY 池子页：https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
    );
    expect(response.answer).toContain('截图：/assets/tx-analysis-failure-context.png');
    expect(response.attachments).toEqual([
      {
        kind: 'image',
        mediaType: 'image/png',
        title: '交易分析失败截图',
        url: '/assets/tx-analysis-failure-context.png',
      },
    ]);
  });

  it('trims unavailable answer report and screenshot URLs before formatting answers', () => {
    const response = createTxAnalysisUnavailableAnswer('screenshot_unavailable', {
      metadata: {
        screenshotUrl: '  /assets/tx-analysis-failure-context.png  ',
      },
      reportUrl: '  /assets/tx-analysis-failure-base.json  ',
    });

    expect(response.answer).toContain('报告：/assets/tx-analysis-failure-base.json');
    expect(response.answer).toContain('截图：/assets/tx-analysis-failure-context.png');
    expect(response.answer).not.toContain('报告：  /assets');
    expect(response.answer).not.toContain('截图：  /assets');
    expect(response.attachments).toEqual([
      {
        kind: 'image',
        mediaType: 'image/png',
        title: '交易分析失败截图',
        url: '/assets/tx-analysis-failure-context.png',
      },
    ]);
  });

  it('omits blank unavailable answer report and screenshot URLs from answers', () => {
    const response = createTxAnalysisUnavailableAnswer('screenshot_unavailable', {
      metadata: {
        screenshotUrl: '   ',
      },
      reportUrl: '   ',
    });

    expect(response.answer).not.toContain('报告：');
    expect(response.answer).not.toContain('截图：');
    expect(response.attachments).toBeUndefined();
  });

  it('trims unavailable answer review links and related transaction links before formatting', () => {
    const response = createTxAnalysisUnavailableAnswer('screenshot_unavailable', {
      metadata: {
        explorerUrl:
          '  https://basescan.org/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef  ',
        relatedTransactions: [
          {
            explorerUrl:
              '  https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ',
            hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            role: 'front_run',
            summary: '疑似前置买入',
          },
          {
            explorerUrl: '   ',
            hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            role: 'user',
            summary: '用户交易',
          },
        ],
        xxyyPoolUrl: '  https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000  ',
      },
    });

    expect(response.answer).toContain(
      '交易浏览器：https://basescan.org/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    );
    expect(response.answer).toContain(
      'XXYY 池子页：https://www.xxyy.io/base/0xpool0000000000000000000000000000000000000',
    );
    expect(response.answer).toContain(
      '前置交易：0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa，疑似前置买入，浏览器：https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(response.answer).toContain(
      '用户交易：0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb，用户交易',
    );
    expect(response.answer).not.toContain('交易浏览器：  https://');
    expect(response.answer).not.toContain('XXYY 池子页：  https://');
    expect(response.answer).not.toContain('浏览器：  https://');
    expect(response.answer).not.toContain('浏览器：   ');
  });

  it('trims unavailable answer related transaction text before formatting', () => {
    const response = createTxAnalysisUnavailableAnswer('screenshot_unavailable', {
      metadata: {
        relatedTransactions: [
          {
            explorerUrl:
              'https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            hash: '  0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ',
            role: 'front_run',
            summary: '  疑似前置买入  ',
            timestamp: '  2026-06-10T01:00:01.000Z  ',
            traderAddress: '  0xAttacker000000000000000000000000000000000  ',
          },
          {
            hash: '   ',
            role: 'user',
            summary: '用户交易',
          },
          {
            hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            role: 'back_run',
            summary: '   ',
          },
        ],
      },
    });

    expect(response.answer).toContain(
      '前置交易：0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa，疑似前置买入，交易者：0xAttacker000000000000000000000000000000000，时间：2026-06-10T01:00:01.000Z，浏览器：https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(response.answer).toContain(
      '后置交易：0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc，后置交易',
    );
    expect(response.answer).not.toContain('前置交易：  0x');
    expect(response.answer).not.toContain('，  疑似前置买入');
    expect(response.answer).not.toContain('交易者：  ');
    expect(response.answer).not.toContain('时间：  ');
    expect(response.answer).not.toContain('用户交易：   ');
  });

  it('omits blank unavailable answer review links before formatting', () => {
    const response = createTxAnalysisUnavailableAnswer('screenshot_unavailable', {
      metadata: {
        explorerUrl: '   ',
        xxyyPoolUrl: '   ',
      },
    });

    expect(response.answer).not.toContain('交易浏览器：');
    expect(response.answer).not.toContain('XXYY 池子页：');
  });

  it('trims unavailable answer review fields before formatting', () => {
    const response = createTxAnalysisUnavailableAnswer('screenshot_unavailable', {
      metadata: {
        contractAddress: '  0xToken000000000000000000000000000000000000  ',
        poolAddress: '  0xPool0000000000000000000000000000000000000  ',
        reportWriteError: '  disk full  ',
        routerAddress: '  0xRouter0000000000000000000000000000000000  ',
        targetTraderAddress: '  0xUser0000000000000000000000000000000000000  ',
        transactionTime: '  2026-06-10T01:00:05.000Z  ',
        unsupportedChainHint: '  Base Sepolia  ',
        unsupportedExplorerHost: '  sepolia.basescan.org  ',
      },
    });

    expect(response.answer).toContain('交易地址：0xUser0000000000000000000000000000000000000');
    expect(response.answer).toContain('交易时间：2026-06-10T01:00:05.000Z');
    expect(response.answer).toContain('池子：0xPool0000000000000000000000000000000000000');
    expect(response.answer).toContain('合约：0xToken000000000000000000000000000000000000');
    expect(response.answer).toContain('路由合约：0xRouter0000000000000000000000000000000000');
    expect(response.answer).toContain('不支持的交易浏览器：sepolia.basescan.org');
    expect(response.answer).toContain('不支持的链或网络：Base Sepolia');
    expect(response.answer).toContain('报告保存失败：disk full');
    expect(response.answer).not.toContain('交易地址：  ');
    expect(response.answer).not.toContain('交易时间：  ');
    expect(response.answer).not.toContain('池子：  ');
    expect(response.answer).not.toContain('合约：  ');
    expect(response.answer).not.toContain('路由合约：  ');
    expect(response.answer).not.toContain('不支持的交易浏览器：  ');
    expect(response.answer).not.toContain('不支持的链或网络：  ');
    expect(response.answer).not.toContain('报告保存失败：  ');
  });

  it('omits blank unavailable answer review fields before formatting', () => {
    const response = createTxAnalysisUnavailableAnswer('screenshot_unavailable', {
      metadata: {
        contractAddress: '   ',
        poolAddress: '   ',
        reportWriteError: '   ',
        routerAddress: '   ',
        targetTraderAddress: '   ',
        transactionTime: '   ',
        unsupportedChainHint: '   ',
        unsupportedExplorerHost: '   ',
      },
    });

    expect(response.answer).not.toContain('交易地址：');
    expect(response.answer).not.toContain('交易时间：');
    expect(response.answer).not.toContain('池子：');
    expect(response.answer).not.toContain('合约：');
    expect(response.answer).not.toContain('路由合约：');
    expect(response.answer).not.toContain('不支持的交易浏览器：');
    expect(response.answer).not.toContain('不支持的链或网络：');
    expect(response.answer).not.toContain('报告保存失败：');
  });

  it('includes related transaction review links in unavailable answers when failure metadata has them', () => {
    const response = createTxAnalysisUnavailableAnswer('screenshot_unavailable', {
      metadata: {
        relatedTransactions: [
          {
            explorerUrl:
              'https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            role: 'front_run',
            summary: '疑似前置买入',
          },
          {
            explorerUrl:
              'https://basescan.org/tx/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            role: 'user',
            summary: '用户买入',
          },
          {
            explorerUrl:
              'https://basescan.org/tx/0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            role: 'back_run',
            summary: '疑似后置卖出',
          },
        ],
      },
    });

    expect(response.answer).toContain(
      '前置交易：0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa，疑似前置买入，浏览器：https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(response.answer).toContain(
      '用户交易：0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb，用户买入，浏览器：https://basescan.org/tx/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(response.answer).toContain(
      '后置交易：0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc，疑似后置卖出，浏览器：https://basescan.org/tx/0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    );
  });

  it('formats unknown EVM probe attempts in unavailable answers', () => {
    const response = createTxAnalysisUnavailableAnswer('browser_verification_required', {
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
    });

    expect(response.answer).toContain(
      '链探测：Base：服务暂时不可用；Ethereum：浏览器安全验证；BSC：找不到交易',
    );
  });

  it('filters blank probe attempts before formatting unavailable answers', () => {
    const response = createTxAnalysisUnavailableAnswer('browser_verification_required', {
      metadata: {
        probeAttempts: [
          {
            chain: 'base',
            message: '  BaseScan HTTP 503 Service Unavailable  ',
            reason: 'provider_unavailable',
          },
          {
            chain: 'ethereum',
            message: '   ',
            reason: 'browser_verification_required',
          },
          {
            chain: 'bsc',
            message: 'not found on BSC',
            reason: 'tx_not_found',
          },
        ],
      },
    });

    expect(response.answer).toContain('链探测：Base：服务暂时不可用；BSC：找不到交易');
    expect(response.answer).not.toContain('Ethereum：浏览器安全验证');
  });
});
