import { describe, expect, it } from 'vitest';

import { parseTransactionReference } from './tx-hash.js';

describe('parseTransactionReference', () => {
  it('extracts an EVM transaction hash', () => {
    expect(
      parseTransactionReference(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 是否被夹了？',
      ),
    ).toEqual({
      chain: 'unknown',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });
  });

  it('extracts a Solana-like transaction hash', () => {
    expect(
      parseTransactionReference(
        '5hQKp7mXw6Lz9qY8rT7uP6nM5bV4cX3zA2sD1fG9hJ8kL7mN6bV5cX4zA3sD2fG1 被夹了吗',
      ),
    ).toEqual({
      chain: 'solana',
      txHash: '5hQKp7mXw6Lz9qY8rT7uP6nM5bV4cX3zA2sD1fG9hJ8kL7mN6bV5cX4zA3sD2fG1',
    });
  });

  it('detects known explorer links', () => {
    expect(
      parseTransactionReference(
        'https://basescan.org/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      ),
    ).toEqual({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });
  });

  it('returns undefined when no transaction reference is present', () => {
    expect(parseTransactionReference('什么是 MEV？')).toBeUndefined();
  });
});
