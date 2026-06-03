import { describe, expect, it } from 'vitest';

import { tokenize } from './tokenize.js';

describe('tokenize', () => {
  it('normalizes mixed Chinese, English, and product terms for lexical search', () => {
    const tokens = tokenize('XXYY Pro 支持 Telegram 钱包监控、Solana MEV 防夹; PumpSwap!');

    expect(tokens).toEqual(
      expect.arrayContaining([
        'xxyy',
        'pro',
        'telegram',
        'solana',
        'mev',
        'pumpswap',
        '钱包',
        '包监',
        '监控',
        '防夹',
        '钱',
        '监',
        '夹',
      ]),
    );
    expect(tokens).not.toContain('XXYY');
    expect(tokens).not.toContain('、');
    expect(tokens).not.toContain(';');
  });
});
