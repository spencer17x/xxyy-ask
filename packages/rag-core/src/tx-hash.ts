import type { TxAnalysisChain } from '@xxyy/shared';

export interface TransactionReference {
  txHash: string;
  chain: TxAnalysisChain;
  unsupportedExplorerHost?: string;
  unsupportedChainHint?: string;
}

type TransactionReferenceCandidate = {
  kind: 'evm' | 'solana';
  txHash: string;
};

type UnsupportedSolanaExplorer = {
  cluster: string;
  host: string;
};

const evmHashGlobalPattern = /\b0x[a-fA-F0-9]{64}\b/giu;
const solanaSignatureGlobalPattern = /\b[1-9A-HJ-NP-Za-km-z]{64,96}\b/gu;
const knownUnsupportedEvmExplorerHostRoots = new Set([
  'arbiscan.io',
  'blastscan.io',
  'celoscan.io',
  'cronoscan.com',
  'era.zksync.network',
  'ftmscan.com',
  'gnosisscan.io',
  'lineascan.build',
  'mantlescan.xyz',
  'moonscan.io',
  'opbnbscan.com',
  'polygonscan.com',
  'scrollscan.com',
  'snowtrace.io',
]);
const knownUnsupportedEvmChainTextHints: Array<{
  hint: string;
  pattern: RegExp;
}> = [
  { hint: 'testnet', pattern: /\b(?:amoy|devnet|fuji|goerli|holesky|hoodi|sepolia|testnet)\b/u },
  { hint: 'abstract', pattern: /\babstract\b/u },
  { hint: 'arbitrum', pattern: /\b(?:arbitrum|arb)\b/u },
  { hint: 'avalanche', pattern: /\b(?:avalanche|avax)\b/u },
  { hint: 'berachain', pattern: /\bbera(?:chain)?\b/u },
  { hint: 'blast', pattern: /\bblast\b/u },
  { hint: 'celo', pattern: /\bcelo\b/u },
  { hint: 'cronos', pattern: /\bcronos\b/u },
  { hint: 'fantom', pattern: /\bfantom\b/u },
  { hint: 'gnosis', pattern: /\bgnosis\b/u },
  { hint: 'linea', pattern: /\blinea\b/u },
  { hint: 'manta', pattern: /\bmanta(?:\s+pacific)?\b/u },
  { hint: 'mantle', pattern: /\bmantle\b/u },
  { hint: 'mode', pattern: /\bmode(?:\s+network)?\b/u },
  { hint: 'moonbeam', pattern: /\bmoonbeam\b/u },
  { hint: 'moonriver', pattern: /\bmoonriver\b/u },
  { hint: 'optimism', pattern: /\b(?:optimism|optimistic(?:\s+ethereum)?|op)\b/u },
  { hint: 'opbnb', pattern: /\bopbnb\b/u },
  { hint: 'plasma', pattern: /\bplasma\b/u },
  { hint: 'polygon', pattern: /\b(?:polygon|matic)\b/u },
  { hint: 'scroll', pattern: /\bscroll\b/u },
  { hint: 'sonic', pattern: /\bsonic\b/u },
  { hint: 'taiko', pattern: /\btaiko\b/u },
  { hint: 'worldchain', pattern: /\bworld\s*chain\b/u },
  { hint: 'xlayer', pattern: /\bx[-\s]*layer\b/u },
  { hint: 'zora', pattern: /\bzora(?:\s+network)?\b/u },
  { hint: 'zksync', pattern: /\bzk[\s_-]*sync(?:[\s_-]+era)?\b/u },
];

export function parseTransactionReference(input: string): TransactionReference | undefined {
  const normalized = input.normalize('NFKC').trim();
  if (normalized.length === 0) {
    return undefined;
  }

  const candidates = collectUniqueTransactionReferenceCandidates(normalized);
  if (candidates.length !== 1) {
    return undefined;
  }

  const candidate = candidates[0];
  if (candidate === undefined) {
    return undefined;
  }

  if (candidate.kind === 'evm') {
    const unsupportedExplorerHost = findUnsupportedEvmExplorerHost(normalized);
    const unsupportedChainHint = findUnsupportedEvmChainTextHint(normalized);
    const inferredChain =
      unsupportedExplorerHost === undefined ? inferEvmChain(normalized) : 'unknown';
    if (inferredChain === undefined) {
      return undefined;
    }
    const chain = unsupportedChainHint === undefined ? inferredChain : 'unknown';

    return {
      chain,
      txHash: candidate.txHash,
      ...(unsupportedExplorerHost === undefined ? {} : { unsupportedExplorerHost }),
      ...(unsupportedChainHint === undefined ? {} : { unsupportedChainHint }),
    };
  }

  const unsupportedSolanaExplorer = findUnsupportedSolanaExplorer(normalized);
  const chain = inferSolanaChain(normalized);
  if (chain === undefined) {
    return undefined;
  }

  return {
    chain,
    txHash: candidate.txHash,
    ...(unsupportedSolanaExplorer === undefined
      ? {}
      : {
          unsupportedChainHint: unsupportedSolanaExplorer.cluster,
          unsupportedExplorerHost: unsupportedSolanaExplorer.host,
        }),
  };
}

