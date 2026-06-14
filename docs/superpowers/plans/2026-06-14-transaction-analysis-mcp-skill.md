# Transaction Analysis MCP and Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing 交易夹子检测 capability as an MCP server for Agents, with a companion Skill that teaches when to call the MCP and how to explain results safely.

**Architecture:** Keep the current HTTP API, CLI, chat service, browser provider, and report stores intact. Extract shared transaction-analysis runtime helpers from `@xxyy/rag-core`, add a new `@xxyy/tx-analysis-mcp` workspace package using the official TypeScript MCP server stdio transport, and version a repo-local Skill source that can be installed into Codex.

**Tech Stack:** TypeScript ESM, pnpm workspace, Vitest, `@modelcontextprotocol/server`, Zod v4, existing `@xxyy/rag-core` transaction analysis modules.

---

## Scope Boundary

This plan packages the current transaction analysis capability for Agent use.

- It does not replace `/api/tx-analysis`, `/api/chat`, `/ops`, or existing CLI commands.
- It does not add new supported chains.
- It does not move browser automation out of `@xxyy/rag-core`.
- It does not expose private account, order, wallet-balance, or user identity data.
- It keeps `unknown` as bare EVM auto-detect across Base, Ethereum, and BSC.

## File Structure

- Create `packages/rag-core/src/tx-analysis-chain.ts`: canonical chain parsing, aliases, unsupported-chain hints, and direct tx-analysis request parsing shared by API and MCP.
- Create `packages/rag-core/src/tx-analysis-runtime.ts`: provider factory, report-store reader factory, and structured transaction analysis executor.
- Modify `packages/rag-core/src/chat-service.ts`: reuse the exported provider factory instead of private duplicated provider creation.
- Modify `packages/rag-core/src/index.ts`: export new chain/runtime helpers and types.
- Create `packages/rag-core/src/tx-analysis-chain.test.ts`: unit coverage for supported aliases, unsupported aliases, and explorer/hash conflicts.
- Create `packages/rag-core/src/tx-analysis-runtime.test.ts`: unit coverage for success, not configured, invalid reference, unsupported chain, provider failures, and report reader factory.
- Modify `apps/api/src/index.ts`: replace private chain alias parsing with the shared parser while preserving API error messages.
- Modify `apps/api/src/index.test.ts`: keep direct `/api/tx-analysis` alias and unsupported-chain coverage passing.
- Create `packages/tx-analysis-mcp/package.json`: package metadata, scripts, and dependencies.
- Create `packages/tx-analysis-mcp/tsconfig.json`: package TS config.
- Create `packages/tx-analysis-mcp/src/index.ts`: stdio entrypoint.
- Create `packages/tx-analysis-mcp/src/server.ts`: MCP server registration and tool schemas.
- Create `packages/tx-analysis-mcp/src/tools.ts`: MCP tool handler functions that call `@xxyy/rag-core`.
- Create `packages/tx-analysis-mcp/src/tools.test.ts`: handler tests without launching a browser.
- Create `packages/tx-analysis-mcp/src/server.test.ts`: verifies server construction and tool metadata helpers.
- Modify root `tsconfig.json`: add a project reference for `packages/tx-analysis-mcp`.
- Create `scripts/tx-analysis-mcp-smoke.mjs`: local MCP smoke script that starts the stdio server and calls tools via JSON-RPC.
- Modify root `package.json`: add `tx:mcp` and `tx:mcp:smoke` scripts.
- Create `skills/xxyy-transaction-analysis/SKILL.md`: repo-local source for the Agent Skill.
- Create `skills/xxyy-transaction-analysis/agents/openai.yaml`: UI metadata for the Skill source.
- Modify `docs/README.md`: document MCP server, Skill source, install notes, and smoke command.

## Task 1: Shared Chain Parsing

**Files:**

- Create: `packages/rag-core/src/tx-analysis-chain.ts`
- Create: `packages/rag-core/src/tx-analysis-chain.test.ts`
- Modify: `packages/rag-core/src/index.ts`

- [ ] **Step 1: Write failing chain parser tests**

Create `packages/rag-core/src/tx-analysis-chain.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test packages/rag-core/src/tx-analysis-chain.test.ts
```

Expected: FAIL because `tx-analysis-chain.ts` does not exist.

- [ ] **Step 3: Add the shared chain parser**

Create `packages/rag-core/src/tx-analysis-chain.ts`:

```ts
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
```

- [ ] **Step 4: Export the parser**

Modify `packages/rag-core/src/index.ts`:

```ts
export {
  parseOptionalTxAnalysisChainInput,
  parseRequiredTxAnalysisChainInput,
  toTxAnalysisReferenceInput,
  TX_ANALYSIS_CHAIN_ERROR,
} from './tx-analysis-chain.js';

export type { ParsedTxAnalysisChainInput, TxAnalysisReferenceInput } from './tx-analysis-chain.js';
```

- [ ] **Step 5: Verify**

Run:

```bash
pnpm test packages/rag-core/src/tx-analysis-chain.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/rag-core/src/tx-analysis-chain.ts packages/rag-core/src/tx-analysis-chain.test.ts packages/rag-core/src/index.ts
git commit -m "feat: share transaction analysis chain parsing"
```

## Task 2: Shared Transaction Analysis Runtime

**Files:**

- Create: `packages/rag-core/src/tx-analysis-runtime.ts`
- Create: `packages/rag-core/src/tx-analysis-runtime.test.ts`
- Modify: `packages/rag-core/src/chat-service.ts`
- Modify: `packages/rag-core/src/index.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `packages/rag-core/src/tx-analysis-runtime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { analyzeTransaction, createConfiguredTxAnalysisProvider } from './tx-analysis-runtime.js';
import { TxAnalysisProviderUnavailableError } from './tx-analysis.js';

const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

