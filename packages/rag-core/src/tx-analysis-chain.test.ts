import { describe, expect, it } from 'vitest';

import {
  parseOptionalTxAnalysisChainInput,
  parseRequiredTxAnalysisChainInput,
  toTxAnalysisReferenceInput,
} from './tx-analysis-chain.js';

describe('tx-analysis-chain helpers', () => {
  it('normalizes supported chain aliases', () => {
    expect(parseRequiredTxAnalysisChainInput('SOL mainnet')).toEqual({ chain: 'solana' });
    expect(parseRequiredTxAnalysisChainInput('ETH')).toEqual({ chain: 'ethereum' });
    expect(parseRequiredTxAnalysisChainInput('以太链')).toEqual({ chain: 'ethereum' });
    expect(parseRequiredTxAnalysisChainInput('BNB Smart Chain')).toEqual({ chain: 'bsc' });
    expect(parseRequiredTxAnalysisChainInput('币安智能链')).toEqual({ chain: 'bsc' });
    expect(parseRequiredTxAnalysisChainInput('unknown')).toEqual({ chain: 'unknown' });
  });

  it('returns unsupported chain text for known unsupported aliases', () => {
    expect(parseRequiredTxAnalysisChainInput('Polygon')).toEqual({
      unsupportedChainText: 'Polygon',
    });
    expect(parseRequiredTxAnalysisChainInput('Base Sepolia')).toEqual({
      unsupportedChainText: 'Base Sepolia',
    });
  });

  it('returns undefined for blank optional chain input', () => {
    expect(parseOptionalTxAnalysisChainInput(undefined)).toEqual({});
    expect(parseOptionalTxAnalysisChainInput('   ')).toEqual({});
  });

  it('rejects unsupported unknown words with a stable message', () => {
    expect(() => parseRequiredTxAnalysisChainInput('dogechain')).toThrow(
      'chain must be one of: solana, base, ethereum, bsc, unknown.',
    );
  });

  it('builds a clear transaction reference input string', () => {
    expect(
      toTxAnalysisReferenceInput({
        chain: 'base',
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      }),
    ).toBe('base 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 是否被夹？');
    expect(
      toTxAnalysisReferenceInput({
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      }),
    ).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 是否被夹？');
  });
});
