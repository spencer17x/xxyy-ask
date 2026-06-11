import type { TxAnalysisChain } from '@xxyy/shared';

export interface TransactionReference {
  txHash: string;
  chain: TxAnalysisChain;
}

const evmHashPattern = /\b0x[a-fA-F0-9]{64}\b/u;
const solanaSignaturePattern = /\b[1-9A-HJ-NP-Za-km-z]{64,96}\b/u;

export function parseTransactionReference(input: string): TransactionReference | undefined {
  const normalized = input.normalize('NFKC').trim();
  if (normalized.length === 0) {
    return undefined;
  }

  const evmMatch = evmHashPattern.exec(normalized);
  if (evmMatch !== null) {
    return {
      chain: inferEvmChain(normalized),
      txHash: evmMatch[0],
    };
  }

  const solanaMatch = solanaSignaturePattern.exec(normalized);
  if (solanaMatch !== null) {
    return {
      chain: inferSolanaChain(normalized),
      txHash: solanaMatch[0],
    };
  }

  return undefined;
}

function inferEvmChain(input: string): TxAnalysisChain {
  const lower = input.toLowerCase();
  if (lower.includes('basescan.org')) {
    return 'base';
  }
  if (lower.includes('etherscan.io')) {
    return 'ethereum';
  }
  if (lower.includes('bscscan.com')) {
    return 'bsc';
  }

  return 'unknown';
}

function inferSolanaChain(input: string): TxAnalysisChain {
  const lower = input.toLowerCase();
  if (
    lower.includes('solscan.io') ||
    lower.includes('solana.fm') ||
    lower.includes('explorer.solana.com')
  ) {
    return 'solana';
  }

  return 'solana';
}
