import { describe, expect, it } from 'vitest';

import { planAnswer } from './answer-planner.js';

describe('planAnswer', () => {
  it('routes product questions to product_answer', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.78,
          intent: 'product_qa',
          reason: 'asks about product',
        },
        resolvedMessage: 'XXYY Pro 有哪些权益？',
      }),
    ).toEqual({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'asks about product',
      },
      messageForTool: 'XXYY Pro 有哪些权益？',
      route: 'product_answer',
    });
  });

  it('routes transaction questions to transaction_analysis', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.9,
          intent: 'tx_sandwich_detection',
          reason: 'hash',
        },
        resolvedMessage: '0x1111111111111111111111111111111111111111111111111111111111111111',
      }),
    ).toMatchObject({
      messageForTool: '0x1111111111111111111111111111111111111111111111111111111111111111',
      route: 'transaction_analysis',
    });
  });

  it('routes unknown intent to clarification', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.25,
          intent: 'unknown',
          reason: 'no deterministic product support intent matched',
        },
        resolvedMessage: '帮我看看这个',
      }),
    ).toEqual({
      clarificationQuestion:
        '我还不确定你想咨询 XXYY 的哪个功能。请补充具体功能、配置步骤、Pro 权益，或发送单笔交易哈希。',
      classification: {
        confidence: 0.25,
        intent: 'unknown',
        reason: 'no deterministic product support intent matched',
      },
      route: 'clarify',
    });
  });

  it('routes private account queries to boundary', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.86,
          intent: 'realtime_account_query',
          reason: 'private data',
        },
        resolvedMessage: '帮我查钱包余额',
      }),
    ).toMatchObject({
      route: 'boundary',
    });
  });
});
