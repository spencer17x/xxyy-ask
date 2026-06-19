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
    expect(supportedIntents).toContain('tx_sandwich_detection');
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
      attachments: [
        {
          kind: 'video',
          mediaType: 'video/mp4',
          title: '添加到桌面演示',
          url: '/assets/xxyy-add-to-home.mp4',
        },
      ],
      citations: [
        {
          excerpt: 'Pro 权益',
          file: 'docs/product-features/pages/61-getting-started__xxyy-pro-quan-yi__pro.md',
          title: 'Pro',
        },
      ],
      confidence: 0.8,
      intent: 'product_qa',
      tokenUsage: {
        completionTokens: 36,
        promptTokens: 120,
        totalTokens: 156,
      },
    };

    expect(request.channel).toBe('web');
    expect(response.citations[0]?.title).toBe('Pro');
    expect(response.attachments?.[0]?.kind).toBe('video');
    expect(response.tokenUsage?.totalTokens).toBe(156);
  });

  it('allows image attachments for transaction analysis screenshots', () => {
    const response: ChatResponse = {
      answer: '交易哈希分析截图如下。',
      attachments: [
        {
          kind: 'image',
          mediaType: 'image/svg+xml',
          title: '交易分析截图',
          url: '/assets/tx-analysis-fixture.svg',
        },
      ],
      citations: [],
      confidence: 0.8,
      intent: 'tx_sandwich_detection',
    };

    expect(response.attachments?.[0]?.kind).toBe('image');
  });
});
