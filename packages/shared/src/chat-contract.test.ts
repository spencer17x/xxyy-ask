import { describe, expect, it } from 'vitest';

import {
  supportedChannels,
  supportedIntents,
  type ChatRequest,
  type ChatResponse,
} from './index.js';

describe('chat contract', () => {
  it('defines the supported entry channels', () => {
    expect(supportedChannels).toEqual(['cli', 'web', 'telegram']);
  });

  it('defines stable product support intents', () => {
    expect(supportedIntents).toContain('product_qa');
    expect(supportedIntents).toContain('mev_or_chain_forensics');
  });

  it('allows channel-neutral chat responses with citations', () => {
    const request: ChatRequest = {
      channel: 'web',
      message: 'XXYY Pro 有什么权益？',
      sessionId: 'session-1',
    };

    const response: ChatResponse = {
      answer: '根据知识库，XXYY Pro 提供更多产品权益。',
      citations: [
        {
          excerpt: 'Pro 权益',
          file: 'docs/product-features/pages/61-getting-started__xxyy-pro-quan-yi__pro.md',
          title: 'Pro',
        },
      ],
      confidence: 0.8,
      intent: 'product_qa',
    };

    expect(request.channel).toBe('web');
    expect(response.citations[0]?.title).toBe('Pro');
  });
});