export function hasAmbiguousTransactionReferences(input: string): boolean {
  const normalized = input.normalize('NFKC').trim();
  return collectUniqueTransactionReferenceCandidates(normalized).length > 1;
}

export function hasTransactionReferenceCandidate(input: string): boolean {
  const normalized = input.normalize('NFKC').trim();
  return collectUniqueTransactionReferenceCandidates(normalized).length > 0;
}

function collectUniqueTransactionReferenceCandidates(
  input: string,
): TransactionReferenceCandidate[] {
  const candidates = new Map<string, TransactionReferenceCandidate>();

  for (const match of input.matchAll(evmHashGlobalPattern)) {
    const txHash = match[0];
    const key = `evm:${txHash.toLowerCase()}`;
    if (!candidates.has(key)) {
      candidates.set(key, { kind: 'evm', txHash });
    }
  }

  for (const match of input.matchAll(solanaSignatureGlobalPattern)) {
    const txHash = match[0];
    const key = `solana:${txHash}`;
    if (!candidates.has(key)) {
      candidates.set(key, { kind: 'solana', txHash });
    }
  }

  return [...candidates.values()];
}

function inferEvmChain(input: string): TxAnalysisChain | undefined {
  const lower = input.toLowerCase();
  if (hasSolanaTextHint(lower)) {
    return undefined;
  }

  const explorerHints = inferEvmExplorerHostHints(lower);
  const textHints = inferEvmTextHints(lower);
  if (explorerHints.size === 1) {
    const explorerChain = [...explorerHints][0] ?? 'unknown';
    if (
      explorerChain !== 'unknown' &&
      textHints.size > 0 &&
      (textHints.size !== 1 || !textHints.has(explorerChain))
    ) {
      return undefined;
    }

    return explorerChain;
  }
  if (explorerHints.size > 1) {
    return 'unknown';
  }

  if (textHints.size === 1) {
    return [...textHints][0] ?? 'unknown';
  }

  return 'unknown';
}

function inferEvmTextHints(lower: string): Set<TxAnalysisChain> {
  const textHints = new Set<TxAnalysisChain>();
  if (/\bbase\b/u.test(lower)) {
    textHints.add('base');
  }
  if (/\beth(?:ereum)?\b/u.test(lower) || /以太(?:坊|链)?/u.test(lower)) {
    textHints.add('ethereum');
  }
  if (
    /\bbsc\b/u.test(lower) ||
    /\bbnb\b/u.test(lower) ||
    /\bbnbchain\b/u.test(lower) ||
    /\bbnbsmartchain\b/u.test(lower) ||
    /\bbep[-\s]?20\b/u.test(lower) ||
    /\bbnb\s+chain\b/u.test(lower) ||
    /\bbnb\s+smart[-\s]*chain\b/u.test(lower) ||
    /\bbinancesmartchain\b/u.test(lower) ||
    /\bbinance[-\s]+chain\b/u.test(lower) ||
    /\bbinance[-\s]+smart[-\s]*chain\b/u.test(lower) ||
    /币安(?:智能)?链?/u.test(lower)
  ) {
    textHints.add('bsc');
  }

  return textHints;
}

function hasSolanaTextHint(lower: string): boolean {
  return (
    /\bsolana\b/u.test(lower) ||
    /\bsol\s+(?:chain|network|mainnet)\b/u.test(lower) ||
    /\bsol\s*链/u.test(lower) ||
    /索拉纳/u.test(lower)
  );
}

function inferEvmExplorerHostHints(input: string): Set<TxAnalysisChain> {
  const hints = new Set<TxAnalysisChain>();
  for (const host of extractUrlHosts(input)) {
    switch (normalizeExplorerHost(host)) {
      case 'basescan.org':
      case 'base.blockscout.com':
        hints.add('base');
        break;
      case 'etherscan.io':
      case 'eth.blockscout.com':
        hints.add('ethereum');
        break;
      case 'bscscan.com':
      case 'bsctrace.com':
        hints.add('bsc');
        break;
    }
  }

  return hints;
}

