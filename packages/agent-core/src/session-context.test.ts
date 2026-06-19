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
});
