# Tx Hash Sandwich Detection MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a testable MVP path that recognizes transaction-hash sandwich detection requests and returns a structured mock analysis with an image attachment, without claiming real chain analysis is implemented.

**Architecture:** Add a new `tx_sandwich_detection` intent, parse transaction hashes, route matching chat requests to a dedicated transaction-analysis service, and extend CLI/Web/API attachment handling for image outputs. The MVP uses an injected or explicitly configured mock provider; real chain data providers are added later behind the same interface.

**Tech Stack:** TypeScript ESM, Vitest, Node HTTP API, static Web UI, existing `ChatResponse` contract, existing `/assets/*` static asset path.

---

## Scope Boundary

This plan implements only the MVP skeleton:

- It does not connect to real chain data.
- It does not mark the user-facing sandwich detection feature complete in `docs/feature-status.md`.
- It must label mock results as fixture/demo data unless a real provider is injected in tests or future work.

## File Structure

- Modify `packages/shared/src/index.ts`: add intent, transaction-analysis result types, and image attachment union.
- Modify `packages/shared/src/chat-contract.test.ts`: assert new intent and image attachment contract.
- Create `packages/rag-core/src/tx-hash.ts`: parse transaction hashes and transaction links.
- Create `packages/rag-core/src/tx-analysis.ts`: provider interface, mock provider, response formatter.
- Modify `packages/rag-core/src/classify.ts`: classify hash + sandwich/MEV wording as `tx_sandwich_detection`.
- Modify `packages/rag-core/src/classify.test.ts`: cover new intent and priority rules.
- Modify `packages/rag-core/src/chat-service.ts`: route `tx_sandwich_detection` to tx analysis provider.
- Modify `packages/rag-core/src/chat-service.test.ts`: cover ask/stream tx analysis behavior.
- Modify `packages/rag-core/src/index.ts`: export tx analysis types/factories.
- Modify `apps/api/src/index.ts`: serve image content types for attachments.
- Modify `apps/api/src/index.test.ts`: test image asset content type and tx response pass-through.
- Modify `apps/web/src/index.ts`: render `image` attachments with `<img>`.
- Modify `apps/web/src/index.test.ts`: assert image attachment rendering logic.
- Modify `apps/cli/src/index.ts`: format image attachments.
- Modify `apps/cli/src/index.test.ts`: assert image attachment output.
- Create `docs/product-features/assets/tx-analysis-fixture.svg`: static fixture image for MVP screenshot attachment.
- Modify `docs/feature-status.md`: add a note that tx hash detection is planned/MVP skeleton when implemented, not real chain analysis.

## Task 1: Shared Contract

**Files:**

- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/chat-contract.test.ts`

- [ ] **Step 1: Write failing shared contract tests**

Update `packages/shared/src/chat-contract.test.ts` with tests equivalent to:

```ts
it('defines transaction sandwich detection as a supported intent', () => {
  expect(supportedIntents).toContain('tx_sandwich_detection');
});

it('allows image attachments for transaction analysis screenshots', () => {
  const response: ChatResponse = {
    answer: '交易哈希分析截图如下。',
    attachments: [
      {
        kind: 'image',
        mediaType: 'image/svg+xml',
        title: '交易分析截图',
        url: '/assets/tx-analysis-fixture.svg',
      },
    ],
    citations: [],
    confidence: 0.8,
    intent: 'tx_sandwich_detection',
  };

  expect(response.attachments?.[0]?.kind).toBe('image');
});
```

- [ ] **Step 2: Run failing shared tests**

Run:

```bash
pnpm test packages/shared/src/chat-contract.test.ts
```

Expected: FAIL because `tx_sandwich_detection` and image attachments are not defined.

- [ ] **Step 3: Add shared types**

Update `packages/shared/src/index.ts`:

```ts
export const supportedIntents = [
  'product_qa',
  'how_to',
  'tx_sandwich_detection',
  'realtime_account_query',
  'mev_or_chain_forensics',
  'investment_advice',
  'unknown',
] as const;

export type TxAnalysisVerdict = 'sandwiched' | 'not_sandwiched' | 'inconclusive';

export type TxAnalysisChain = 'solana' | 'base' | 'ethereum' | 'bsc' | 'unknown';

