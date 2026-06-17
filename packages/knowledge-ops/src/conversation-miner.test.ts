import { describe, expect, it } from 'vitest';

import { mineSupportConversations } from './conversation-miner.js';
import type { RawSupportMessage } from './types.js';

const now = '2026-06-17T02:00:00.000Z';

function message(input: {
  contentHash?: string;
  messageId: string;
  replyToMessageId?: string;
  senderRole: RawSupportMessage['senderRole'];
  sentAt?: string;
  text: string;
}): RawSupportMessage {
  return {
    source: 'telegram',
    chatIdHash: 'support_chat_hash',
    contentHash: input.contentHash ?? `content_${input.messageId}`,
    ingestedAt: now,
    messageId: input.messageId,
    ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
    senderRole: input.senderRole,
    sentAt: input.sentAt ?? now,
    text: input.text,
  };
}

describe('mineSupportConversations', () => {
  it('creates a needs-review FAQ candidate from a user question and support reply', () => {
    const result = mineSupportConversations({
      messages: [
        message({
          messageId: '10',
          senderRole: 'user',
          text: 'Telegram 通知怎么设置？',
        }),
        message({
          messageId: '11',
          replyToMessageId: '10',
          senderRole: 'support',
          text: '在钱包监控里创建通知 Bot，填写群 ID 后保存即可。',
        }),
      ],
      now,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      confidence: 0.8,
      createdAt: now,
      proposedAnswer: '在钱包监控里创建通知 Bot，填写群 ID 后保存即可。',
      question: 'Telegram 通知怎么设置？',
      riskLevel: 'low',
      status: 'needs_review',
      targetCategory: 'product_faq',
      type: 'faq',
      updatedAt: now,
    });
    expect(result.candidates[0]?.sourceRefs).toEqual([
      { source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '10' },
      { source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '11' },
    ]);
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer: '在钱包监控里创建通知 Bot，填写群 ID 后保存即可。',
        question: 'Telegram 通知怎么设置？',
      },
    ]);
  });

  it('creates a high-risk boundary candidate for private account requests', () => {
    const result = mineSupportConversations({
      messages: [
        message({
          messageId: '20',
          senderRole: 'user',
          text: '帮我查一下钱包余额 0x1111111111111111111111111111111111111111',
        }),
        message({
          messageId: '21',
          replyToMessageId: '20',
          senderRole: 'support',
          text: '客服 Agent 不能查询你的账户余额，请在钱包或交易所内自行核对。',
        }),
      ],
      now,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      question: '帮我查一下钱包余额 [REDACTED_EVM_ADDRESS]',
      riskLevel: 'high',
      status: 'needs_review',
      targetCategory: 'policy_boundary',
      type: 'boundary_example',
    });
    expect(result.candidates[0]?.redactionReport.riskFlags).toEqual(
      expect.arrayContaining(['private_account_query']),
    );
  });

  it('does not create candidates from unpaired support messages or empty replies', () => {
    const result = mineSupportConversations({
      messages: [
        message({
          messageId: '30',
          senderRole: 'support',
          text: '请看置顶教程。',
        }),
        message({
          messageId: '31',
          senderRole: 'user',
          text: '扫链筛选怎么保存？',
        }),
        message({
          messageId: '32',
          replyToMessageId: '31',
          senderRole: 'support',
          text: '   ',
        }),
      ],
      now,
    });

    expect(result.candidates).toEqual([]);
  });
});
