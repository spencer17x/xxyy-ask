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
      proposedAnswer:
        '用户负反馈：没有讲清楚监控数量上限，我的邮箱是 [REDACTED_EMAIL]\n原回答：根据知识库，XXYY Pro 提供更多权益。',
      question: 'XXYY Pro 有哪些权益？',
      riskLevel: 'medium',
      status: 'needs_review',
      targetCategory: 'eval_case',
      type: 'eval_case',
      updatedAt: now,
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer: '用户负反馈：没有讲清楚监控数量上限，我的邮箱是 [REDACTED_EMAIL]',
        expectedIntent: 'product_qa',
        minCitations: 1,
        question: 'XXYY Pro 有哪些权益？',
        requireExpectedAnswerText: false,
      },
    ]);
    expect(result.candidates[0]?.proposedAnswer).not.toBe('根据知识库，XXYY Pro 提供更多权益。');
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

  it('derives feedback candidate ids from redacted text instead of raw secrets', () => {
    const first = mineAnswerFeedback({
      feedback: [
        {
          answer: '不要发送私钥、助记词或 seed phrase。api key: sk-answer-111',
          channel: 'web',
          citationCount: 0,
          comment: '我的密码是 hunter2',
          intent: 'unknown',
          question: '我的密码是 hunter2 api key: sk-test-111',
          rating: 'negative',
          sessionIdPresent: true,
        },
      ],
      now,
    }).candidates[0];
    const second = mineAnswerFeedback({
      feedback: [
        {
          answer: '不要发送私钥、助记词或 seed phrase。api key: sk-answer-222',
          channel: 'web',
          citationCount: 0,
          comment: '我的密码是 different-secret',
          intent: 'unknown',
          question: '我的密码是 different-secret api key: sk-test-222',
          rating: 'negative',
          sessionIdPresent: true,
        },
      ],
      now,
    }).candidates[0];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      throw new Error('Expected both feedback candidates to be created.');
    }
    expect(first.question).toBe(second.question);
    expect(first.proposedAnswer).toBe(second.proposedAnswer);
    expect(first.id).toBe(second.id);
    expect(first.sourceRefs[0]?.messageId).toBe(second.sourceRefs[0]?.messageId);
    expect(JSON.stringify(first)).not.toContain('hunter2');
    expect(JSON.stringify(first)).not.toContain('sk-test-111');
    expect(JSON.stringify(first)).not.toContain('sk-answer-111');
  });

  it('keeps already-redacted credential feedback in the high-risk boundary queue', () => {
    const result = mineAnswerFeedback({
      feedback: [
        {
          answer:
            '不要发送私钥、助记词或 seed phrase。XXYY 客服 Agent 不需要这些信息，也不能帮你保管或恢复凭证。',
          channel: 'web',
          citationCount: 0,
          intent: 'unknown',
          question: '我的助记词是 [sensitive_credential]',
          rating: 'negative',
          sessionIdPresent: true,
        },
      ],
      now,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      question: '我的助记词是 [REDACTED_PRIVATE_CREDENTIAL]',
      riskLevel: 'high',
      targetCategory: 'policy_boundary',
      type: 'boundary_example',
    });
    expect(result.candidates[0]?.redactionReport.riskFlags).toEqual(
      expect.arrayContaining(['private_credentials']),
    );
  });

  it('does not require citations or copied answer text for transaction feedback eval cases', () => {
    const result = mineAnswerFeedback({
      feedback: [
        {
          answer: '这笔交易暂时无法完成夹子检测。',
          channel: 'web',
          citationCount: 0,
          intent: 'tx_sandwich_detection',
          question:
            '这笔 0x1111111111111111111111111111111111111111111111111111111111111111 被夹了吗？',
          rating: 'negative',
          sessionIdPresent: true,
        },
      ],
      now,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      proposedAnswer:
        '用户负反馈：用户标记该回答未解决问题。\n原回答：这笔交易暂时无法完成夹子检测。',
      question:
        '这笔 0x1111111111111111111111111111111111111111111111111111111111111111 被夹了吗？',
      targetCategory: 'eval_case',
      type: 'eval_case',
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer: '用户负反馈：用户标记该回答未解决问题。',
        expectedIntent: 'tx_sandwich_detection',
        minCitations: 0,
        question:
          '这笔 0x1111111111111111111111111111111111111111111111111111111111111111 被夹了吗？',
        requireExpectedAnswerText: false,
      },
    ]);
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
