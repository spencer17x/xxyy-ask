import { describe, expect, it } from 'vitest';

import {
  createInMemorySessionContextStore,
  sanitizeSessionText,
  type SessionTurn,
} from './session-context.js';

describe('session context', () => {
  it('stores recent sanitized turns per session and respects max turn retention', async () => {
    const store = createInMemorySessionContextStore({
      maxTurnsPerSession: 2,
      now: () => new Date('2026-06-19T00:00:00.000Z'),
    });

    const firstTurn: SessionTurn = {
      content: 'XXYY Pro 有哪些权益？',
      createdAt: '2026-06-19T00:00:00.000Z',
      metadata: { confidence: 0.8, intent: 'product_qa' },
      role: 'user',
    };
    const secondTurn: SessionTurn = {
      content: 'XXYY Pro 提供更高监控上限。',
      createdAt: '2026-06-19T00:00:00.000Z',
      metadata: { citationCount: 1, confidence: 0.8, intent: 'product_qa' },
      role: 'assistant',
    };
    const thirdTurn: SessionTurn = {
      content: '怎么升级？',
      createdAt: '2026-06-19T00:00:00.000Z',
      metadata: { intent: 'how_to' },
      role: 'user',
    };

    await store.appendTurn('session-1', firstTurn);
    await store.appendTurn('session-1', secondTurn);
    await store.appendTurn('session-1', thirdTurn);

    await expect(store.getRecentTurns('session-1')).resolves.toEqual([secondTurn, thirdTurn]);
    await expect(store.getRecentTurns('missing-session')).resolves.toEqual([]);
  });

  it('keeps a safe product summary after older turns are pruned', async () => {
    const store = createInMemorySessionContextStore({
      maxTurnsPerSession: 2,
      now: () => new Date('2026-06-19T00:00:00.000Z'),
    });
    const summaryStore = store as typeof store & {
      getSessionSummary(sessionId: string): Promise<{
        productPreference?: string;
        updatedAt: string;
      } | null>;
    };

    await store.appendTurn('session-1', {
      content: '我主要用手机端。',
      createdAt: '2026-06-19T00:00:00.000Z',
      metadata: { intent: 'product_qa' },
      role: 'user',
    });
    await store.appendTurn('session-1', {
      content: '已记录移动端偏好。',
      createdAt: '2026-06-19T00:00:01.000Z',
      metadata: { intent: 'product_qa' },
      role: 'assistant',
    });
    await store.appendTurn('session-1', {
      content: '帮我查一下钱包余额',
      createdAt: '2026-06-19T00:00:02.000Z',
      metadata: { intent: 'realtime_account_query' },
      role: 'user',
    });

    await expect(store.getRecentTurns('session-1')).resolves.toEqual([
      {
        content: '已记录移动端偏好。',
        createdAt: '2026-06-19T00:00:01.000Z',
        metadata: { intent: 'product_qa' },
        role: 'assistant',
      },
      {
        content: '帮我查一下钱包余额',
        createdAt: '2026-06-19T00:00:02.000Z',
        metadata: { intent: 'realtime_account_query' },
        role: 'user',
      },
    ]);
    await expect(summaryStore.getSessionSummary('session-1')).resolves.toEqual({
      productPreference: 'XXYY 移动端登录',
      updatedAt: '2026-06-19T00:00:00.000Z',
    });
    await expect(summaryStore.getSessionSummary('missing-session')).resolves.toBeNull();
  });

  it('redacts private-looking identifiers while preserving public transaction marker usefulness', () => {
    expect(
      sanitizeSessionText(
        '我的钱包 0x1111111111111111111111111111111111111111 查余额，交易 0x2222222222222222222222222222222222222222222222222222222222222222',
      ),
    ).toBe('我的钱包 [evm_address] 查余额，交易 [evm_tx_hash]');
  });

  it('redacts seed phrases and private keys before storing session context', () => {
    expect(
      sanitizeSessionText(
        '我的助记词是 abandon ability able about above absent absorb abstract absurd abuse access accident',
      ),
    ).toBe('我的助记词是 [sensitive_credential]');
    expect(
      sanitizeSessionText(
        'private key: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toBe('private key: [sensitive_credential]');
  });

  it('redacts passwords and API keys before storing session context', () => {
    expect(sanitizeSessionText('我的密码是 hunter2')).toBe('我的密码是 [sensitive_credential]');
    expect(sanitizeSessionText('api key: sk-test-123456')).toBe('api key: [sensitive_credential]');
    expect(sanitizeSessionText('Bearer sk-live-1234567890abcdef')).toBe(
      'Bearer [sensitive_credential]',
    );
    expect(sanitizeSessionText('secret key = xxyy-secret-123456')).toBe(
      'secret key = [sensitive_credential]',
    );
  });
});
