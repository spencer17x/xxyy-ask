import { describe, expect, it } from 'vitest';

import { createLocalHashEmbedding } from '@xxyy/knowledge';
import type { RagIndex } from '@xxyy/shared';

import { retrieve } from './retrieve.js';
import { createFixtureIndex } from './test-fixtures.js';

describe('retrieve', () => {
  it('combines lexical and local vector scores into ranked chunks', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/pro',
        text: 'XXYY Pro 支持 Telegram 钱包监控、更多提醒频率和产品功能。',
      },
      {
        id: 'official_docs:fees:chunk:0001',
        title: '费用说明',
        sourceType: 'official_docs',
        text: '普通版本说明费用和基础账户设置。',
      },
      {
        id: 'x_updates:launch:chunk:0001',
        title: 'X 更新',
        sourceType: 'x_updates',
        text: '我们发布了社区活动和运营消息。',
      },
    ]);

    const results = retrieve('XXYY Pro 支持 Telegram 钱包监控吗？', index, { topK: 2 });

    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('official_docs:pro:chunk:0001');
    expect(results[0]?.rank).toBe(1);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[0]?.lexicalScore).toBeGreaterThan(0);
    expect(results[0]?.sourceBoost).toBeGreaterThan(0);
    expect(results[0]?.vectorScore).toBeGreaterThan(0);
  });

  it('prefers official docs over x updates when scores tie', () => {
    const index = createFixtureIndex([
      {
        id: 'x_updates:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'x_updates',
        text: 'XXYY Pro 支持 Telegram 钱包监控。',
      },
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        text: 'XXYY Pro 支持 Telegram 钱包监控。',
      },
    ]);

    const results = retrieve('Pro Telegram 钱包监控', index);

    expect(results[0]?.id).toBe('official_docs:pro:chunk:0001');
    expect(results[1]?.id).toBe('x_updates:pro:chunk:0001');
  });

  it('returns an empty list for blank questions or empty indexes', () => {
    expect(retrieve('   ', createFixtureIndex([]))).toEqual([]);
    expect(retrieve('Pro', createFixtureIndex([]))).toEqual([]);
  });

  it('does not return vector-only hash matches without lexical evidence', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:wallet:chunk:0001',
        title: '钱包监控',
        sourceType: 'official_docs',
        text: '钱包监控支持 Telegram 提醒。',
      },
    ]);

    const results = retrieve('completely unrelated english phrase', index);

    expect(results).toEqual([]);
  });

  it('keeps strong vector matches even when lexical score is zero', () => {
    const question = 'XXYY copy trading supported chains';
    const index: RagIndex = {
      builtAt: '2026-06-01T00:00:00.000Z',
      entries: [
        {
          documentId: 'copy-trading',
          embedding: createLocalHashEmbedding(question),
          id: 'x_updates:copy-trading:chunk:0001',
          metadata: {
            file: 'docs/product-features/xxyy-x-updates.md',
            headingPath: ['Copy Trading'],
            module: 'X Updates',
            sourceType: 'x_updates',
            title: 'Copy Trading Update',
          },
          text: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
          tokens: ['跟单', '功能', '上线'],
        },
      ],
      version: 1,
    };

    const results = retrieve(question, index, { topK: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'x_updates:copy-trading:chunk:0001',
      lexicalScore: 0,
      rank: 1,
      vectorScore: 1,
    });
  });

  it('expands product synonyms for paraphrased membership limit questions', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro-limits:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        text: 'XXYY Pro 可监控 2000 个钱包，并支持提醒频率。',
      },
      {
        id: 'official_docs:fees:chunk:0001',
        title: '费用说明',
        sourceType: 'official_docs',
        text: '普通版本说明服务费用和账户设置。',
      },
    ]);

    const results = retrieve('付费套餐能追踪多少地址？', index, { topK: 1 });

    expect(results[0]?.id).toBe('official_docs:pro-limits:chunk:0001');
    expect(results[0]?.lexicalScore).toBeGreaterThan(0);
  });

  it('keeps both sides of Basic and Pro comparison questions in top results', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:basic:chunk:0001',
        title: 'XXYY Basic 权益',
        sourceType: 'official_docs',
        text: 'XXYY Basic 提供基础钱包监控和默认提醒频率。',
      },
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        text: 'XXYY Pro 支持更多钱包监控数量和更高提醒频率。',
      },
      {
        id: 'official_docs:telegram:chunk:0001',
        title: 'Telegram 通知',
        sourceType: 'official_docs',
        text: 'Telegram 通知用于接收产品提醒。',
      },
    ]);

    const resultIds = retrieve('Basic 和 Pro 权益有什么区别？', index, { topK: 2 }).map(
      (chunk) => chunk.id,
    );

    expect(resultIds).toEqual(['official_docs:basic:chunk:0001', 'official_docs:pro:chunk:0001']);
  });

  it('prefers trading operation pages for buy-token how-to questions', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro-upgrade:chunk:0001',
        title: '如何升级为 Pro',
        module: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        text: '交易积分是根据当前地址下所有交易地址的买入卖出笔数、买入卖出金额综合计算。',
      },
      {
        id: 'official_docs:swap:chunk:0001',
        title: 'Swap 交易',
        module: '交易代币',
        sourceType: 'official_docs',
        text: 'XXYY 支持一键买卖代币。交易金额可以自定义买入的 SOL 数量或者卖出代币的比例。',
      },
    ]);

    const results = retrieve('如何在 XXYY 买入代币？', index);

    expect(results[0]?.id).toBe('official_docs:swap:chunk:0001');
  });

  it('prioritizes exact feature mentions from X updates for short Chinese feature questions', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:orders:chunk:0001',
        title: '挂单交易',
        sourceType: 'official_docs',
        text: 'XXYY 提供挂单买卖功能，一键设置，按理想价格买入或卖出代币。',
      },
      {
        id: 'x_updates:copy-trading:chunk:0001',
        title: 'XXYY X 历史推文产品更新汇总',
        sourceType: 'x_updates',
        text: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
      },
    ]);

    const results = retrieve('XXYY支持跟单么', index);

    expect(results[0]?.id).toBe('x_updates:copy-trading:chunk:0001');
  });
});
