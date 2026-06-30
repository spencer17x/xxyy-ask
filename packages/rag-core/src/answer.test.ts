import { describe, expect, it } from 'vitest';

import type { Classification } from '@xxyy/shared';

import { createBoundaryAnswer, createGroundedAnswer } from './answer.js';
import { retrieve } from './retrieve.js';
import { createFixtureIndex } from './test-fixtures.js';

const productClassification: Classification = {
  intent: 'product_qa',
  confidence: 0.8,
  reason: 'product keyword',
};

describe('createGroundedAnswer', () => {
  it('answers product questions in Chinese using retrieved excerpts and citations', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/pro',
        file: '/docs/pro.md',
        text: 'XXYY Pro 支持 Telegram 钱包监控，并提供更高频率的产品提醒。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 支持 Telegram 钱包监控吗？', index);

    const response = createGroundedAnswer(
      'XXYY Pro 支持 Telegram 钱包监控吗？',
      productClassification,
      retrieved,
    );

    expect(response.intent).toBe('product_qa');
    expect(response.answer).toContain('根据知识库');
    expect(response.answer).toContain('Telegram 钱包监控');
    expect(response.citations).toHaveLength(1);
    const citation = response.citations[0];
    expect(citation).toBeDefined();
    if (citation === undefined) {
      throw new Error('Expected a product answer citation');
    }
    expect(citation.excerpt).toContain('Telegram 钱包监控');
    expect(citation.file).toBe('docs/pro.md');
    expect(citation.title).toBe('XXYY Pro 权益');
    expect(citation.sourceUrl).toBe('https://docs.xxyy.io/pro');
    expect(response.confidence).toBeGreaterThan(0.5);
  });

  it('uses a conservative fallback when product context is unavailable', () => {
    const response = createGroundedAnswer('XXYY Pro 有哪些权益？', productClassification, []);

    expect(response.answer).toContain('暂时没有找到');
    expect(response.citations).toEqual([]);
    expect(response.confidence).toBeLessThan(0.5);
  });

  it('extracts video attachments from grounded product context', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:mobile-app:chunk:0001',
        title: '移动端桌面入口',
        sourceType: 'official_docs',
        file: '/docs/product-features/pages/mobile-app.md',
        text: 'XXYY 暂时没有独立 App，但可以添加到桌面，和 App 体验差不多。[添加到桌面演示](/assets/xxyy-add-to-home.mp4)',
      },
    ]);
    const retrieved = retrieve('XXYY 有 APP 吗？', index);

    const response = createGroundedAnswer('XXYY 有 APP 吗？', productClassification, retrieved);

    expect(response.answer).toContain('添加到桌面');
    expect(response.attachments).toEqual([
      {
        kind: 'video',
        mediaType: 'video/mp4',
        title: '添加到桌面演示',
        url: '/assets/xxyy-add-to-home.mp4',
      },
    ]);
  });

  it.each([
    ['realtime_account_query', '我不能直接查询你的钱包余额、订单、账户或交易记录'],
    ['investment_advice', '我不能提供买卖建议、喊单或收益承诺'],
    ['unknown', '我还不确定你想咨询的具体问题'],
  ] as const)(
    'does not use retrieved chunks as factual answers for %s',
    (intent, expectedBoundary) => {
      const index = createFixtureIndex([
        {
          id: 'official_docs:unsafe:chunk:0001',
          title: '不应被引用',
          sourceType: 'official_docs',
          text: '你的余额是 100 SOL，这笔交易确定被夹，建议马上买入。',
        },
      ]);
      const retrieved = retrieve('帮我查余额', index);
      const response = createGroundedAnswer(
        '帮我查余额',
        {
          intent,
          confidence: 0.9,
          reason: 'boundary intent',
        },
        retrieved,
      );

      expect(response.answer).toContain(expectedBoundary);
      expect(response.answer).not.toContain('100 SOL');
      expect(response.answer).not.toContain('马上买入');
      expect(response.citations).toEqual([]);
    },
  );
});

describe('createBoundaryAnswer', () => {
  it('returns a business-action boundary when the unknown reason is action execution', () => {
    const response = createBoundaryAnswer({
      confidence: 0.4,
      intent: 'unknown',
      reason: 'business action execution request',
    });

    expect(response).toMatchObject({
      citations: [],
      confidence: 0.4,
      intent: 'unknown',
    });
    expect(response.answer).toContain('不能代你开通、取消、修改');
    expect(response.answer).toContain('退款、赔偿');
    expect(response.answer).toContain('可以继续问我开通或升级的操作步骤');
    expect(response.answer).not.toMatch(/人工接管|工单|转人工|人工客服/u);
  });
});
