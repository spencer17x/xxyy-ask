import { describe, expect, it } from 'vitest';

import { createInMemoryQualityTracer, loadRagConfig } from '@xxyy/rag-core';

import { createTelegramChatRuntime } from './runtime.js';

describe('createTelegramChatRuntime', () => {
  it('injects the supplied tracer into the customer runtime', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const runtime = createTelegramChatRuntime(loadRagConfig({}), tracer);
    try {
      const response = await runtime.service.ask({
        channel: 'telegram',
        message: '帮我查一下钱包余额',
        requestId: 'telegram:1:1',
      });

      expect(response.agentRoute).toBe('boundary');
      expect(records.map((record) => record.name)).toEqual([
        'chat.request',
        'agent.classify',
        'agent.guard',
      ]);
    } finally {
      await runtime.close();
    }
  });
});
