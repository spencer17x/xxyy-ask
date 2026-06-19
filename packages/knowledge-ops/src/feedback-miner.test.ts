import { describe, expect, it } from 'vitest';

import { mineAnswerFeedback } from './feedback-miner.js';

const now = '2026-06-19T09:00:00.000Z';

describe('mineAnswerFeedback', () => {
  it('creates a needs-review eval candidate from negative answer feedback', () => {
    const result = mineAnswerFeedback({
      feedback: [
        {
          answer: '根据知识库，XXYY Pro 提供更多权益。',
          channel: 'web',
          citationCount: 2,
          comment: '没有讲清楚监控数量上限，我的邮箱是 me@example.com',
          intent: 'product_qa',
          question: 'XXYY Pro 有哪些权益？',
          rating: 'negative',
          sessionIdPresent: true,
        },
      ],
      now,
    });

    expect(result).toMatchObject({
      candidatesCreated: 1,
      feedbackRead: 1,
      feedbackSkipped: 0,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      confidence: 0.55,
      createdAt: now,
      proposedAnswer: '根据知识库，XXYY Pro 提供更多权益。',
      question: 'XXYY Pro 有哪些权益？',
      riskLevel: 'medium',
      status: 'needs_review',
      targetCategory: 'eval_case',
      type: 'eval_case',
      updatedAt: now,
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer: '根据知识库，XXYY Pro 提供更多权益。',
        question: 'XXYY Pro 有哪些权益？',
      },
    ]);
    const sourceRef = result.candidates[0]?.sourceRefs[0];
    expect(sourceRef).toBeDefined();
    if (sourceRef === undefined) {
      throw new Error('Expected feedback candidate source ref.');
    }
    expect(sourceRef.messageId).toMatch(/^fb_[a-f0-9]{16}$/u);
    expect(result.candidates[0]?.sourceRefs).toEqual([
      {
        chatIdHash: 'session_present',
        messageId: sourceRef.messageId,
        source: 'answer_feedback',
      },
    ]);
  });

  it('creates a high-risk boundary candidate from negative feedback on private data answers', () => {
    const result = mineAnswerFeedback({
      feedback: [
        {
          answer: '不能查询你的钱包余额。',
          channel: 'web',
          citationCount: 0,
          intent: 'realtime_account_query',
          question: '帮我查一下钱包余额 0x1111111111111111111111111111111111111111',
          rating: 'negative',
          sessionIdPresent: false,
        },
      ],
      now,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      question: '帮我查一下钱包余额 [REDACTED_EVM_ADDRESS]',
      riskLevel: 'high',
      targetCategory: 'policy_boundary',
      type: 'boundary_example',
    });
    expect(result.candidates[0]?.redactionReport.riskFlags).toEqual(
      expect.arrayContaining(['private_account_query']),
    );
  });

  it('skips positive feedback and empty negative feedback', () => {
    const result = mineAnswerFeedback({
      feedback: [
        {
          answer: 'XXYY Pro 提供更多权益。',
          channel: 'web',
          citationCount: 1,
          intent: 'product_qa',
          question: 'XXYY Pro 有哪些权益？',
          rating: 'positive',
          sessionIdPresent: true,
        },
        {
          answer: '   ',
          channel: 'web',
          citationCount: 0,
          intent: 'unknown',
          question: '   ',
          rating: 'negative',
          sessionIdPresent: false,
        },
      ],
      now,
    });

    expect(result).toEqual({
      candidates: [],
      candidatesCreated: 0,
      feedbackRead: 2,
      feedbackSkipped: 2,
    });
  });
});
