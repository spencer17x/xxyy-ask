import { describe, expect, it } from 'vitest';

import { createChatService } from './chat-service.js';
import { createFixtureIndex } from './test-fixtures.js';

describe('createChatService', () => {
  it('classifies, retrieves, and answers grounded product questions', async () => {
    const service = createChatService({
      config: { topK: 1 },
      index: createFixtureIndex([
        {
          id: 'official_docs:telegram:chunk:0001',
          title: 'Telegram 钱包监控',
          sourceType: 'official_docs',
          file: '/docs/telegram.md',
          text: 'XXYY 支持通过 Telegram 设置钱包监控提醒。',
        },
      ]),
    });

    const response = await service.ask({
      channel: 'web',
      message: '如何设置 Telegram 钱包监控？',
      sessionId: 'session-1',
    });

    expect(response.intent).toBe('how_to');
    expect(response.answer).toContain('Telegram');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.file).toBe('docs/telegram.md');
  });

  it('does not retrieve factual answers for realtime account lookup requests', async () => {
    const service = createChatService({
      index: createFixtureIndex([
        {
          id: 'official_docs:wallet:chunk:0001',
          title: '钱包余额',
          sourceType: 'official_docs',
          text: '你的钱包余额是 100 SOL。',
        },
      ]),
    });

    const response = await service.ask({
      channel: 'cli',
      message: '帮我查一下钱包余额',
    });

    expect(response.intent).toBe('realtime_account_query');
    expect(response.answer).not.toContain('100 SOL');
    expect(response.citations).toEqual([]);
  });

  it('keeps investment boundary when a profit promise is mixed into a product operation question', async () => {
    const service = createChatService({
      index: createFixtureIndex([
        {
          id: 'official_docs:swap:chunk:0001',
          title: 'Swap 交易',
          sourceType: 'official_docs',
          text: 'XXYY 支持一键买卖代币。',
        },
      ]),
    });

    const response = await service.ask({
      channel: 'cli',
      message: '如何在 XXYY 买入能保证盈利的 token？',
    });

    expect(response.intent).toBe('investment_advice');
    expect(response.answer).not.toContain('一键买卖代币');
    expect(response.citations).toEqual([]);
  });
});
