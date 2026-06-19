import { describe, expect, it } from 'vitest';

import { resolveFollowUp } from './follow-up-resolver.js';
import type { SessionTurn } from './session-context.js';

const evmTx = '0x1111111111111111111111111111111111111111111111111111111111111111';
const secondEvmTx = '0x2222222222222222222222222222222222222222222222222222222222222222';

describe('resolveFollowUp', () => {
  it('keeps self-contained product questions unchanged', () => {
    expect(
      resolveFollowUp({
        message: 'XXYY Pro 有哪些权益？',
        recentTurns: [],
      }),
    ).toEqual({
      resolution: 'unchanged',
      resolvedMessage: 'XXYY Pro 有哪些权益？',
    });
  });

  it('resolves short product follow-ups using the most recent product topic', () => {
    const recentTurns: SessionTurn[] = [
      {
        content: 'XXYY Pro 有哪些权益？',
        createdAt: '2026-06-19T00:00:00.000Z',
        metadata: { intent: 'product_qa' },
        role: 'user',
      },
    ];

    expect(
      resolveFollowUp({
        message: '怎么升级？',
        recentTurns,
      }),
    ).toEqual({
      contextSummary: 'resolved product follow-up from previous product turn',
      resolution: 'resolved_followup',
      resolvedMessage: 'XXYY Pro 怎么升级？',
    });
  });

  it('keeps explicit product questions unchanged even when previous product context exists', () => {
    const recentTurns: SessionTurn[] = [
      {
        content: 'XXYY Pro 有哪些权益？',
        createdAt: '2026-06-19T00:00:00.000Z',
        metadata: { intent: 'product_qa' },
        role: 'user',
      },
    ];

    expect(
      resolveFollowUp({
        message: '如何设置 Telegram 钱包监控？',
        recentTurns,
      }),
    ).toEqual({
      resolution: 'unchanged',
      resolvedMessage: '如何设置 Telegram 钱包监控？',
    });
  });

  it('asks for clarification when a product follow-up has no usable product context', () => {
    expect(
      resolveFollowUp({
        message: '怎么升级？',
        recentTurns: [],
      }),
    ).toEqual({
      clarificationQuestion:
        '我还不能确定你想继续咨询哪个具体功能。请补充具体功能、权益或配置步骤，例如“XXYY Pro 怎么升级？”。',
      clarificationReason: 'missing_context',
      dependency: 'product_topic',
      resolution: 'needs_clarification',
    });
  });

  it('resolves transaction follow-ups when exactly one recent transaction exists', () => {
    const recentTurns: SessionTurn[] = [
      {
        content: '[evm_tx_hash]',
        createdAt: '2026-06-19T00:00:00.000Z',
        metadata: { chain: 'base', intent: 'tx_sandwich_detection', txHash: evmTx },
        role: 'assistant',
      },
    ];

    expect(
      resolveFollowUp({
        message: '这笔被夹了吗？',
        recentTurns,
      }),
    ).toEqual({
      contextSummary: 'resolved transaction follow-up from one recent transaction',
      resolution: 'resolved_followup',
      resolvedMessage: `base ${evmTx} 这笔被夹了吗？`,
    });
  });

  it('asks for clarification when a transaction follow-up has no usable transaction context', () => {
    expect(
      resolveFollowUp({
        message: '这笔呢？',
        recentTurns: [],
      }),
    ).toEqual({
      clarificationQuestion:
        '我还不能确定“这笔”指哪一笔交易。请发送单笔完整交易哈希或对应主网浏览器链接。',
      clarificationReason: 'missing_context',
      dependency: 'transaction_reference',
      resolution: 'needs_clarification',
    });
  });

  it('asks for clarification when the same transaction hash exists on multiple recent chains', () => {
    const recentTurns: SessionTurn[] = [
      {
        content: '[evm_tx_hash]',
        createdAt: '2026-06-19T00:00:00.000Z',
        metadata: { chain: 'base', intent: 'tx_sandwich_detection', txHash: evmTx },
        role: 'assistant',
      },
      {
        content: '[evm_tx_hash]',
        createdAt: '2026-06-19T00:01:00.000Z',
        metadata: { chain: 'ethereum', intent: 'tx_sandwich_detection', txHash: evmTx },
        role: 'assistant',
      },
    ];

    expect(
      resolveFollowUp({
        message: '这笔呢？',
        recentTurns,
      }),
    ).toEqual({
      clarificationQuestion: '你想分析哪一笔交易？请发送单笔完整交易哈希或对应主网浏览器链接。',
      clarificationReason: 'ambiguous_reference',
      dependency: 'transaction_reference',
      resolution: 'needs_clarification',
    });
  });

  it('asks for clarification when a transaction follow-up has multiple possible references', () => {
    const recentTurns: SessionTurn[] = [
      {
        content: '[evm_tx_hash]',
        createdAt: '2026-06-19T00:00:00.000Z',
        metadata: { chain: 'base', intent: 'tx_sandwich_detection', txHash: evmTx },
        role: 'assistant',
      },
      {
        content: '[evm_tx_hash]',
        createdAt: '2026-06-19T00:01:00.000Z',
        metadata: {
          chain: 'ethereum',
          intent: 'tx_sandwich_detection',
          txHash: secondEvmTx,
        },
        role: 'assistant',
      },
    ];

    expect(
      resolveFollowUp({
        message: '这笔呢？',
        recentTurns,
      }),
    ).toEqual({
      clarificationQuestion: '你想分析哪一笔交易？请发送单笔完整交易哈希或对应主网浏览器链接。',
      clarificationReason: 'ambiguous_reference',
      dependency: 'transaction_reference',
      resolution: 'needs_clarification',
    });
  });
});
