import type { TxAnalysisChain } from '@xxyy/shared';

export interface ParsedTxAnalysisChainInput {
  chain?: TxAnalysisChain;
  unsupportedChainText?: string;
}

export interface TxAnalysisReferenceInput {
  chain?: TxAnalysisChain;
  txHash: string;
}

const txAnalysisChainAliases = new Map<string, TxAnalysisChain>([
  ['unknown', 'unknown'],
  ['solana', 'solana'],
  ['sol', 'solana'],
  ['sol chain', 'solana'],
  ['sol mainnet', 'solana'],
  ['sol network', 'solana'],
  ['base', 'base'],
  ['ethereum', 'ethereum'],
  ['eth', 'ethereum'],
  ['以太', 'ethereum'],
  ['以太链', 'ethereum'],
  ['以太坊', 'ethereum'],
  ['bsc', 'bsc'],
  ['bnb', 'bsc'],
  ['bnbchain', 'bsc'],
  ['bnb chain', 'bsc'],
  ['bnbsmartchain', 'bsc'],
  ['bnb smartchain', 'bsc'],
  ['bnb smart chain', 'bsc'],
  ['binance chain', 'bsc'],
  ['binancesmartchain', 'bsc'],
  ['binance smartchain', 'bsc'],
  ['binance smart chain', 'bsc'],
  ['bep20', 'bsc'],
  ['bep 20', 'bsc'],
  ['币安', 'bsc'],
  ['币安链', 'bsc'],
  ['币安智能链', 'bsc'],
]);

const unsupportedTxAnalysisChainAliases = new Set([
  'amoy',
  'arb',
  'arbitrum',
  'arbitrum one',
  'abstract',
  'avalanche',
  'avalanche c chain',
  'avax',
  'avax c chain',
  'berachain',
  'base goerli',
  'base sepolia',
  'bnb chain testnet',
  'bnb smart chain testnet',
  'bnb smartchain testnet',
  'bnb testnet',
  'blast',
  'bsc testnet',
  'celo',
  'cronos',
  'devnet',
  'eth goerli',
  'eth holesky',
  'eth hoodi',
  'eth sepolia',
  'ethereum goerli',
  'ethereum holesky',
  'ethereum hoodi',
  'ethereum sepolia',
  'fantom',
  'fantom opera',
  'fuji',
  'gnosis',
  'gnosis chain',
  'goerli',
  'holesky',
  'hoodi',
  'linea',
  'manta',
  'manta pacific',
  'mantle',
  'matic',
  'mode',
  'mode network',
  'moonbeam',
  'moonriver',
  'op',
  'opbnb',
  'optimistic ethereum',
  'optimism',
  'plasma',
  'polygon',
  'polygon pos',
  'polygon zkevm',
  'scroll',
  'sepolia',
  'sonic',
  'taiko',
  'testnet',
  'world chain',
  'x layer',
  'xlayer',
  'zora',
  'zora network',
  'zk sync',
  'zk sync era',
  'zksync',
  'zksync era',
]);

export const TX_ANALYSIS_CHAIN_ERROR =
  'chain must be one of: solana, base, ethereum, bsc, unknown.';

export function parseOptionalTxAnalysisChainInput(value: unknown): ParsedTxAnalysisChainInput {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'string') {
    throw new Error(TX_ANALYSIS_CHAIN_ERROR);
  }

  const normalized = normalizeTxAnalysisChainInput(value);
  if (normalized === undefined) {
    return {};
  }

  return parseNormalizedTxAnalysisChain(normalized, value);
}

export function parseRequiredTxAnalysisChainInput(value: string): ParsedTxAnalysisChainInput {
  const normalized = normalizeTxAnalysisChainInput(value);
  if (normalized === undefined) {
    throw new Error(TX_ANALYSIS_CHAIN_ERROR);
  }

  return parseNormalizedTxAnalysisChain(normalized, value);
}

export function toTxAnalysisReferenceInput(input: TxAnalysisReferenceInput): string {
  if (input.chain === undefined || input.chain === 'unknown') {
    return `${input.txHash} 是否被夹？`;
  }

  return `${input.chain} ${input.txHash} 是否被夹？`;
}

function parseNormalizedTxAnalysisChain(
  normalized: string,
  original: string,
): ParsedTxAnalysisChainInput {
  const chain = txAnalysisChainAliases.get(normalized);
  if (chain !== undefined) {
    return { chain };
  }
  if (unsupportedTxAnalysisChainAliases.has(normalized)) {
    return { unsupportedChainText: original.trim() };
  }

  throw new Error(TX_ANALYSIS_CHAIN_ERROR);
}

function normalizeTxAnalysisChainInput(value: string): string | undefined {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ');

  if (normalized.length === 0) {
    return undefined;
  }

  const withoutMainnetSuffix = normalized.replace(/\s+mainnet(?:\s+beta)?$/u, '');
  return withoutMainnetSuffix.length === 0 ? normalized : withoutMainnetSuffix;
}
