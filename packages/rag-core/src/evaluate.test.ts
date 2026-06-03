import { describe, expect, it } from 'vitest';

import { createChatService } from './chat-service.js';
import { evaluateCases } from './evaluate.js';
import { createFixtureIndex } from './test-fixtures.js';

describe('evaluateCases', () => {
  it('checks expected intent and minimum citation counts', async () => {
    const service = createChatService({
      index: createFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro 权益',
          sourceType: 'official_docs',
          file: '/docs/pro.md',
          text: 'XXYY Pro 支持 Telegram 钱包监控。',
        },
      ]),
    });

    const report = await evaluateCases(
      [
        {
          name: 'pro citations',
          request: { channel: 'web', message: 'XXYY Pro 支持什么？' },
          expectedIntent: 'product_qa',
          minCitations: 1,
        },
        {
          name: 'intent mismatch',
          request: { channel: 'web', message: '帮我查钱包余额' },
          expectedIntent: 'product_qa',
          minCitations: 1,
        },
      ],
      service,
    );

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.results[0]).toMatchObject({
      name: 'pro citations',
      passed: true,
      actualIntent: 'product_qa',
      citationCount: 1,
    });
    expect(report.results[1]).toMatchObject({
      name: 'intent mismatch',
      passed: false,
      actualIntent: 'realtime_account_query',
      citationCount: 0,
    });
  });
});
