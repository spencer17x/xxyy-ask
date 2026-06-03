import { describe, expect, it } from 'vitest';

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
});