export interface TxAnalysisRelatedTransaction {
  role: 'front_run' | 'user' | 'back_run' | 'related';
  hash: string;
  summary: string;
  timestamp?: string;
  explorerUrl?: string;
}

export interface TxAnalysisEvidence {
  label: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface TxAnalysisResult {
  txHash: string;
  chain: TxAnalysisChain;
  verdict: TxAnalysisVerdict;
  confidence: number;
  summary: string;
  evidence: TxAnalysisEvidence[];
  relatedTransactions: TxAnalysisRelatedTransaction[];
  analyzedAt: string;
  screenshotUrl?: string;
}

export type ChatAttachment =
  | {
      kind: 'video';
      title: string;
      url: string;
      mediaType: 'video/mp4';
    }
  | {
      kind: 'image';
      title: string;
      url: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
    };
```

Replace the old `ChatAttachment` interface with the union above.

- [ ] **Step 4: Run shared tests**

Run:

```bash
pnpm test packages/shared/src/chat-contract.test.ts
```

Expected: PASS.

## Task 2: Transaction Hash Parser and Classification

**Files:**

- Create: `packages/rag-core/src/tx-hash.ts`
- Modify: `packages/rag-core/src/classify.ts`
- Modify: `packages/rag-core/src/classify.test.ts`

- [ ] **Step 1: Write parser tests**

Create tests in a new `packages/rag-core/src/tx-hash.test.ts`:

```ts
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