function findUnsupportedEvmExplorerHost(input: string): string | undefined {
  return extractUrlHosts(input).find(isUnsupportedEvmExplorerHost);
}

function findUnsupportedEvmChainTextHint(input: string): string | undefined {
  const lower = input.toLowerCase();
  return knownUnsupportedEvmChainTextHints.find(({ pattern }) => pattern.test(lower))?.hint;
}

function isUnsupportedEvmExplorerHost(host: string): boolean {
  const normalizedHost = normalizeExplorerHost(host);
  return (
    !isSupportedEvmExplorerHost(normalizedHost) &&
    (isKnownUnsupportedEvmExplorerHost(normalizedHost) ||
      normalizedHost.endsWith('.blockscout.com') ||
      ['basescan.org', 'etherscan.io', 'bscscan.com', 'bsctrace.com'].some((rootHost) =>
        normalizedHost.endsWith(`.${rootHost}`),
      ))
  );
}

function isKnownUnsupportedEvmExplorerHost(host: string): boolean {
  return [...knownUnsupportedEvmExplorerHostRoots].some(
    (rootHost) => host === rootHost || host.endsWith(`.${rootHost}`),
  );
}

function isSupportedEvmExplorerHost(host: string): boolean {
  return (
    host === 'basescan.org' ||
    host === 'base.blockscout.com' ||
    host === 'etherscan.io' ||
    host === 'eth.blockscout.com' ||
    host === 'bscscan.com' ||
    host === 'bsctrace.com'
  );
}

function extractUrlHosts(input: string): string[] {
  const hosts = new Set<string>();
  const hostPattern = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/:?#\s]|$)/giu;
  for (const match of input.matchAll(hostPattern)) {
    const host = match[1];
    if (host !== undefined) {
      hosts.add(host.toLowerCase());
    }
  }

  return [...hosts];
}

function normalizeExplorerHost(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

function findUnsupportedSolanaExplorer(input: string): UnsupportedSolanaExplorer | undefined {
  for (const url of extractUrls(input)) {
    const unsupportedCluster = getUnsupportedSolanaExplorerCluster(url);
    if (unsupportedCluster !== undefined) {
      return {
        cluster: unsupportedCluster,
        host: url.host,
      };
    }
  }

  return undefined;
}

function getUnsupportedSolanaExplorerCluster(url: URL): string | undefined {
  const host = normalizeExplorerHost(url.host.toLowerCase());
  if (host !== 'explorer.solana.com' && host !== 'solscan.io' && host !== 'solana.fm') {
    return undefined;
  }

  const cluster = normalizeSolanaCluster(getSolanaExplorerCluster(url));
  return cluster !== undefined && cluster !== 'mainnet' && cluster !== 'mainnet-beta'
    ? cluster
    : undefined;
}

function getSolanaExplorerCluster(url: URL): string | null {
  return url.searchParams.get('cluster') ?? getSolanaExplorerFragmentCluster(url.hash);
}

function getSolanaExplorerFragmentCluster(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (fragment.trim().length === 0) {
    return null;
  }

  const fragmentParams = new URLSearchParams(
    fragment.startsWith('?') ? fragment.slice(1) : fragment,
  );
  const directCluster = fragmentParams.get('cluster');
  if (directCluster !== null) {
    return directCluster;
  }

  const queryStart = fragment.indexOf('?');
  if (queryStart === -1) {
    return null;
  }

  return new URLSearchParams(fragment.slice(queryStart + 1)).get('cluster');
}

function normalizeSolanaCluster(cluster: string | null): string | undefined {
  if (cluster === null) {
    return undefined;
  }

  return cluster
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+$/gu, '');
}

function extractUrls(input: string): URL[] {
  const urls: URL[] = [];
  const urlPattern = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}[^\s]*/giu;
  for (const match of input.matchAll(urlPattern)) {
    const rawUrl = match[0];
    if (rawUrl === undefined) {
      continue;
    }

    const url = parseUrl(rawUrl);
    if (url !== undefined) {
      urls.push(url);
    }
  }

  return urls;
}

function parseUrl(rawUrl: string): URL | undefined {
  try {
    return new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`);
  } catch {
    return undefined;
  }
}

function inferSolanaChain(input: string): TxAnalysisChain | undefined {
  const lower = input.toLowerCase();
  if (inferEvmTextHints(lower).size > 0) {
    return undefined;
  }

  if (
    lower.includes('solscan.io') ||
    lower.includes('solana.fm') ||
    lower.includes('explorer.solana.com')
  ) {
    return 'solana';
  }

  return 'solana';
}