describe('tx-analysis-runtime', () => {
  it('returns not_configured when provider is disabled', async () => {
    await expect(
      analyzeTransaction({
        input: { txHash: evmTx },
        provider: undefined,
      }),
    ).resolves.toEqual({
      failure: {
        message: 'Transaction analysis provider is not configured.',
        reason: 'not_configured',
      },
      status: 'failure',
    });
  });

  it('returns invalid_reference for malformed input', async () => {
    await expect(
      analyzeTransaction({
        input: { txHash: 'not-a-transaction' },
        provider: {
          analyze() {
            throw new Error('provider should not be called');
          },
        },
      }),
    ).resolves.toEqual({
      failure: {
        message: 'Transaction reference is invalid or ambiguous.',
        reason: 'invalid_reference',
      },
      status: 'failure',
    });
  });

  it('returns unsupported_chain for known unsupported chain input', async () => {
    await expect(
      analyzeTransaction({
        input: { chain: 'Polygon', txHash: evmTx },
        provider: {
          analyze() {
            throw new Error('provider should not be called');
          },
        },
      }),
    ).resolves.toEqual({
      failure: {
        message: 'Transaction analysis does not support Polygon.',
        metadata: { unsupportedChainHint: 'Polygon' },
        reason: 'unsupported_chain',
      },
      status: 'failure',
    });
  });

  it('returns success results from the provider', async () => {
    const analyzed = await analyzeTransaction({
      input: { chain: 'base', txHash: evmTx },
      provider: {
        analyze(reference) {
          return Promise.resolve({
            analyzedAt: '2026-06-14T00:00:00.000Z',
            chain: reference.chain,
            confidence: 0.6,
            dataSource: 'fixture',
            evidence: [],
            relatedTransactions: [],
            summary: '未发现典型 sandwich。',
            txHash: reference.txHash,
            verdict: 'not_sandwiched',
          });
        },
      },
    });

    expect(analyzed).toMatchObject({
      result: {
        chain: 'base',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
      status: 'success',
    });
  });

  it('returns structured provider failures', async () => {
    await expect(
      analyzeTransaction({
        input: { chain: 'base', txHash: evmTx },
        provider: {
          analyze() {
            throw new TxAnalysisProviderUnavailableError('BaseScan timeout', 'timeout', {
              reportUrl: '/assets/tx-analysis-failure-base.json',
            });
          },
        },
      }),
    ).resolves.toEqual({
      failure: {
        message: 'BaseScan timeout',
        reason: 'timeout',
        reportUrl: '/assets/tx-analysis-failure-base.json',
      },
      status: 'failure',
    });
  });

  it('creates no provider when TX_ANALYSIS_PROVIDER is none', () => {
    expect(createConfiguredTxAnalysisProvider({ txAnalysisProvider: 'none' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test packages/rag-core/src/tx-analysis-runtime.test.ts
```

Expected: FAIL because `tx-analysis-runtime.ts` does not exist.

- [ ] **Step 3: Create the runtime module**

Create `packages/rag-core/src/tx-analysis-runtime.ts`:

```ts
import type { TxAnalysisChain, TxAnalysisResult } from '@xxyy/shared';

import {
  createBrowserTxAnalysisProvider,
  type BrowserTxAnalysisReportWriter,
  type BrowserTxAnalysisReviewer,
} from './browser-tx-analysis.js';
import type { RagConfig } from './config.js';
import { createOpenAiTxAnalysisReviewer } from './openai-tx-analysis-reviewer.js';
import { createPlaywrightBrowserTxAnalysisDriver } from './playwright-browser-tx-driver.js';
import { createPgPool } from './pgvector-store.js';
import {
  parseOptionalTxAnalysisChainInput,
  toTxAnalysisReferenceInput,
  TX_ANALYSIS_CHAIN_ERROR,
} from './tx-analysis-chain.js';
import {
  createFileTxAnalysisReportWriter,
  createPgTxAnalysisReportStore,
} from './tx-analysis-report-store.js';
import {
  createMockTxAnalysisProvider,
  TxAnalysisProviderUnavailableError,
  TxAnalysisUnsupportedChainError,
  type TxAnalysisFailureMetadata,
  type TxAnalysisProvider,
  type TxAnalysisUnavailableReason,
} from './tx-analysis.js';
import { parseTransactionReference, type TransactionReference } from './tx-hash.js';

export type AnalyzeTransactionInput = {
  chain?: string | TxAnalysisChain;
  txHash: string;
};

export type AnalyzeTransactionOutput =
  | {
      status: 'success';
      result: TxAnalysisResult;
    }
  | {
      status: 'failure';
      failure: {
        reason: TxAnalysisUnavailableReason;
        message: string;
        metadata?: TxAnalysisFailureMetadata;
        reportUrl?: string;
      };
    };

export interface AnalyzeTransactionOptions {
  input: AnalyzeTransactionInput;
  provider: TxAnalysisProvider | undefined;
}

type TxAnalysisProviderConfig = Partial<RagConfig> &
  Pick<
    RagConfig,
    | 'txAnalysisProvider'
    | 'txAnalysisReviewer'
    | 'txAnalysisBrowserHeadless'
    | 'txAnalysisBrowserMaxConcurrency'
    | 'txAnalysisBrowserMaxRetries'
    | 'txAnalysisBrowserTimeoutMs'
    | 'txAnalysisReportStore'
    | 'txAnalysisScreenshotBaseUrl'
    | 'openAiBaseUrl'
    | 'openAiMaxRetries'
    | 'openAiRequestTimeoutMs'
  >;

export async function analyzeTransaction(
  options: AnalyzeTransactionOptions,
): Promise<AnalyzeTransactionOutput> {
  const referenceOrFailure = parseAnalyzeTransactionReference(options.input);
  if ('failure' in referenceOrFailure) {
    return { status: 'failure', failure: referenceOrFailure.failure };
  }

  if (options.provider === undefined) {
    return {
      failure: {
        message: 'Transaction analysis provider is not configured.',
        reason: 'not_configured',
      },
      status: 'failure',
    };
  }

  try {
    return {
      result: await options.provider.analyze(referenceOrFailure.reference),
      status: 'success',
    };
  } catch (error) {
    if (error instanceof TxAnalysisProviderUnavailableError) {
      return {
        failure: {
          message: error.message,
          ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
          reason: error.reason,
          ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
        },
        status: 'failure',
      };
    }
    if (error instanceof TxAnalysisUnsupportedChainError) {
      return {
        failure: {
          message: error.message,
          ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
          reason: 'unsupported_chain',
          ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
        },
        status: 'failure',
      };
    }

    throw error;
  }
}

export function createConfiguredTxAnalysisProvider(
  config: Partial<TxAnalysisProviderConfig>,
): TxAnalysisProvider | undefined {
  if (config.txAnalysisProvider === 'none') {
    return undefined;
  }
  if (config.txAnalysisProvider === 'mock') {
    return createMockTxAnalysisProvider();
  }
  if (config.txAnalysisProvider === 'browser') {
    const fullConfig = config as RagConfig;
    const analysisReviewer = createConfiguredTxAnalysisReviewer(fullConfig);
    return createBrowserTxAnalysisProvider({
      ...(analysisReviewer === undefined ? {} : { analysisReviewer }),
      driver: createPlaywrightBrowserTxAnalysisDriver({
        ...(fullConfig.txAnalysisDiscoverUrl === undefined
          ? {}
          : { discoverUrl: fullConfig.txAnalysisDiscoverUrl }),
        headless: fullConfig.txAnalysisBrowserHeadless,
        screenshotBaseUrl: fullConfig.txAnalysisScreenshotBaseUrl,
        timeoutMs: fullConfig.txAnalysisBrowserTimeoutMs,
        ...(fullConfig.txAnalysisChromeExecutablePath === undefined
          ? {}
          : { chromeExecutablePath: fullConfig.txAnalysisChromeExecutablePath }),
        ...(fullConfig.txAnalysisScreenshotDir === undefined
          ? {}
          : { screenshotDir: fullConfig.txAnalysisScreenshotDir }),
        ...(fullConfig.txAnalysisBrowserUserDataDir === undefined
          ? {}
          : { userDataDir: fullConfig.txAnalysisBrowserUserDataDir }),
      }),
      maxConcurrentAnalyses: fullConfig.txAnalysisBrowserMaxConcurrency,
      maxRetries: fullConfig.txAnalysisBrowserMaxRetries,
      reportWriter: createConfiguredTxAnalysisReportWriter(fullConfig),
    });
  }

  throw new Error(`Unsupported TX_ANALYSIS_PROVIDER: ${config.txAnalysisProvider}`);
}

function parseAnalyzeTransactionReference(input: AnalyzeTransactionInput):
  | { reference: TransactionReference }
  | {
      failure: {
        reason: TxAnalysisUnavailableReason;
        message: string;
        metadata?: TxAnalysisFailureMetadata;
      };
    } {
  let parsedChain: ReturnType<typeof parseOptionalTxAnalysisChainInput>;
  try {
    parsedChain = parseOptionalTxAnalysisChainInput(input.chain);
  } catch (error) {
    return {
      failure: {
        message: error instanceof Error ? error.message : TX_ANALYSIS_CHAIN_ERROR,
        reason: 'invalid_reference',
      },
    };
  }

  if (parsedChain.unsupportedChainText !== undefined) {
    return {
      failure: {
        message: `Transaction analysis does not support ${parsedChain.unsupportedChainText}.`,
        metadata: { unsupportedChainHint: parsedChain.unsupportedChainText },
        reason: 'unsupported_chain',
      },
    };
  }

  const reference = parseTransactionReference(
    toTxAnalysisReferenceInput({
      ...(parsedChain.chain === undefined ? {} : { chain: parsedChain.chain }),
      txHash: input.txHash,
    }),
  );
  if (reference === undefined) {
    return {
      failure: {
        message: 'Transaction reference is invalid or ambiguous.',
        reason: 'invalid_reference',
      },
    };
  }
  if (
    reference.unsupportedExplorerHost !== undefined ||
    reference.unsupportedChainHint !== undefined
  ) {
    return {
      failure: {
        message: 'Transaction analysis does not support this chain or explorer.',
        metadata: {
          ...(reference.unsupportedExplorerHost === undefined
            ? {}
            : { unsupportedExplorerHost: reference.unsupportedExplorerHost }),
          ...(reference.unsupportedChainHint === undefined
            ? {}
            : { unsupportedChainHint: reference.unsupportedChainHint }),
        },
        reason: 'unsupported_chain',
      },
    };
  }

  return { reference };
}

function createConfiguredTxAnalysisReviewer(
  config: RagConfig,
): BrowserTxAnalysisReviewer | undefined {
  if (config.txAnalysisReviewer === 'none') {
    return undefined;
  }
  if (config.txAnalysisReviewer === 'openai') {
    return createOpenAiTxAnalysisReviewer({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
  }

  throw new Error(`Unsupported TX_ANALYSIS_REVIEWER: ${config.txAnalysisReviewer}`);
}

function createConfiguredTxAnalysisReportWriter(config: RagConfig): BrowserTxAnalysisReportWriter {
  if (config.txAnalysisReportStore === 'file') {
    return createFileTxAnalysisReportWriter({
      reportBaseUrl: config.txAnalysisScreenshotBaseUrl,
      ...(config.txAnalysisScreenshotDir === undefined
        ? {}
        : { reportDir: config.txAnalysisScreenshotDir }),
    });
  }
  if (config.txAnalysisReportStore === 'postgres') {
    return createLazyPgTxAnalysisReportWriter(config.databaseUrl);
  }

  throw new Error(`Unsupported TX_ANALYSIS_REPORT_STORE: ${config.txAnalysisReportStore}`);
}

function createLazyPgTxAnalysisReportWriter(
  databaseUrl: string | undefined,
): BrowserTxAnalysisReportWriter {
  let writer: BrowserTxAnalysisReportWriter | undefined;

  function loadWriter(): BrowserTxAnalysisReportWriter {
    writer ??= createPgTxAnalysisReportStore({ client: createPgPool(databaseUrl) });
    return writer;
  }

  return {
    async writeFailureReport(input) {
      const currentWriter = loadWriter();
      if (currentWriter.writeFailureReport === undefined) {
        throw new Error('Transaction analysis failure report writer is not configured.');
      }
      return currentWriter.writeFailureReport(input);
    },

    async writeReport(input) {
      return loadWriter().writeReport(input);
    },
  };
}
```

- [ ] **Step 4: Replace private provider creation in chat service**

Modify `packages/rag-core/src/chat-service.ts`:

```ts
import { createConfiguredTxAnalysisProvider } from './tx-analysis-runtime.js';
```

Remove these imports from `chat-service.ts` because the runtime module owns them:

```ts
import {
  createBrowserTxAnalysisProvider,
  type BrowserTxAnalysisReportWriter,
  type BrowserTxAnalysisReviewer,
} from './browser-tx-analysis.js';
import { createOpenAiTxAnalysisReviewer } from './openai-tx-analysis-reviewer.js';
import { createPlaywrightBrowserTxAnalysisDriver } from './playwright-browser-tx-driver.js';
import { createPgPool } from './pgvector-store.js';
import {
  createFileTxAnalysisReportWriter,
  createPgTxAnalysisReportStore,
} from './tx-analysis-report-store.js';
import { createMockTxAnalysisProvider } from './tx-analysis.js';
```

Delete the private functions `createConfiguredTxAnalysisProvider`, `createConfiguredTxAnalysisReviewer`, `createConfiguredTxAnalysisReportWriter`, and `createLazyPgTxAnalysisReportWriter` from `chat-service.ts`.

- [ ] **Step 5: Export runtime helpers**

Modify `packages/rag-core/src/index.ts`:

```ts
export { analyzeTransaction, createConfiguredTxAnalysisProvider } from './tx-analysis-runtime.js';

export type {
  AnalyzeTransactionInput,
  AnalyzeTransactionOptions,
  AnalyzeTransactionOutput,
} from './tx-analysis-runtime.js';
```

- [ ] **Step 6: Verify focused tests**

Run:

```bash
pnpm test packages/rag-core/src/tx-analysis-runtime.test.ts packages/rag-core/src/chat-service.test.ts packages/rag-core/src/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/rag-core/src/tx-analysis-runtime.ts packages/rag-core/src/tx-analysis-runtime.test.ts packages/rag-core/src/chat-service.ts packages/rag-core/src/index.ts
git commit -m "feat: share transaction analysis runtime"
```

## Task 3: API Uses Shared Chain Parser

**Files:**

- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/index.test.ts`

- [ ] **Step 1: Add a regression test for unsupported direct chain input**

In `apps/api/src/index.test.ts`, add or keep this assertion near the existing direct transaction analysis tests:

```ts
it('returns unsupported_chain for direct transaction analysis chain fields that are known but not supported', async () => {
  const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const calls: unknown[] = [];
  const handler = createRequestHandler({
    getChatService: () =>
      Promise.resolve({
        ask(request) {
          calls.push(request);
          return Promise.resolve({
            answer: 'should not be called',
            citations: [],
            confidence: 0,
            intent: 'tx_sandwich_detection',
          });
        },
        stream() {
          throw new Error('stream should not be used for direct transaction analysis');
        },
      }),
  });

  const response = await callHandler(handler, {
    body: { chain: 'Polygon', txHash },
    method: 'POST',
    url: '/api/tx-analysis',
  });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).answer).toContain('暂不支持');
  expect(calls).toEqual([]);
});
```

- [ ] **Step 2: Run the focused API test**

Run:

```bash
pnpm test apps/api/src/index.test.ts
```

Expected before refactor: PASS if equivalent coverage already exists, otherwise FAIL until implementation is updated.

- [ ] **Step 3: Replace duplicated parser constants**

Modify imports in `apps/api/src/index.ts`:

```ts
import {
  parseOptionalTxAnalysisChainInput,
  parseRequiredTxAnalysisChainInput,
  toTxAnalysisReferenceInput,
  TX_ANALYSIS_CHAIN_ERROR,
} from '@xxyy/rag-core';
```

Remove local `txAnalysisChainAliases`, `unsupportedTxAnalysisChainAliases`, and `normalizeTxAnalysisChain`.

Update `parseTxAnalysisChainValue`:

```ts
function parseTxAnalysisChainValue(chain: string): TxAnalysisChain {
  try {
    const parsed = parseRequiredTxAnalysisChainInput(chain);
    if (parsed.chain === undefined) {
      throw new BadRequestError(TX_ANALYSIS_CHAIN_ERROR);
    }
    return parsed.chain;
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : TX_ANALYSIS_CHAIN_ERROR);
  }
}
```

Update `parseOptionalTxAnalysisPayloadChain`:

```ts
function parseOptionalTxAnalysisPayloadChain(value: unknown): ParsedTxAnalysisPayloadChain {
  try {
    return parseOptionalTxAnalysisChainInput(value);
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : TX_ANALYSIS_CHAIN_ERROR);
  }
}
```

Update `toTxAnalysisChatRequest` to use the shared helper:

```ts
function toTxAnalysisChatRequest(payload: TxAnalysisPayload): ChatRequest {
  return {
    channel: payload.channel ?? 'web',
    message: toTxAnalysisReferenceInput({
      ...(payload.chain === undefined ? {} : { chain: payload.chain }),
      txHash: payload.txHash,
    }),
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    ...(payload.userId === undefined ? {} : { userId: payload.userId }),
  };
}
```

- [ ] **Step 4: Verify**

Run:

```bash
pnpm test apps/api/src/index.test.ts packages/rag-core/src/tx-analysis-chain.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/api/src/index.ts apps/api/src/index.test.ts
git commit -m "refactor: share transaction analysis chain parsing with api"
```

## Task 4: MCP Package and Analyze Tool

**Files:**

- Create: `packages/tx-analysis-mcp/package.json`
- Create: `packages/tx-analysis-mcp/tsconfig.json`
- Create: `packages/tx-analysis-mcp/src/tools.ts`
- Create: `packages/tx-analysis-mcp/src/tools.test.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`

- [ ] **Step 1: Add package metadata**

Create `packages/tx-analysis-mcp/package.json`:

```json
{
  "name": "@xxyy/tx-analysis-mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^1.0.0",
    "@xxyy/rag-core": "workspace:*",
    "@xxyy/shared": "workspace:*",
    "zod": "^4.0.0"
  },
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "vitest run src",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` includes `@modelcontextprotocol/server` and `zod`.

- [ ] **Step 3: Add package tsconfig**

Create `packages/tx-analysis-mcp/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Add root scripts and reference**

Modify root `package.json` scripts:

```json
"tx:mcp": "pnpm --filter @xxyy/tx-analysis-mcp start",
"tx:mcp:smoke": "node scripts/tx-analysis-mcp-smoke.mjs"
```

Modify root `tsconfig.json` references:

```json
{
  "path": "./packages/tx-analysis-mcp"
}
```

- [ ] **Step 5: Write failing analyze tool tests**

Create `packages/tx-analysis-mcp/src/tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createTxAnalysisToolHandlers } from './tools.js';

const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

describe('tx analysis MCP tool handlers', () => {
  it('analyzes a transaction with the configured provider', async () => {
    const handlers = createTxAnalysisToolHandlers({
      provider: {
        analyze(reference) {
          return Promise.resolve({
            analyzedAt: '2026-06-14T00:00:00.000Z',
            chain: reference.chain,
            confidence: 0.6,
            dataSource: 'fixture',
            evidence: [],
            relatedTransactions: [],
            summary: '未发现典型 sandwich。',
            txHash: reference.txHash,
            verdict: 'not_sandwiched',
          });
        },
      },
    });

    await expect(
      handlers.analyzeTransaction({ chain: 'base', txHash: evmTx }),
    ).resolves.toMatchObject({
      result: {
        chain: 'base',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
      status: 'success',
    });
  });

  it('returns not_configured when the provider is missing', async () => {
    const handlers = createTxAnalysisToolHandlers({ provider: undefined });

    await expect(handlers.analyzeTransaction({ txHash: evmTx })).resolves.toEqual({
      failure: {
        message: 'Transaction analysis provider is not configured.',
        reason: 'not_configured',
      },
      status: 'failure',
    });
  });
});
```

- [ ] **Step 6: Run the failing test**

Run:

```bash
pnpm test packages/tx-analysis-mcp/src/tools.test.ts
```

Expected: FAIL because `tools.ts` does not exist.

- [ ] **Step 7: Implement analyze tool handler**

Create `packages/tx-analysis-mcp/src/tools.ts`:

```ts
import {
  analyzeTransaction,
  type AnalyzeTransactionInput,
  type AnalyzeTransactionOutput,
  type TxAnalysisProvider,
} from '@xxyy/rag-core';

export interface TxAnalysisToolHandlersOptions {
  provider: TxAnalysisProvider | undefined;
}

export interface TxAnalysisToolHandlers {
  analyzeTransaction(input: AnalyzeTransactionInput): Promise<AnalyzeTransactionOutput>;
}

export function createTxAnalysisToolHandlers(
  options: TxAnalysisToolHandlersOptions,
): TxAnalysisToolHandlers {
  return {
    analyzeTransaction(input) {
      return analyzeTransaction({
        input,
        provider: options.provider,
      });
    },
  };
}
```

- [ ] **Step 8: Verify package test**

Run:

```bash
pnpm test packages/tx-analysis-mcp/src/tools.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add package.json pnpm-lock.yaml tsconfig.json packages/tx-analysis-mcp
git commit -m "feat: add transaction analysis mcp package"
```

## Task 5: MCP Server Registration

**Files:**

- Create: `packages/tx-analysis-mcp/src/server.ts`
- Create: `packages/tx-analysis-mcp/src/server.test.ts`
- Create: `packages/tx-analysis-mcp/src/index.ts`

- [ ] **Step 1: Write failing server tests**

Create `packages/tx-analysis-mcp/src/server.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  createTxAnalysisMcpServer,
  TX_ANALYSIS_MCP_INSTRUCTIONS,
  TX_ANALYSIS_MCP_TOOL_NAMES,
} from './server.js';

describe('tx analysis MCP server', () => {
  it('declares stable tool names', () => {
    expect(TX_ANALYSIS_MCP_TOOL_NAMES).toEqual([
      'analyze_transaction',
      'get_analysis_report',
      'list_analysis_reports',
    ]);
  });

  it('creates a server with transaction analysis instructions', () => {
    const server = createTxAnalysisMcpServer({
      handlers: {
        analyzeTransaction() {
          throw new Error('not called during construction');
        },
      },
    });

    expect(server).toBeDefined();
    expect(TX_ANALYSIS_MCP_INSTRUCTIONS).toContain('unknown');
    expect(TX_ANALYSIS_MCP_INSTRUCTIONS).toContain('Do not provide investment advice');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test packages/tx-analysis-mcp/src/server.test.ts
```

Expected: FAIL because `server.ts` does not exist.

- [ ] **Step 3: Implement MCP server**

Create `packages/tx-analysis-mcp/src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { TxAnalysisToolHandlers } from './tools.js';

export const TX_ANALYSIS_MCP_TOOL_NAMES = [
  'analyze_transaction',
  'get_analysis_report',
  'list_analysis_reports',
] as const;

export const TX_ANALYSIS_MCP_INSTRUCTIONS = [
  'Use this server for XXYY 交易夹子检测 when the user provides one clear transaction hash or supported explorer link.',
  'Treat unknown as bare EVM auto-detect across Base, Ethereum, and BSC. Unknown is not a real chain.',
  'Do not provide investment advice.',
  'Do not use this server for private account, wallet balance, order, or user identity lookup.',
].join(' ');

const chainSchema = z.enum(['solana', 'base', 'ethereum', 'bsc', 'unknown']).optional();

const analyzeTransactionInputSchema = z.object({
  chain: chainSchema,
  channel: z.enum(['agent', 'ops', 'support']).optional(),
  txHash: z.string().min(1),
});

export interface CreateTxAnalysisMcpServerOptions {
  handlers: TxAnalysisToolHandlers;
}

export function createTxAnalysisMcpServer(options: CreateTxAnalysisMcpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: 'xxyy-transaction-analysis',
      version: '0.1.0',
    },
    {
      instructions: TX_ANALYSIS_MCP_INSTRUCTIONS,
    },
  );

  server.registerTool(
    'analyze_transaction',
    {
      description:
        'Analyze whether one XXYY-related transaction hash or supported explorer link was sandwiched.',
      inputSchema: analyzeTransactionInputSchema,
      title: 'Analyze Transaction Sandwich Status',
    },
    async ({ chain, txHash }) => {
      const output = await options.handlers.analyzeTransaction({
        ...(chain === undefined ? {} : { chain }),
        txHash,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  return server;
}
```

- [ ] **Step 4: Add stdio entrypoint**

Create `packages/tx-analysis-mcp/src/index.ts`:

```ts
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  createConfiguredTxAnalysisProvider,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
} from '@xxyy/rag-core';

import { createTxAnalysisMcpServer } from './server.js';
import { createTxAnalysisToolHandlers } from './tools.js';

const env = loadWorkspaceEnv({
  cwd: resolveWorkspaceCwd(process.cwd(), process.env),
  env: process.env,
});
const config = loadRagConfig(env);
const provider = createConfiguredTxAnalysisProvider(config);
const server = createTxAnalysisMcpServer({
  handlers: createTxAnalysisToolHandlers({ provider }),
});
const transport = new StdioServerTransport();

await server.connect(transport);

process.on('SIGINT', () => {
  void server.close().finally(() => {
    process.exit(0);
  });
});
```

- [ ] **Step 5: Verify server package**

Run:

```bash
pnpm test packages/tx-analysis-mcp/src/server.test.ts packages/tx-analysis-mcp/src/tools.test.ts
pnpm --filter @xxyy/tx-analysis-mcp typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/tx-analysis-mcp/src/server.ts packages/tx-analysis-mcp/src/server.test.ts packages/tx-analysis-mcp/src/index.ts
git commit -m "feat: register transaction analysis mcp server"
```

## Task 6: Report Lookup Tools

**Files:**

- Modify: `packages/rag-core/src/tx-analysis-runtime.ts`
- Modify: `packages/rag-core/src/tx-analysis-runtime.test.ts`
- Modify: `packages/tx-analysis-mcp/src/tools.ts`
- Modify: `packages/tx-analysis-mcp/src/tools.test.ts`
- Modify: `packages/tx-analysis-mcp/src/server.ts`
- Modify: `packages/tx-analysis-mcp/src/server.test.ts`

- [ ] **Step 1: Add report reader runtime tests**

Add to `packages/rag-core/src/tx-analysis-runtime.test.ts`:

```ts
it('creates a file report reader from config', async () => {
  const reader = createConfiguredTxAnalysisReportReader({
    txAnalysisReportStore: 'file',
    txAnalysisScreenshotDir: '/tmp/xxyy-tx-analysis-reports',
  });

  expect(reader.findReports).toBeTypeOf('function');
  expect(reader.summarizeReports).toBeTypeOf('function');
});
```

- [ ] **Step 2: Add report reader factory**

Extend `packages/rag-core/src/tx-analysis-runtime.ts`:

```ts
import {
  findFileTxAnalysisReports,
  getFileTxAnalysisReportDocument,
  summarizeFileTxAnalysisReports,
  updateFileTxAnalysisReportReview,
  type FindTxAnalysisReportsOptions,
  type SummarizeTxAnalysisReportsOptions,
  type TxAnalysisReportIndexEntry,
  type TxAnalysisReportReview,
  type TxAnalysisReportSummary,
  type TxAnalysisStoredReportDocument,
  type UpdateTxAnalysisReportReviewInput,
} from './tx-analysis-report-store.js';

export interface TxAnalysisReportReader {
  findReports(options: FindTxAnalysisReportsOptions): Promise<TxAnalysisReportIndexEntry[]>;
  getReportDocument?(id: string): Promise<TxAnalysisStoredReportDocument | undefined>;
  summarizeReports(options?: SummarizeTxAnalysisReportsOptions): Promise<TxAnalysisReportSummary>;
  updateReportReview?(
    input: UpdateTxAnalysisReportReviewInput,
  ): Promise<TxAnalysisReportReview | undefined>;
}

export function createConfiguredTxAnalysisReportReader(
  config: Pick<RagConfig, 'databaseUrl' | 'txAnalysisReportStore' | 'txAnalysisScreenshotDir'>,
): TxAnalysisReportReader {
  if (config.txAnalysisReportStore === 'postgres') {
    return createPgTxAnalysisReportStore({ client: createPgPool(config.databaseUrl) });
  }
  if (config.txAnalysisReportStore === 'file') {
    const reportDir = config.txAnalysisScreenshotDir;
    return {
      findReports(options) {
        return findFileTxAnalysisReports({ ...options, reportDir });
      },
      getReportDocument(id) {
        return getFileTxAnalysisReportDocument({ id, reportDir });
      },
      summarizeReports(options = {}) {
        return summarizeFileTxAnalysisReports({ ...options, reportDir });
      },
      updateReportReview(input) {
        return updateFileTxAnalysisReportReview({ ...input, reportDir });
      },
    };
  }

  throw new Error(`Unsupported TX_ANALYSIS_REPORT_STORE: ${config.txAnalysisReportStore}`);
}
```

Also export `createConfiguredTxAnalysisReportReader` and `TxAnalysisReportReader` from `packages/rag-core/src/index.ts`.

- [ ] **Step 3: Extend MCP tool handler tests**

Add to `packages/tx-analysis-mcp/src/tools.test.ts`:

```ts
it('lists reports through the configured report reader', async () => {
  const handlers = createTxAnalysisToolHandlers({
    provider: undefined,
    reportReader: {
      findReports(input) {
        expect(input).toEqual({ chain: 'base', limit: 2 });
        return Promise.resolve([
          {
            chain: 'base',
            confidence: 0.6,
            generatedAt: '2026-06-14T00:00:00.000Z',
            reportUrl: '/assets/tx-analysis-report-base.json',
            status: 'success',
            txHash: evmTx,
            verdict: 'not_sandwiched',
          },
        ]);
      },
      summarizeReports() {
        throw new Error('summarize should not be called');
      },
    },
  });

  await expect(handlers.listAnalysisReports({ chain: 'base', limit: 2 })).resolves.toEqual({
    reports: [
      expect.objectContaining({
        chain: 'base',
        txHash: evmTx,
      }),
    ],
  });
});

it('gets a report document by id', async () => {
  const handlers = createTxAnalysisToolHandlers({
    provider: undefined,
    reportReader: {
      findReports() {
        throw new Error('find should not be called');
      },
      getReportDocument(id) {
        expect(id).toBe('tx-analysis-report-base.json');
        return Promise.resolve({
          document: {
            generatedAt: '2026-06-14T00:00:00.000Z',
            reference: { chain: 'base', txHash: evmTx },
            result: {
              analyzedAt: '2026-06-14T00:00:00.000Z',
              chain: 'base',
              confidence: 0.6,
              evidence: [],
              relatedTransactions: [],
              summary: '未发现典型 sandwich。',
              txHash: evmTx,
              verdict: 'not_sandwiched',
            },
            status: 'success',
            version: 1,
          },
          id: 'tx-analysis-report-base.json',
        });
      },
      summarizeReports() {
        throw new Error('summarize should not be called');
      },
    },
  });

  await expect(
    handlers.getAnalysisReport({ id: 'tx-analysis-report-base.json' }),
  ).resolves.toMatchObject({
    document: {
      status: 'success',
    },
  });
});
```

- [ ] **Step 4: Implement report handlers**

Update `packages/tx-analysis-mcp/src/tools.ts`:

```ts
import type { FindTxAnalysisReportsOptions, TxAnalysisReportReader } from '@xxyy/rag-core';

export interface TxAnalysisToolHandlersOptions {
  provider: TxAnalysisProvider | undefined;
  reportReader?: TxAnalysisReportReader;
}

export interface TxAnalysisToolHandlers {
  analyzeTransaction(input: AnalyzeTransactionInput): Promise<AnalyzeTransactionOutput>;
  getAnalysisReport(input: { id: string }): Promise<{ document?: unknown }>;
  listAnalysisReports(
    input: FindTxAnalysisReportsOptions,
  ): Promise<{ reports: Awaited<ReturnType<TxAnalysisReportReader['findReports']>> }>;
}

export function createTxAnalysisToolHandlers(
  options: TxAnalysisToolHandlersOptions,
): TxAnalysisToolHandlers {
  return {
    analyzeTransaction(input) {
      return analyzeTransaction({
        input,
        provider: options.provider,
      });
    },
    async getAnalysisReport(input) {
      const document = await options.reportReader?.getReportDocument?.(input.id);
      return { ...(document === undefined ? {} : { document }) };
    },
    async listAnalysisReports(input) {
      if (options.reportReader === undefined) {
        return { reports: [] };
      }
      return { reports: await options.reportReader.findReports(input) };
    },
  };
}
```

- [ ] **Step 5: Register report MCP tools**

Update `packages/tx-analysis-mcp/src/server.ts`:

```ts
const reportStatusSchema = z.enum(['success', 'failure']).optional();
const reviewStatusSchema = z.enum(['open', 'in_review', 'closed']).optional();
const failureReasonSchema = z
  .enum([
    'not_configured',
    'provider_unavailable',
    'invalid_reference',
    'unsupported_chain',
    'browser_verification_required',
    'tx_not_found',
    'tx_failed',
    'tx_pending',
    'pool_not_found',
    'target_trade_not_found',
    'screenshot_unavailable',
    'timeout',
  ])
  .optional();

server.registerTool(
  'get_analysis_report',
  {
    description: 'Read one stored transaction analysis report by report id.',
    inputSchema: z.object({ id: z.string().min(1) }),
    title: 'Get Transaction Analysis Report',
  },
  async ({ id }) => {
    const output = await options.handlers.getAnalysisReport({ id });
    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  'list_analysis_reports',
  {
    description: 'List stored transaction analysis reports for support or ops review.',
    inputSchema: z.object({
      assignee: z.string().optional(),
      chain: chainSchema,
      limit: z.number().int().positive().max(100).optional(),
      reason: failureReasonSchema,
      reviewStatus: reviewStatusSchema,
      status: reportStatusSchema,
      txHash: z.string().optional(),
    }),
    title: 'List Transaction Analysis Reports',
  },
  async (input) => {
    const output = await options.handlers.listAnalysisReports(input);
    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);
```

- [ ] **Step 6: Update server construction test handlers**

Update `packages/tx-analysis-mcp/src/server.test.ts` so the handler object satisfies the expanded interface:

```ts
const server = createTxAnalysisMcpServer({
  handlers: {
    analyzeTransaction() {
      throw new Error('analyze should not be called during construction');
    },
    getAnalysisReport() {
      throw new Error('get report should not be called during construction');
    },
    listAnalysisReports() {
      throw new Error('list reports should not be called during construction');
    },
  },
});
```

- [ ] **Step 7: Wire report reader in entrypoint**

Update `packages/tx-analysis-mcp/src/index.ts`:

```ts
import {
  createConfiguredTxAnalysisProvider,
  createConfiguredTxAnalysisReportReader,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
} from '@xxyy/rag-core';
```

Create handlers with:

```ts
const handlers = createTxAnalysisToolHandlers({
  provider,
  reportReader: createConfiguredTxAnalysisReportReader(config),
});
```

- [ ] **Step 8: Verify**

Run:

```bash
pnpm test packages/rag-core/src/tx-analysis-runtime.test.ts packages/tx-analysis-mcp/src/tools.test.ts packages/tx-analysis-mcp/src/server.test.ts
pnpm --filter @xxyy/tx-analysis-mcp typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add packages/rag-core/src/tx-analysis-runtime.ts packages/rag-core/src/tx-analysis-runtime.test.ts packages/rag-core/src/index.ts packages/tx-analysis-mcp/src
git commit -m "feat: expose transaction analysis report tools over mcp"
```

## Task 7: MCP Smoke Script

**Files:**

- Create: `scripts/tx-analysis-mcp-smoke.mjs`
- Create: `docs/tx-analysis-mcp-smoke-samples.mock.json`
- Modify: `package.json`
- Modify: `docs/README.md`

- [ ] **Step 1: Add smoke script**

Create `scripts/tx-analysis-mcp-smoke.mjs`:

```js
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const samplesFlagIndex = args.indexOf('--tx-samples');
const samplesFile =
  samplesFlagIndex >= 0
    ? args[samplesFlagIndex + 1]
    : 'docs/tx-analysis-mcp-smoke-samples.mock.json';

const rawSamples = JSON.parse(await readFile(samplesFile, 'utf8'));
const samples = Array.isArray(rawSamples) ? rawSamples : rawSamples.samples;
if (!Array.isArray(samples) || samples.length === 0) {
  throw new Error(`No samples found in ${samplesFile}`);
}

const child = spawn('pnpm', ['--filter', '@xxyy/tx-analysis-mcp', 'start'], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let nextId = 1;
const pending = new Map();
let buffer = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) {
      break;
    }
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) {
      continue;
    }
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve !== undefined) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

function request(method, params) {
  const id = nextId;
  nextId += 1;
  const payload = { id, jsonrpc: '2.0', method, params };
  const response = new Promise((resolve) => {
    pending.set(id, resolve);
  });
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return response;
}

await request('initialize', {
  capabilities: {},
  clientInfo: { name: 'xxyy-tx-analysis-mcp-smoke', version: '0.1.0' },
  protocolVersion: '2025-06-18',
});
child.stdin.write(
  `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
);

for (const sample of samples) {
  const response = await request('tools/call', {
    arguments: {
      chain: sample.chain,
      txHash: sample.txHash,
    },
    name: 'analyze_transaction',
  });
  if (response.error !== undefined) {
    throw new Error(`${sample.label ?? sample.txHash}: ${response.error.message}`);
  }
  const structured = response.result?.structuredContent;
  if (structured?.status !== sample.expectedStatus) {
    throw new Error(
      `${sample.label ?? sample.txHash}: expected ${sample.expectedStatus}, got ${structured?.status}`,
    );
  }
  if (sample.expectedChain !== undefined && structured.result?.chain !== sample.expectedChain) {
    throw new Error(
      `${sample.label ?? sample.txHash}: expected chain ${sample.expectedChain}, got ${structured.result?.chain}`,
    );
  }
  if (
    sample.expectedVerdict !== undefined &&
    structured.result?.verdict !== sample.expectedVerdict
  ) {
    throw new Error(
      `${sample.label ?? sample.txHash}: expected verdict ${sample.expectedVerdict}, got ${structured.result?.verdict}`,
    );
  }
  process.stdout.write(`ok ${sample.label ?? sample.txHash}\n`);
}

child.kill('SIGINT');
await once(child, 'exit');
```

- [ ] **Step 2: Add mock-compatible smoke sample**

Create `docs/tx-analysis-mcp-smoke-samples.mock.json`:

```json
{
  "samples": [
    {
      "label": "Mock Base transaction analysis sample",
      "chain": "base",
      "txHash": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      "expectedStatus": "success",
      "expectedChain": "base",
      "expectedVerdict": "sandwiched"
    }
  ]
}
```

- [ ] **Step 3: Add root script if missing**

Ensure root `package.json` has:

```json
"tx:mcp:smoke": "node scripts/tx-analysis-mcp-smoke.mjs"
```

- [ ] **Step 4: Document usage**

Add this section to `docs/README.md`:

````md
### 交易夹子检测 MCP

Agent integrations should prefer the MCP server when they need to call 交易夹子检测 directly:

```bash
pnpm tx:mcp
```

Local mock MCP smoke:

```bash
TX_ANALYSIS_PROVIDER=mock pnpm tx:mcp:smoke
```

Real browser MCP smoke with the existing multi-chain samples:

```bash
TX_ANALYSIS_PROVIDER=browser pnpm tx:mcp:smoke -- --tx-samples docs/tx-analysis-smoke-samples.example.json
```

For real browser validation, configure the existing browser/report environment variables before running the browser smoke command.
````

- [ ] **Step 5: Run mock smoke**

Run:

```bash
TX_ANALYSIS_PROVIDER=mock pnpm tx:mcp:smoke
```

Expected: The mock sample prints `ok Mock Base transaction analysis sample`.

- [ ] **Step 6: Commit**

Run:

```bash
git add scripts/tx-analysis-mcp-smoke.mjs package.json docs/README.md docs/tx-analysis-mcp-smoke-samples.mock.json
git commit -m "test: add transaction analysis mcp smoke"
```

## Task 8: Agent Skill Source

**Files:**

- Create: `skills/xxyy-transaction-analysis/SKILL.md`
- Create: `skills/xxyy-transaction-analysis/agents/openai.yaml`
- Modify: `docs/README.md`

- [ ] **Step 1: Create Skill source directory**

Run:

```bash
mkdir -p skills/xxyy-transaction-analysis/agents
```

- [ ] **Step 2: Add SKILL.md**

Create `skills/xxyy-transaction-analysis/SKILL.md`:

````md
---
name: xxyy-transaction-analysis
description: Use when an Agent needs to handle XXYY 交易夹子检测 or transaction hash sandwich detection: deciding whether to call the xxyy-transaction-analysis MCP server, explaining sandwiched/not_sandwiched/inconclusive results, looking up transaction analysis reports, or refusing unsupported private account/order/balance/investment-advice requests.
---

# XXYY Transaction Analysis

Use the `xxyy-transaction-analysis` MCP server for 交易夹子检测.

## Call The MCP When

- The user provides exactly one transaction hash or supported explorer link and asks whether it was sandwiched, clipped, MEV attacked, or needs transaction analysis.
- The user asks to look up a previous transaction analysis report.
- The user asks support or ops questions about the transaction analysis review queue.

## Do Not Call The MCP When

- The user asks for wallet balance, private orders, private account state, or user identity.
- The user asks for investment advice or whether to buy or sell.
- The user provides multiple different transaction hashes. Ask them to send one transaction at a time.
- The user asks about unsupported chains without a supported transaction reference.

## Chain Rules

- Supported explicit chains are `solana`, `base`, `ethereum`, and `bsc`.
- `unknown` is only bare EVM hash auto-detection across Base, Ethereum, and BSC.
- `unknown` is not a real chain.
- Do not claim support for Polygon, Arbitrum, Optimism, Avalanche, Mantle, zkSync, Linea, Scroll, testnets, or other unsupported chains.

## Tool Use

Call `analyze_transaction` with:

```json
{
  "txHash": "<hash-or-supported-explorer-link>",
  "chain": "base"
}
```
````

Omit `chain` when the user gave a supported explorer link or a bare hash without a clear chain. Use `chain: "unknown"` only when the user explicitly asks for auto-detection or the host requires a value.

Call `get_analysis_report` when the user gives a report id.

Call `list_analysis_reports` when the user asks for recent reports, failed reports, open review items, or reports filtered by chain/status/reason.

## Answer Style

- Lead with chain, transaction hash, verdict, confidence, and summary.
- Say "疑似被夹" for `sandwiched`.
- Say "未发现典型夹子模式" for `not_sandwiched`.
- Say "证据不足，无法确认" for `inconclusive`.
- Include report and screenshot links when present.
- Include front-run, user, and back-run transaction evidence when present.
- For failures, show the exact reason and useful metadata such as unsupported chain, unsupported explorer host, probe attempts, explorer URL, XXYY pool URL, report URL, and screenshot URL.
- Remind the user that the result is evidence-based chain analysis and not investment advice.

````

- [ ] **Step 3: Add openai.yaml**

Create `skills/xxyy-transaction-analysis/agents/openai.yaml`:

```yaml
display_name: XXYY Transaction Analysis
short_description: Guides Agents to use the XXYY transaction sandwich detection MCP safely.
default_prompt: Use this skill when handling XXYY transaction hash sandwich detection, report lookup, or transaction analysis boundary questions.
````

- [ ] **Step 4: Document Skill install**

Add to `docs/README.md`:

```md
Repo-local Skill source lives in `skills/xxyy-transaction-analysis`. To install it into local Codex discovery, copy that folder to `${CODEX_HOME:-$HOME/.codex}/skills/xxyy-transaction-analysis` after reviewing it.
```

- [ ] **Step 5: Validate Skill shape**

Run:

```bash
test -f skills/xxyy-transaction-analysis/SKILL.md
rg -n "name: xxyy-transaction-analysis|description:" skills/xxyy-transaction-analysis/SKILL.md
```

Expected: both commands pass and `rg` prints the frontmatter fields.

- [ ] **Step 6: Commit**

Run:

```bash
git add skills/xxyy-transaction-analysis docs/README.md
git commit -m "docs: add transaction analysis agent skill"
```

## Task 9: Final Verification

**Files:**

- Verify only.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm test packages/rag-core/src/tx-analysis-chain.test.ts packages/rag-core/src/tx-analysis-runtime.test.ts packages/tx-analysis-mcp/src/tools.test.ts packages/tx-analysis-mcp/src/server.test.ts apps/api/src/index.test.ts packages/rag-core/src/chat-service.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package typechecks**

Run:

```bash
pnpm --filter @xxyy/rag-core typecheck
pnpm --filter @xxyy/tx-analysis-mcp typecheck
pnpm --filter @xxyy/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full project check**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short --branch
git log --oneline -5
```

Expected: working tree is clean except for intended uncommitted changes if the implementer intentionally paused before the final commit.

- [ ] **Step 5: Final commit if needed**

If any verification-only documentation cleanup remains, commit it:

```bash
git add docs/README.md docs/superpowers/plans/2026-06-14-transaction-analysis-mcp-skill.md
git commit -m "docs: document transaction analysis mcp integration"
```

## Self-Review

- Spec coverage: MCP executable capability is covered by Tasks 4-7; Skill guidance is covered by Task 8; existing API preservation is covered by Tasks 2-3 and final API tests; report lookup is covered by Task 6; smoke coverage is covered by Task 7.
- Scope check: this is one coherent packaging project. New chain support, UI redesign, and private account data are excluded.
- Type consistency: `AnalyzeTransactionInput`, `AnalyzeTransactionOutput`, `TxAnalysisReportReader`, and tool handler names are introduced before use in later tasks.
