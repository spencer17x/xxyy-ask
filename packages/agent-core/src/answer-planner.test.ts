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

  it('routes ambiguous multi-transaction questions to clarification', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.86,
          intent: 'tx_sandwich_detection',
          reason:
            'asks to analyze multiple transaction hashes and needs a single hash clarification',
        },
        resolvedMessage:
          '帮我查这两笔哪个被夹了 0x1111111111111111111111111111111111111111111111111111111111111111 0x2222222222222222222222222222222222222222222222222222222222222222',
      }),
    ).toEqual({
      clarificationQuestion:
        '一次只能分析一笔交易。请发送单笔完整交易哈希或对应主网浏览器链接，我会自动继续分析。',
      clarificationReason: 'ambiguous_transaction_reference',
      classification: {
        confidence: 0.86,
        intent: 'tx_sandwich_detection',
        reason: 'asks to analyze multiple transaction hashes and needs a single hash clarification',
      },
      route: 'clarify',
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
      clarificationReason: 'unknown_intent',
      classification: {
        confidence: 0.25,
        intent: 'unknown',
        reason: 'no deterministic product support intent matched',
      },
      route: 'clarify',
    });
  });

  it('routes unsafe unknown requests to boundary', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.3,
          intent: 'unknown',
          reason: 'unsafe or unsupported operation request',
        },
        resolvedMessage: 'How to hack XXYY account?',
      }),
    ).toMatchObject({
      route: 'boundary',
    });
  });

  it('routes private credential disclosures to boundary', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.35,
          intent: 'unknown',
          reason: 'private credential or seed phrase disclosure',
        },
        resolvedMessage:
          '我的助记词是 abandon ability able about above absent absorb abstract absurd abuse access accident',
      }),
    ).toMatchObject({
      route: 'boundary',
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