  it('returns undefined when no transaction reference is present', () => {
    expect(parseTransactionReference('什么是 MEV？')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Write classification tests**

Update `packages/rag-core/src/classify.test.ts`:

```ts
it('classifies transaction hash sandwich detection as a dedicated intent', () => {
  expect(
    classifyQuestion(
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 这个交易是不是被夹了？',
    ).intent,
  ).toBe('tx_sandwich_detection');
});

it('keeps generic MEV questions on the boundary intent without a transaction hash', () => {
  expect(classifyQuestion('什么是 MEV sandwich？').intent).toBe('mev_or_chain_forensics');
});

it('keeps investment advice above transaction analysis', () => {
  expect(
    classifyQuestion(
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 这个交易被夹了的话我该买还是卖？',
    ).intent,
  ).toBe('investment_advice');
});
```

- [ ] **Step 3: Run failing parser/classification tests**

Run:

```bash
pnpm test packages/rag-core/src/tx-hash.test.ts packages/rag-core/src/classify.test.ts
```

Expected: FAIL because `tx-hash.ts` and the new intent do not exist.

- [ ] **Step 4: Implement parser**

Create `packages/rag-core/src/tx-hash.ts`:

```ts
import type { TxAnalysisChain } from '@xxyy/shared';

export interface ParsedTransactionReference {
  chain: TxAnalysisChain;
  txHash: string;
}

const EVM_TX_HASH_PATTERN = /\b0x[a-f0-9]{64}\b/iu;
const SOLANA_TX_HASH_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/u;

export function parseTransactionReference(
  question: string,
): ParsedTransactionReference | undefined {
  const normalized = question.normalize('NFKC').trim();
  const evmHash = EVM_TX_HASH_PATTERN.exec(normalized)?.[0];
  if (evmHash !== undefined) {
    return {
      chain: chainFromText(normalized),
      txHash: evmHash,
    };
  }

  const solanaHash = SOLANA_TX_HASH_PATTERN.exec(normalized)?.[0];
  if (solanaHash !== undefined) {
    return {
      chain: 'solana',
      txHash: solanaHash,
    };
  }

  return undefined;
}

function chainFromText(text: string): TxAnalysisChain {
  const normalized = text.toLowerCase();
  if (/\bbase\b/u.test(normalized)) {
    return 'base';
  }
  if (/\beth(ereum)?\b/u.test(normalized)) {
    return 'ethereum';
  }
  if (/\bbsc\b|\bbnb\b/u.test(normalized)) {
    return 'bsc';
  }
  return 'unknown';
}
```

- [ ] **Step 5: Update classification**

Modify `packages/rag-core/src/classify.ts`:

```ts
import { parseTransactionReference } from './tx-hash.js';
```

Add helpers:

```ts
const txAnalysisRequestPatterns = [
  /\bmev\b/u,
  /\bsandwich\b/u,
  /夹子|被夹|三明治|链上取证|交易哈希/u,
];

function isTxAnalysisRequest(normalizedQuestion: string): boolean {
  return (
    parseTransactionReference(normalizedQuestion) !== undefined &&
    txAnalysisRequestPatterns.some((pattern) => pattern.test(normalizedQuestion))
  );
}
```

After investment-advice detection and before product operation detection, add:

```ts
if (isTxAnalysisRequest(normalized)) {
  return createClassification(
    'tx_sandwich_detection',
    0.9,
    'asks for sandwich detection for a concrete transaction hash',
  );
}
```

- [ ] **Step 6: Run parser/classification tests**

Run:

```bash
pnpm test packages/rag-core/src/tx-hash.test.ts packages/rag-core/src/classify.test.ts
```

Expected: PASS.

## Task 3: Transaction Analysis Service

**Files:**

- Create: `packages/rag-core/src/tx-analysis.ts`
- Modify: `packages/rag-core/src/index.ts`
- Create: `docs/product-features/assets/tx-analysis-fixture.svg`
- Test: `packages/rag-core/src/tx-analysis.test.ts`

- [ ] **Step 1: Write service tests**

Create `packages/rag-core/src/tx-analysis.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  createMockTxAnalysisProvider,
  createTxAnalysisAnswer,
  TxAnalysisProviderUnavailableError,
} from './tx-analysis.js';

describe('tx analysis service', () => {
  it('returns a structured sandwich analysis response with an image attachment', async () => {
    const provider = createMockTxAnalysisProvider();
    const result = await provider.analyze({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });
    const response = createTxAnalysisAnswer(result);

    expect(response.intent).toBe('tx_sandwich_detection');
    expect(response.answer).toContain('这是基于可用链上数据的分析');
    expect(response.attachments?.[0]).toEqual({
      kind: 'image',
      mediaType: 'image/svg+xml',
      title: '交易分析截图',
      url: '/assets/tx-analysis-fixture.svg',
    });
  });

  it('can represent provider unavailability explicitly', async () => {
    const provider = createMockTxAnalysisProvider({ unavailable: true });

    await expect(
      provider.analyze({
        chain: 'base',
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      }),
    ).rejects.toBeInstanceOf(TxAnalysisProviderUnavailableError);
  });
});
```

- [ ] **Step 2: Run failing service tests**

Run:

```bash
pnpm test packages/rag-core/src/tx-analysis.test.ts
```

Expected: FAIL because `tx-analysis.ts` does not exist.

- [ ] **Step 3: Implement transaction analysis service**

Create `packages/rag-core/src/tx-analysis.ts`:

```ts
import type { ChatResponse, TxAnalysisChain, TxAnalysisResult } from '@xxyy/shared';

export interface TxAnalysisProvider {
  supports(input: { chain: TxAnalysisChain; txHash: string }): boolean;
  analyze(input: { chain: TxAnalysisChain; txHash: string }): Promise<TxAnalysisResult>;
}

export class TxAnalysisProviderUnavailableError extends Error {
  constructor() {
    super('Transaction analysis provider is unavailable.');
  }
}

export interface MockTxAnalysisProviderOptions {
  unavailable?: boolean;
}

export function createMockTxAnalysisProvider(
  options: MockTxAnalysisProviderOptions = {},
): TxAnalysisProvider {
  return {
    supports: () => true,
    async analyze(input): Promise<TxAnalysisResult> {
      if (options.unavailable === true) {
        throw new TxAnalysisProviderUnavailableError();
      }

      return {
        analyzedAt: '2026-06-10T00:00:00.000Z',
        chain: input.chain,
        confidence: 0.72,
        evidence: [
          {
            detail: '检测到用户交易前后存在同方向买入和反向卖出模式。',
            label: '交易顺序',
            severity: 'warning',
          },
          {
            detail: '该结果来自 fixture provider，仅用于 MVP 骨架验证。',
            label: '数据来源',
            severity: 'info',
          },
        ],
        relatedTransactions: [
          {
            hash: '0xfront000000000000000000000000000000000000000000000000000000000000',
            role: 'front_run',
            summary: '疑似前置交易',
          },
          {
            hash: input.txHash,
            role: 'user',
            summary: '用户提交的交易',
          },
          {
            hash: '0xback0000000000000000000000000000000000000000000000000000000000000',
            role: 'back_run',
            summary: '疑似后置交易',
          },
        ],
        screenshotUrl: '/assets/tx-analysis-fixture.svg',
        summary: '检测到类似 sandwich 的交易序列，但当前结果来自测试 fixture，不代表真实链上结论。',
        txHash: input.txHash,
        verdict: 'sandwiched',
      };
    },
  };
}

export function createTxAnalysisAnswer(result: TxAnalysisResult): ChatResponse {
  return {
    answer: [
      `交易哈希：${result.txHash}`,
      `判断：${verdictText(result.verdict)}，置信度 ${result.confidence.toFixed(2)}。`,
      `摘要：${result.summary}`,
      '关键证据：',
      ...result.evidence.map((item) => `- ${item.label}：${item.detail}`),
      '这是基于可用链上数据的分析，不构成投资建议。',
    ].join('\n'),
    attachments:
      result.screenshotUrl === undefined
        ? undefined
        : [
            {
              kind: 'image',
              mediaType: 'image/svg+xml',
              title: '交易分析截图',
              url: result.screenshotUrl,
            },
          ],
    citations: [],
    confidence: result.confidence,
    intent: 'tx_sandwich_detection',
  };
}

function verdictText(verdict: TxAnalysisResult['verdict']): string {
  if (verdict === 'sandwiched') {
    return '疑似被夹';
  }
  if (verdict === 'not_sandwiched') {
    return '未发现明显被夹证据';
  }
  return '证据不足，暂无法判断';
}
```

- [ ] **Step 4: Export service**

Update `packages/rag-core/src/index.ts`:

```ts
export {
  createMockTxAnalysisProvider,
  createTxAnalysisAnswer,
  TxAnalysisProviderUnavailableError,
} from './tx-analysis.js';
export type { MockTxAnalysisProviderOptions, TxAnalysisProvider } from './tx-analysis.js';
```

- [ ] **Step 5: Create fixture image**

Create `docs/product-features/assets/tx-analysis-fixture.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-label="交易分析截图">
  <rect width="960" height="540" fill="#f8fafc"/>
  <text x="48" y="64" fill="#17202e" font-family="Arial, sans-serif" font-size="32" font-weight="700">交易分析截图 Fixture</text>
  <rect x="80" y="150" width="220" height="96" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <rect x="380" y="150" width="220" height="96" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <rect x="680" y="150" width="220" height="96" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="120" y="205" fill="#1e3a8a" font-family="Arial, sans-serif" font-size="24">疑似前置交易</text>
  <text x="430" y="205" fill="#92400e" font-family="Arial, sans-serif" font-size="24">用户交易</text>
  <text x="720" y="205" fill="#166534" font-family="Arial, sans-serif" font-size="24">疑似后置交易</text>
  <path d="M300 198 H380" stroke="#64748b" stroke-width="4" marker-end="url(#arrow)"/>
  <path d="M600 198 H680" stroke="#64748b" stroke-width="4" marker-end="url(#arrow)"/>
  <text x="80" y="350" fill="#334155" font-family="Arial, sans-serif" font-size="22">MVP fixture: this image verifies attachment rendering, not real chain analysis.</text>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#64748b"/>
    </marker>
  </defs>
</svg>
```

- [ ] **Step 6: Run tx-analysis tests**

Run:

```bash
pnpm test packages/rag-core/src/tx-analysis.test.ts
```

Expected: PASS.

## Task 4: ChatService Routing

**Files:**

- Modify: `packages/rag-core/src/chat-service.ts`
- Modify: `packages/rag-core/src/chat-service.test.ts`

- [ ] **Step 1: Write ChatService tests**

Add tests to `packages/rag-core/src/chat-service.test.ts`:

```ts
import { createMockTxAnalysisProvider } from './tx-analysis.js';

it('routes concrete transaction sandwich detection to the tx analysis provider', async () => {
  const service = createChatService({
    retriever: { retrieve: () => [] },
    txAnalysisProvider: createMockTxAnalysisProvider(),
  });

  const response = await service.ask({
    channel: 'cli',
    message:
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 这个交易是不是被夹了？',
  });

  expect(response.intent).toBe('tx_sandwich_detection');
  expect(response.answer).toContain('疑似被夹');
  expect(response.attachments?.[0]?.kind).toBe('image');
});

it('returns a clear disabled response when tx analysis has no provider', async () => {
  const service = createChatService({
    retriever: { retrieve: () => [] },
  });

  const response = await service.ask({
    channel: 'cli',
    message:
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 这个交易是不是被夹了？',
  });

  expect(response.intent).toBe('tx_sandwich_detection');
  expect(response.answer).toContain('交易哈希夹子检测功能暂未启用');
});
```

- [ ] **Step 2: Run failing ChatService tests**

Run:

```bash
pnpm test packages/rag-core/src/chat-service.test.ts
```

Expected: FAIL because `txAnalysisProvider` is not supported yet.

- [ ] **Step 3: Add ChatService tx-analysis route**

Modify `packages/rag-core/src/chat-service.ts`:

```ts
import { parseTransactionReference } from './tx-hash.js';
import {
  createTxAnalysisAnswer,
  TxAnalysisProviderUnavailableError,
  type TxAnalysisProvider,
} from './tx-analysis.js';
```

Extend options:

```ts
export interface CreateChatServiceOptions {
  index?: RagIndex;
  retriever?: Retriever;
  answerProvider?: AnswerProvider;
  txAnalysisProvider?: TxAnalysisProvider;
  config?: Partial<RagConfig>;
}
```

Before `shouldRetrieve` checks in both `ask` and `stream`, add:

```ts
if (classification.intent === 'tx_sandwich_detection') {
  return answerTxAnalysis(request.message, options.txAnalysisProvider);
}
```

For stream:

```ts
if (classification.intent === 'tx_sandwich_detection') {
  yield * streamChatResponse(await answerTxAnalysis(request.message, options.txAnalysisProvider));
  return;
}
```

Add helper:

```ts
async function answerTxAnalysis(
  question: string,
  provider: TxAnalysisProvider | undefined,
): Promise<ChatResponse> {
  const parsed = parseTransactionReference(question);
  if (parsed === undefined) {
    return {
      answer: '没有识别到可分析的交易哈希。请发送完整交易哈希或交易链接。',
      citations: [],
      confidence: 0.4,
      intent: 'tx_sandwich_detection',
    };
  }

  if (provider === undefined || !provider.supports(parsed)) {
    return {
      answer: '交易哈希夹子检测功能暂未启用。当前不会编造链上分析结论。',
      citations: [],
      confidence: 0.4,
      intent: 'tx_sandwich_detection',
    };
  }

  try {
    return createTxAnalysisAnswer(await provider.analyze(parsed));
  } catch (error) {
    if (error instanceof TxAnalysisProviderUnavailableError) {
      return {
        answer: '交易哈希分析数据源暂时不可用。请稍后重试；当前不会编造链上分析结论。',
        citations: [],
        confidence: 0.35,
        intent: 'tx_sandwich_detection',
      };
    }
    throw error;
  }
}
```

- [ ] **Step 4: Run ChatService tests**

Run:

```bash
pnpm test packages/rag-core/src/chat-service.test.ts
```

Expected: PASS.

## Task 5: CLI, API, and Web Attachment Support

**Files:**

- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/index.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/index.test.ts`
- Modify: `apps/web/src/index.ts`
- Modify: `apps/web/src/index.test.ts`

- [ ] **Step 1: Add CLI attachment formatting test**

Update `apps/cli/src/index.test.ts` to include an image attachment in `formatChatResponse` coverage:

```ts
expect(
  formatChatResponse({
    answer: '交易分析完成',
    attachments: [
      {
        kind: 'image',
        mediaType: 'image/svg+xml',
        title: '交易分析截图',
        url: '/assets/tx-analysis-fixture.svg',
      },
    ],
    citations: [],
    confidence: 0.8,
    intent: 'tx_sandwich_detection',
  }),
).toContain('/assets/tx-analysis-fixture.svg');
```

- [ ] **Step 2: Add API static content-type test**

Update `apps/api/src/index.test.ts`:

```ts
it('serves image assets for transaction analysis attachments', async () => {
  const response = createMockResponse();
  await createRequestHandler({
    env: {},
    staticAssetsDir: fixtureAssetsDir,
  })(createMockRequest({ method: 'GET', url: '/assets/tx-analysis-fixture.svg' }), response);

  expect(response.statusCode).toBe(200);
  expect(response.headers['Content-Type']).toBe('image/svg+xml');
});
```

Use the existing mock request/response helpers and fixture asset setup already present in `apps/api/src/index.test.ts`; if the file currently only creates an mp4 asset, add an svg fixture file in that test setup.

- [ ] **Step 3: Add Web image rendering test**

Update `apps/web/src/index.test.ts`:

```ts
it('renders image attachments for transaction analysis screenshots', () => {
  const html = renderChatPage();
  expect(html).toContain('attachment.kind === "image"');
  expect(html).toContain('document.createElement("img")');
});
```

- [ ] **Step 4: Run failing app tests**

Run:

```bash
pnpm test apps/cli/src/index.test.ts apps/api/src/index.test.ts apps/web/src/index.test.ts
```

Expected: FAIL until image support is added.

- [ ] **Step 5: Update API content types**

Modify `contentTypeForAsset` in `apps/api/src/index.ts`:

```ts
function contentTypeForAsset(assetName: string): string {
  const normalized = assetName.toLowerCase();
  if (normalized.endsWith('.mp4')) {
    return 'video/mp4';
  }
  if (normalized.endsWith('.png')) {
    return 'image/png';
  }
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (normalized.endsWith('.webp')) {
    return 'image/webp';
  }
  if (normalized.endsWith('.svg')) {
    return 'image/svg+xml';
  }

  return 'application/octet-stream';
}
```

- [ ] **Step 6: Update Web attachment rendering**

Modify `renderAttachments` in `apps/web/src/index.ts`:

```js
if (attachment.kind === 'image') {
  const image = document.createElement('img');
  image.src = attachment.url;
  image.alt = attachment.title;
  image.loading = 'lazy';
  article.append(title, image);
  return article;
}
```

Add CSS near `.attachment video`:

```css
.attachment img {
  width: 100%;
  max-height: 420px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fafc;
  object-fit: contain;
}
```

- [ ] **Step 7: Run app tests**

Run:

```bash
pnpm test apps/cli/src/index.test.ts apps/api/src/index.test.ts apps/web/src/index.test.ts
```

Expected: PASS.

## Task 6: Integration Verification

**Files:**

- Modify: `apps/cli/src/index.test.ts`
- Modify: `apps/api/src/index.test.ts`
- Modify: `docs/feature-status.md`

- [ ] **Step 1: Add CLI integration test with injected service if needed**

If existing CLI tests cannot inject `txAnalysisProvider`, keep CLI coverage limited to formatting and ChatService coverage. Do not add global mock provider to production CLI yet.

- [ ] **Step 2: Add docs note**

Update `docs/feature-status.md` transaction hash line:

```md
- [ ] 交易哈希夹子检测：MVP 骨架计划支持识别交易哈希并返回 fixture 分析结果；真实链上 provider 接入前仍不算完成。
```

- [ ] **Step 3: Run targeted test suite**

Run:

```bash
pnpm test packages/shared/src/chat-contract.test.ts packages/rag-core/src/tx-hash.test.ts packages/rag-core/src/classify.test.ts packages/rag-core/src/tx-analysis.test.ts packages/rag-core/src/chat-service.test.ts apps/cli/src/index.test.ts apps/api/src/index.test.ts apps/web/src/index.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm exec tsc --noEmit -p tsconfig.json
pnpm -r --if-present --filter "@xxyy/*" typecheck
```

Expected: both commands exit 0.

- [ ] **Step 5: Run formatting check**

Run:

```bash
pnpm exec prettier --check "packages/**/*.ts" "apps/**/*.ts" "docs/**/*.md"
```

Expected: all matched files use Prettier style.

## Self-review

- Spec coverage: This plan covers intent routing, shared contract, parser, provider interface, mock provider, image attachment support, API/Web/CLI behavior, fixture screenshot, docs, and tests.
- Known gap: Real chain provider is intentionally excluded from MVP and remains in roadmap.
- Type consistency: `tx_sandwich_detection`, `TxAnalysisProvider`, `TxAnalysisResult`, and `ChatAttachment(kind: 'image')` use the same names across tasks.
