# Autonomous Answering Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first executable slice of the fully automated XXYY answering agent: session-aware follow-ups, explicit answer routing, quality signals, and no user-facing handoff wording.

**Architecture:** Keep `CustomerAgentRuntime` as the orchestration boundary. Add small in-process modules for session context, follow-up resolution, answer planning, and quality signals; then wire them into the existing product and transaction tools without adding new MCP servers in this slice.

**Tech Stack:** TypeScript ESM, Vitest, Zod-backed tool registry, existing `@xxyy/shared`, `@xxyy/rag-core`, and `@xxyy/agent-core`.

---

## File Structure

- Create `packages/agent-core/src/session-context.ts`: sanitized session-turn types, in-memory session store, and session text sanitizer.
- Create `packages/agent-core/src/session-context.test.ts`: store retention and redaction tests.
- Create `packages/agent-core/src/follow-up-resolver.ts`: deterministic resolver for obvious product and transaction follow-ups.
- Create `packages/agent-core/src/follow-up-resolver.test.ts`: product follow-up, transaction follow-up, ambiguous transaction, and unchanged-message tests.
- Create `packages/agent-core/src/answer-planner.ts`: explicit routes for product answer, transaction analysis, clarification, and boundary reply.
- Create `packages/agent-core/src/answer-planner.test.ts`: route-selection tests that lock the automatic-answering policy.
- Create `packages/agent-core/src/quality-signals.ts`: quality signal types and in-memory sink.
- Create `packages/agent-core/src/quality-signals.test.ts`: low-confidence, no-citation, boundary, and failure signal tests.
- Modify `packages/agent-core/src/customer-agent-runtime.ts`: use resolver, planner, session store, and quality sink.
- Modify `packages/agent-core/src/customer-agent-runtime.test.ts`: add integration tests for follow-ups, ambiguous clarification, and quality signals.
- Modify `packages/agent-core/src/customer-agent-chat-service.ts`: pass optional session store and quality sink into the runtime.
- Modify `packages/agent-core/src/customer-agent-chat-service.test.ts`: verify compatibility with default no-store options.
- Modify `packages/agent-core/src/index.ts`: export new modules and types.
- Create `skills/xxyy-autonomous-answering-agent/SKILL.md`: document the customer-facing automatic-answering policy.
- Create `skills/xxyy-autonomous-answering-agent/agents/openai.yaml`: UI metadata for the new skill.

## Task 1: Add Session Context Store

**Files:**

- Create: `packages/agent-core/src/session-context.ts`
- Create: `packages/agent-core/src/session-context.test.ts`
- Modify: `packages/agent-core/src/index.ts`

- [ ] **Step 1: Write failing session-context tests**

Create `packages/agent-core/src/session-context.test.ts`:

```ts
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
      metadata: { confidence: 0.8, citationCount: 1, intent: 'product_qa' },
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
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm test packages/agent-core/src/session-context.test.ts
```

Expected: FAIL because `session-context.ts` does not exist.

- [ ] **Step 3: Implement the session context store**

Create `packages/agent-core/src/session-context.ts`:

```ts
import type { Intent, TxAnalysisChain } from '@xxyy/shared';

export type SessionTurnRole = 'assistant' | 'user';

export interface SessionTurnMetadata {
  chain?: TxAnalysisChain;
  citationCount?: number;
  confidence?: number;
  intent?: Intent;
  txHash?: string;
}

export interface SessionTurn {
  content: string;
  createdAt: string;
  metadata?: SessionTurnMetadata;
  role: SessionTurnRole;
}

export interface SessionContextStore {
  appendTurn(sessionId: string, turn: SessionTurn): Promise<void>;
  getRecentTurns(sessionId: string, limit?: number): Promise<SessionTurn[]>;
}

export interface InMemorySessionContextStoreOptions {
  maxTurnsPerSession?: number;
  now?: () => Date;
}

const DEFAULT_MAX_TURNS_PER_SESSION = 12;

export function createInMemorySessionContextStore(
  options: InMemorySessionContextStoreOptions = {},
): SessionContextStore {
  const maxTurnsPerSession = options.maxTurnsPerSession ?? DEFAULT_MAX_TURNS_PER_SESSION;
  const turnsBySession = new Map<string, SessionTurn[]>();

  return {
    async appendTurn(sessionId, turn) {
      const existingTurns = turnsBySession.get(sessionId) ?? [];
      const storedTurn = {
        ...turn,
        content: sanitizeSessionText(turn.content),
        createdAt: turn.createdAt || (options.now ?? (() => new Date()))().toISOString(),
      };
      const nextTurns = [...existingTurns, storedTurn].slice(-maxTurnsPerSession);
      turnsBySession.set(sessionId, nextTurns);
    },

    async getRecentTurns(sessionId, limit) {
      const turns = turnsBySession.get(sessionId) ?? [];
      return turns.slice(-(limit ?? maxTurnsPerSession));
    },
  };
}

export function sanitizeSessionText(text: string): string {
  return text
    .replace(/\b0x[a-fA-F0-9]{64}\b/gu, '[evm_tx_hash]')
    .replace(/\b0x[a-fA-F0-9]{40}\b/gu, '[evm_address]')
    .replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/gu, '[solana_signature]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, '[phone]')
    .trim();
}
```

- [ ] **Step 4: Export the session context module**

Modify `packages/agent-core/src/index.ts` by adding:

```ts
export { createInMemorySessionContextStore, sanitizeSessionText } from './session-context.js';
export type {
  InMemorySessionContextStoreOptions,
  SessionContextStore,
  SessionTurn,
  SessionTurnMetadata,
  SessionTurnRole,
} from './session-context.js';
```

- [ ] **Step 5: Run the session context test**

Run:

```bash
pnpm test packages/agent-core/src/session-context.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/index.ts packages/agent-core/src/session-context.ts packages/agent-core/src/session-context.test.ts
git commit -m "feat: add agent session context store"
```

## Task 2: Add Follow-Up Resolver

**Files:**

- Create: `packages/agent-core/src/follow-up-resolver.ts`
- Create: `packages/agent-core/src/follow-up-resolver.test.ts`
- Modify: `packages/agent-core/src/index.ts`

- [ ] **Step 1: Write failing follow-up resolver tests**

Create `packages/agent-core/src/follow-up-resolver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { resolveFollowUp } from './follow-up-resolver.js';
import type { SessionTurn } from './session-context.js';

const evmTx = '0x1111111111111111111111111111111111111111111111111111111111111111';
const secondEvmTx = '0x2222222222222222222222222222222222222222222222222222222222222222';

describe('resolveFollowUp', () => {
  it('keeps self-contained product questions unchanged', () => {
    expect(
      resolveFollowUp({
        message: 'XXYY Pro 有哪些权益？',
        recentTurns: [],
      }),
    ).toEqual({
      resolvedMessage: 'XXYY Pro 有哪些权益？',
      resolution: 'unchanged',
    });
  });

  it('resolves short product follow-ups using the most recent product topic', () => {
    const recentTurns: SessionTurn[] = [
      {
        content: 'XXYY Pro 有哪些权益？',
        createdAt: '2026-06-19T00:00:00.000Z',
        metadata: { intent: 'product_qa' },
        role: 'user',
      },
    ];

    expect(
      resolveFollowUp({
        message: '怎么升级？',
        recentTurns,
      }),
    ).toEqual({
      contextSummary: 'resolved product follow-up from previous product turn',
      resolvedMessage: 'XXYY Pro 怎么升级？',
      resolution: 'resolved_followup',
    });
  });

  it('resolves transaction follow-ups when exactly one recent transaction exists', () => {
    const recentTurns: SessionTurn[] = [
      {
        content: '[evm_tx_hash]',
        createdAt: '2026-06-19T00:00:00.000Z',
        metadata: { chain: 'base', intent: 'tx_sandwich_detection', txHash: evmTx },
        role: 'assistant',
      },
    ];

    expect(
      resolveFollowUp({
        message: '这笔被夹了吗？',
        recentTurns,
      }),
    ).toEqual({
      contextSummary: 'resolved transaction follow-up from one recent transaction',
      resolvedMessage: `${evmTx} 这笔被夹了吗？`,
      resolution: 'resolved_followup',
    });
  });

  it('asks for clarification when a transaction follow-up has multiple possible references', () => {
    const recentTurns: SessionTurn[] = [
      {
        content: '[evm_tx_hash]',
        createdAt: '2026-06-19T00:00:00.000Z',
        metadata: { chain: 'base', intent: 'tx_sandwich_detection', txHash: evmTx },
        role: 'assistant',
      },
      {
        content: '[evm_tx_hash]',
        createdAt: '2026-06-19T00:01:00.000Z',
        metadata: { chain: 'ethereum', intent: 'tx_sandwich_detection', txHash: secondEvmTx },
        role: 'assistant',
      },
    ];

    expect(
      resolveFollowUp({
        message: '这笔呢？',
        recentTurns,
      }),
    ).toEqual({
      clarificationQuestion: '你想分析哪一笔交易？请发送单笔完整交易哈希或对应主网浏览器链接。',
      resolution: 'needs_clarification',
    });
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm test packages/agent-core/src/follow-up-resolver.test.ts
```

Expected: FAIL because `follow-up-resolver.ts` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `packages/agent-core/src/follow-up-resolver.ts`:

```ts
import { hasAmbiguousTransactionReferences, parseTransactionReference } from '@xxyy/rag-core';

import type { SessionTurn } from './session-context.js';

export type FollowUpResolution = 'needs_clarification' | 'resolved_followup' | 'unchanged';

export interface ResolveFollowUpInput {
  message: string;
  recentTurns: SessionTurn[];
}

export type ResolveFollowUpOutput =
  | {
      contextSummary?: string;
      resolvedMessage: string;
      resolution: Exclude<FollowUpResolution, 'needs_clarification'>;
    }
  | {
      clarificationQuestion: string;
      resolution: 'needs_clarification';
    };

export function resolveFollowUp(input: ResolveFollowUpInput): ResolveFollowUpOutput {
  const message = input.message.trim();
  if (message.length === 0) {
    return { resolvedMessage: input.message, resolution: 'unchanged' };
  }

  if (
    parseTransactionReference(message) !== undefined ||
    hasAmbiguousTransactionReferences(message)
  ) {
    return { resolvedMessage: input.message, resolution: 'unchanged' };
  }

  if (isTransactionFollowUp(message)) {
    const transactionHashes = uniqueRecentTransactionHashes(input.recentTurns);
    if (transactionHashes.length === 1) {
      return {
        contextSummary: 'resolved transaction follow-up from one recent transaction',
        resolvedMessage: `${transactionHashes[0]} ${message}`,
        resolution: 'resolved_followup',
      };
    }
    if (transactionHashes.length > 1) {
      return {
        clarificationQuestion: '你想分析哪一笔交易？请发送单笔完整交易哈希或对应主网浏览器链接。',
        resolution: 'needs_clarification',
      };
    }
  }

  if (isShortProductFollowUp(message)) {
    const topic = inferRecentProductTopic(input.recentTurns);
    if (topic !== undefined) {
      return {
        contextSummary: 'resolved product follow-up from previous product turn',
        resolvedMessage: `${topic} ${message}`,
        resolution: 'resolved_followup',
      };
    }
  }

  return { resolvedMessage: input.message, resolution: 'unchanged' };
}

function uniqueRecentTransactionHashes(turns: SessionTurn[]): string[] {
  const hashes: string[] = [];
  for (const turn of turns) {
    const txHash = turn.metadata?.txHash;
    if (
      txHash !== undefined &&
      !hashes.some((hash) => hash.toLowerCase() === txHash.toLowerCase())
    ) {
      hashes.push(txHash);
    }
  }
  return hashes;
}

function isTransactionFollowUp(message: string): boolean {
  return /^(这笔|那笔|刚才那笔|上一笔)|被夹|夹子|sandwich|transaction|tx/iu.test(message);
}

function isShortProductFollowUp(message: string): boolean {
  const normalized = message.normalize('NFKC').trim();
  if (normalized.length > 24) {
    return false;
  }
  return /^(那|这个|刚才|上一条)?(怎么|如何|有哪些|可以|支持|升级|配置|设置|开通)/u.test(
    normalized,
  );
}

function inferRecentProductTopic(turns: SessionTurn[]): string | undefined {
  for (const turn of [...turns].reverse()) {
    if (turn.metadata?.intent !== 'product_qa' && turn.metadata?.intent !== 'how_to') {
      continue;
    }
    const content = turn.content;
    if (/XXYY\s*Pro|Pro/u.test(content)) {
      return 'XXYY Pro';
    }
    if (/Telegram|TG|钱包监控/u.test(content)) {
      return 'Telegram 钱包监控';
    }
    if (/自动交易|Raydium自动卖|开盘狙击/u.test(content)) {
      return 'XXYY 自动交易';
    }
    if (/移动端|手机|登录/u.test(content)) {
      return 'XXYY 移动端登录';
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Export the resolver**

Modify `packages/agent-core/src/index.ts` by adding:

```ts
export { resolveFollowUp } from './follow-up-resolver.js';
export type {
  FollowUpResolution,
  ResolveFollowUpInput,
  ResolveFollowUpOutput,
} from './follow-up-resolver.js';
```

- [ ] **Step 5: Run the resolver tests**

Run:

```bash
pnpm test packages/agent-core/src/follow-up-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/index.ts packages/agent-core/src/follow-up-resolver.ts packages/agent-core/src/follow-up-resolver.test.ts
git commit -m "feat: resolve agent follow-up questions"
```

## Task 3: Add Quality Signal Sink

**Files:**

- Create: `packages/agent-core/src/quality-signals.ts`
- Create: `packages/agent-core/src/quality-signals.test.ts`
- Modify: `packages/agent-core/src/index.ts`

- [ ] **Step 1: Write failing quality signal tests**

Create `packages/agent-core/src/quality-signals.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createInMemoryQualitySignalSink, createNoopQualitySignalSink } from './quality-signals.js';

describe('quality signals', () => {
  it('records structured quality signals without requiring user identity', () => {
    const sink = createInMemoryQualitySignalSink();

    sink.record({
      channel: 'web',
      citationCount: 0,
      confidence: 0.2,
      intent: 'product_qa',
      reason: 'missing_citations',
      redactedQuestion: 'XXYY Pro price?',
      sessionIdPresent: true,
      userIdPresent: false,
    });

    expect(sink.signals()).toEqual([
      {
        channel: 'web',
        citationCount: 0,
        confidence: 0.2,
        intent: 'product_qa',
        reason: 'missing_citations',
        redactedQuestion: 'XXYY Pro price?',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('provides a noop sink for default runtime use', () => {
    const sink = createNoopQualitySignalSink();
    sink.record({
      channel: 'cli',
      intent: 'unknown',
      reason: 'unknown_intent',
      redactedQuestion: '???',
      sessionIdPresent: false,
      userIdPresent: false,
    });

    expect('signals' in sink).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm test packages/agent-core/src/quality-signals.test.ts
```

Expected: FAIL because `quality-signals.ts` does not exist.

- [ ] **Step 3: Implement quality signal sinks**

Create `packages/agent-core/src/quality-signals.ts`:

```ts
import type { ChatChannel, Intent } from '@xxyy/shared';

export type QualitySignalReason =
  | 'boundary_investment_advice'
  | 'boundary_private_data'
  | 'low_confidence'
  | 'missing_citations'
  | 'session_unavailable'
  | 'tool_failure'
  | 'tx_analysis_failure'
  | 'unknown_intent';

export interface QualitySignal {
  channel: ChatChannel;
  citationCount?: number;
  confidence?: number;
  errorCode?: string;
  intent: Intent;
  reason: QualitySignalReason;
  redactedQuestion: string;
  sessionIdPresent: boolean;
  userIdPresent: boolean;
}

export interface QualitySignalSink {
  record(signal: QualitySignal): void;
}

export interface InMemoryQualitySignalSink extends QualitySignalSink {
  signals(): QualitySignal[];
}

export function createNoopQualitySignalSink(): QualitySignalSink {
  return {
    record: () => undefined,
  };
}

export function createInMemoryQualitySignalSink(): InMemoryQualitySignalSink {
  const recordedSignals: QualitySignal[] = [];
  return {
    record(signal) {
      recordedSignals.push(signal);
    },
    signals() {
      return [...recordedSignals];
    },
  };
}
```

- [ ] **Step 4: Export quality signal types**

Modify `packages/agent-core/src/index.ts` by adding:

```ts
export { createInMemoryQualitySignalSink, createNoopQualitySignalSink } from './quality-signals.js';
export type {
  InMemoryQualitySignalSink,
  QualitySignal,
  QualitySignalReason,
  QualitySignalSink,
} from './quality-signals.js';
```

- [ ] **Step 5: Run quality signal tests**

Run:

```bash
pnpm test packages/agent-core/src/quality-signals.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/index.ts packages/agent-core/src/quality-signals.ts packages/agent-core/src/quality-signals.test.ts
git commit -m "feat: add agent quality signals"
```

## Task 4: Add Explicit Answer Planner

**Files:**

- Create: `packages/agent-core/src/answer-planner.ts`
- Create: `packages/agent-core/src/answer-planner.test.ts`
- Modify: `packages/agent-core/src/index.ts`

- [ ] **Step 1: Write failing planner tests**

Create `packages/agent-core/src/answer-planner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { planAnswer } from './answer-planner.js';

describe('planAnswer', () => {
  it('routes product questions to product_answer', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.78,
          intent: 'product_qa',
          reason: 'asks about product',
        },
        resolvedMessage: 'XXYY Pro 有哪些权益？',
      }),
    ).toEqual({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'asks about product',
      },
      messageForTool: 'XXYY Pro 有哪些权益？',
      route: 'product_answer',
    });
  });

  it('routes transaction questions to transaction_analysis', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.9,
          intent: 'tx_sandwich_detection',
          reason: 'hash',
        },
        resolvedMessage: '0x1111111111111111111111111111111111111111111111111111111111111111',
      }),
    ).toMatchObject({
      messageForTool: '0x1111111111111111111111111111111111111111111111111111111111111111',
      route: 'transaction_analysis',
    });
  });

  it('routes unknown intent to clarification', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.25,
          intent: 'unknown',
          reason: 'no deterministic product support intent matched',
        },
        resolvedMessage: '帮我看看这个',
      }),
    ).toEqual({
      clarificationQuestion:
        '我还不确定你想咨询 XXYY 的哪个功能。请补充具体功能、配置步骤、Pro 权益，或发送单笔交易哈希。',
      classification: {
        confidence: 0.25,
        intent: 'unknown',
        reason: 'no deterministic product support intent matched',
      },
      route: 'clarify',
    });
  });

  it('routes private account queries to boundary', () => {
    expect(
      planAnswer({
        classification: {
          confidence: 0.86,
          intent: 'realtime_account_query',
          reason: 'private data',
        },
        resolvedMessage: '帮我查钱包余额',
      }),
    ).toMatchObject({
      route: 'boundary',
    });
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm test packages/agent-core/src/answer-planner.test.ts
```

Expected: FAIL because `answer-planner.ts` does not exist.

- [ ] **Step 3: Implement the planner**

Create `packages/agent-core/src/answer-planner.ts`:

```ts
import type { Classification } from '@xxyy/shared';

export type AnswerPlanRoute = 'boundary' | 'clarify' | 'product_answer' | 'transaction_analysis';

export interface PlanAnswerInput {
  classification: Classification;
  resolvedMessage: string;
}

export type AnswerPlan =
  | {
      classification: Classification;
      messageForTool: string;
      route: 'product_answer' | 'transaction_analysis';
    }
  | {
      classification: Classification;
      route: 'boundary';
    }
  | {
      clarificationQuestion: string;
      classification: Classification;
      route: 'clarify';
    };

export function planAnswer(input: PlanAnswerInput): AnswerPlan {
  if (input.classification.intent === 'product_qa' || input.classification.intent === 'how_to') {
    return {
      classification: input.classification,
      messageForTool: input.resolvedMessage,
      route: 'product_answer',
    };
  }

  if (input.classification.intent === 'tx_sandwich_detection') {
    return {
      classification: input.classification,
      messageForTool: input.resolvedMessage,
      route: 'transaction_analysis',
    };
  }

  if (input.classification.intent === 'unknown') {
    return {
      clarificationQuestion:
        '我还不确定你想咨询 XXYY 的哪个功能。请补充具体功能、配置步骤、Pro 权益，或发送单笔交易哈希。',
      classification: input.classification,
      route: 'clarify',
    };
  }

  return {
    classification: input.classification,
    route: 'boundary',
  };
}
```

- [ ] **Step 4: Export the planner**

Modify `packages/agent-core/src/index.ts` by adding:

```ts
export { planAnswer } from './answer-planner.js';
export type { AnswerPlan, AnswerPlanRoute, PlanAnswerInput } from './answer-planner.js';
```

- [ ] **Step 5: Run planner tests**

Run:

```bash
pnpm test packages/agent-core/src/answer-planner.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/index.ts packages/agent-core/src/answer-planner.ts packages/agent-core/src/answer-planner.test.ts
git commit -m "feat: add explicit answer planner"
```

## Task 5: Wire Session, Planner, and Quality Signals Into Runtime

**Files:**

- Modify: `packages/agent-core/src/customer-agent-runtime.ts`
- Modify: `packages/agent-core/src/customer-agent-runtime.test.ts`

- [ ] **Step 1: Add failing runtime integration tests**

Append these tests inside the existing `describe('createCustomerAgentRuntime', () => { ... })` block in `packages/agent-core/src/customer-agent-runtime.test.ts`:

```ts
it('uses session context to resolve product follow-up questions', async () => {
  const registry = createToolRegistry();
  const sessionContext = createInMemorySessionContextStore();
  const response: ChatResponse = {
    answer: '可以在 Pro 权益页升级。',
    citations: [
      {
        excerpt: '如何升级为 Pro。',
        file: 'docs/product-features/pro-upgrade.md',
        title: '如何升级为 Pro',
      },
    ],
    confidence: 0.8,
    intent: 'how_to',
  };
  const execute = vi.fn(() => Promise.resolve(response));

  registry.register({
    name: 'answer_product_question',
    description: 'Answer a product question.',
    inputSchema: z.object({
      channel: z.enum(['cli', 'web', 'telegram']).optional(),
      question: z.string(),
    }),
    outputSchema: z.custom<ChatResponse>(() => true),
    policy: toolPolicy,
    execute,
  });

  const runtime = createCustomerAgentRuntime({ registry, sessionContext });
  await runtime.ask({
    channel: 'web',
    message: 'XXYY Pro 有哪些权益？',
    sessionId: 'session-product',
  });
  await runtime.ask({
    channel: 'web',
    message: '怎么升级？',
    sessionId: 'session-product',
  });

  expect(execute).toHaveBeenLastCalledWith({
    channel: 'web',
    question: 'XXYY Pro 怎么升级？',
  });
});

it('uses session context to resolve one recent transaction follow-up', async () => {
  const registry = createToolRegistry();
  const sessionContext = createInMemorySessionContextStore();
  const txHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const output: AnalyzeTransactionOutput = {
    result: {
      analyzedAt: '2026-06-19T00:00:00.000Z',
      chain: 'base',
      confidence: 0.7,
      dataSource: 'fixture',
      evidence: [],
      relatedTransactions: [{ hash: txHash, role: 'user', summary: '目标交易' }],
      summary: '未发现典型夹子模式。',
      txHash,
      verdict: 'not_sandwiched',
    },
    status: 'success',
  };
  const execute = vi.fn(() => Promise.resolve(output));

  registry.register({
    name: 'analyze_transaction',
    description: 'Analyze transaction.',
    inputSchema: z.object({ txHash: z.string() }),
    outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
    policy: toolPolicy,
    execute,
  });

  const runtime = createCustomerAgentRuntime({ registry, sessionContext });
  await runtime.ask({ channel: 'web', message: txHash, sessionId: 'session-tx' });
  await runtime.ask({ channel: 'web', message: '这笔被夹了吗？', sessionId: 'session-tx' });

  expect(execute).toHaveBeenLastCalledWith({ txHash: `${txHash} 这笔被夹了吗？` });
});

it('asks for clarification when a transaction follow-up has multiple recent hashes', async () => {
  const registry = createToolRegistry();
  const sessionContext = createInMemorySessionContextStore();
  const firstTx = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const secondTx = '0x2222222222222222222222222222222222222222222222222222222222222222';
  const execute = vi.fn((input: { txHash: string }) =>
    Promise.resolve({
      result: {
        analyzedAt: '2026-06-19T00:00:00.000Z',
        chain: 'base',
        confidence: 0.7,
        dataSource: 'fixture',
        evidence: [],
        relatedTransactions: [{ hash: input.txHash, role: 'user', summary: '目标交易' }],
        summary: '测试样本。',
        txHash: input.txHash,
        verdict: 'inconclusive',
      },
      status: 'success',
    } satisfies AnalyzeTransactionOutput),
  );

  registry.register({
    name: 'analyze_transaction',
    description: 'Analyze transaction.',
    inputSchema: z.object({ txHash: z.string() }),
    outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
    policy: toolPolicy,
    execute,
  });

  const runtime = createCustomerAgentRuntime({ registry, sessionContext });
  await runtime.ask({ channel: 'web', message: firstTx, sessionId: 'session-many-tx' });
  await runtime.ask({ channel: 'web', message: secondTx, sessionId: 'session-many-tx' });
  const response = await runtime.ask({
    channel: 'web',
    message: '这笔呢？',
    sessionId: 'session-many-tx',
  });

  expect(response).toMatchObject({
    citations: [],
    confidence: 0.55,
    intent: 'tx_sandwich_detection',
  });
  expect(response.answer).toContain('请发送单笔完整交易哈希');
  expect(execute).toHaveBeenCalledTimes(2);
});

it('records quality signals for low-confidence no-citation product answers', async () => {
  const registry = createToolRegistry();
  const qualitySignals = createInMemoryQualitySignalSink();
  const response: ChatResponse = {
    answer: '当前知识库没有足够信息。',
    citations: [],
    confidence: 0.2,
    intent: 'product_qa',
  };

  registry.register({
    name: 'answer_product_question',
    description: 'Answer a product question.',
    inputSchema: z.object({
      channel: z.enum(['cli', 'web', 'telegram']).optional(),
      question: z.string(),
    }),
    outputSchema: z.custom<ChatResponse>(() => true),
    policy: toolPolicy,
    execute: () => Promise.resolve(response),
  });

  await createCustomerAgentRuntime({
    qualityConfidenceThreshold: 0.5,
    qualitySignals,
    registry,
  }).ask({
    channel: 'web',
    message: 'XXYY Pro 价格是多少？',
    sessionId: 'session-quality',
  });

  expect(qualitySignals.signals()).toEqual([
    {
      channel: 'web',
      citationCount: 0,
      confidence: 0.2,
      intent: 'product_qa',
      reason: 'low_confidence',
      redactedQuestion: 'XXYY Pro 价格是多少？',
      sessionIdPresent: true,
      userIdPresent: false,
    },
    {
      channel: 'web',
      citationCount: 0,
      confidence: 0.2,
      intent: 'product_qa',
      reason: 'missing_citations',
      redactedQuestion: 'XXYY Pro 价格是多少？',
      sessionIdPresent: true,
      userIdPresent: false,
    },
  ]);
});
```

Add imports at the top of `packages/agent-core/src/customer-agent-runtime.test.ts`:

```ts
import { createInMemoryQualitySignalSink } from './quality-signals.js';
import { createInMemorySessionContextStore } from './session-context.js';
```

- [ ] **Step 2: Run runtime tests to verify they fail**

Run:

```bash
pnpm test packages/agent-core/src/customer-agent-runtime.test.ts
```

Expected: FAIL because `CreateCustomerAgentRuntimeOptions` does not accept `sessionContext`, `qualitySignals`, or `qualityConfidenceThreshold`.

- [ ] **Step 3: Update runtime options and imports**

Modify imports in `packages/agent-core/src/customer-agent-runtime.ts`:

```ts
import { planAnswer } from './answer-planner.js';
import { resolveFollowUp } from './follow-up-resolver.js';
import {
  createNoopQualitySignalSink,
  type QualitySignalReason,
  type QualitySignalSink,
} from './quality-signals.js';
import {
  sanitizeSessionText,
  type SessionContextStore,
  type SessionTurnMetadata,
} from './session-context.js';
```

Modify `CreateCustomerAgentRuntimeOptions`:

```ts
export interface CreateCustomerAgentRuntimeOptions {
  registry: ToolRegistry;
  audit?: ToolAuditSink;
  qualityConfidenceThreshold?: number;
  qualitySignals?: QualitySignalSink;
  sessionContext?: SessionContextStore;
}
```

Inside `createCustomerAgentRuntime`, after `const audit = ...`, add:

```ts
const qualitySignals = options.qualitySignals ?? createNoopQualitySignalSink();
const qualityConfidenceThreshold = options.qualityConfidenceThreshold ?? 0.45;
```

- [ ] **Step 4: Replace the `ask` body with resolver and planner flow**

In `packages/agent-core/src/customer-agent-runtime.ts`, replace the current `const ask = ...` body with this implementation:

```ts
const ask: CustomerAgentRuntime['ask'] = async (request) => {
  const recentTurns =
    request.sessionId === undefined || options.sessionContext === undefined
      ? []
      : await options.sessionContext.getRecentTurns(request.sessionId);
  const followUp = resolveFollowUp({ message: request.message, recentTurns });

  if (followUp.resolution === 'needs_clarification') {
    const response: ChatResponse = {
      answer: followUp.clarificationQuestion,
      citations: [],
      confidence: 0.55,
      intent: 'tx_sandwich_detection',
    };
    await appendSessionTurns(options.sessionContext, request, response, {
      userContent: request.message,
    });
    return response;
  }

  const classification = classifyQuestion(followUp.resolvedMessage);
  const plan = planAnswer({
    classification,
    resolvedMessage: followUp.resolvedMessage,
  });

  if (plan.route === 'clarify') {
    const response: ChatResponse = {
      answer: plan.clarificationQuestion,
      citations: [],
      confidence: 0.45,
      intent: plan.classification.intent,
    };
    recordQualitySignal(qualitySignals, request, {
      confidence: response.confidence,
      intent: response.intent,
      reason: 'unknown_intent',
      redactedQuestion: followUp.resolvedMessage,
    });
    await appendSessionTurns(options.sessionContext, request, response, {
      userContent: followUp.resolvedMessage,
    });
    return response;
  }

  if (plan.route === 'boundary') {
    const response = createBoundaryAnswer(plan.classification);
    recordBoundaryQualitySignal(qualitySignals, request, response, followUp.resolvedMessage);
    await appendSessionTurns(options.sessionContext, request, response, {
      userContent: followUp.resolvedMessage,
    });
    return response;
  }

  if (plan.route === 'transaction_analysis') {
    const response = await answerTransaction(
      request,
      plan.messageForTool,
      plan.classification.intent,
    );
    await appendSessionTurns(options.sessionContext, request, response, {
      userContent: followUp.resolvedMessage,
    });
    return response;
  }

  const response = await answerProduct(request, plan.messageForTool, plan.classification.intent);
  await appendSessionTurns(options.sessionContext, request, response, {
    userContent: followUp.resolvedMessage,
  });
  return response;
};
```

- [ ] **Step 5: Add nested runtime helper functions**

Inside `createCustomerAgentRuntime`, add these nested helper functions before `const ask` so they can close over `options.registry`, `audit`, `qualitySignals`, and `qualityConfidenceThreshold`:

```ts
async function answerTransaction(
  request: ChatRequest,
  messageForTool: string,
  intent: ChatResponse['intent'],
): Promise<ChatResponse> {
  const startedAt = Date.now();
  let output: AnalyzeTransactionOutput;
  try {
    output = (await options.registry.execute('analyze_transaction', {
      txHash: messageForTool,
    })) as AnalyzeTransactionOutput;
  } catch (error) {
    recordToolFailure(audit, request, {
      error,
      intent,
      startedAt,
      toolName: 'analyze_transaction',
    });
    recordQualitySignal(qualitySignals, request, {
      errorCode: errorCodeFrom(error),
      intent,
      reason: 'tool_failure',
      redactedQuestion: messageForTool,
    });
    throw error;
  }

  const response =
    output.status === 'success'
      ? createTxAnalysisAnswer(output.result)
      : createTxAnalysisUnavailableAnswer(output.failure.reason, {
          ...(output.failure.metadata === undefined ? {} : { metadata: output.failure.metadata }),
          ...(output.failure.reportUrl === undefined
            ? {}
            : { reportUrl: output.failure.reportUrl }),
        });

  if (output.status === 'failure') {
    recordQualitySignal(qualitySignals, request, {
      confidence: response.confidence,
      intent,
      reason: 'tx_analysis_failure',
      redactedQuestion: messageForTool,
    });
  }

  audit.record({
    channel: request.channel,
    intent,
    latencyMs: Date.now() - startedAt,
    sessionIdPresent: request.sessionId !== undefined,
    status: 'success',
    toolName: 'analyze_transaction',
    userIdPresent: request.userId !== undefined,
  });

  return response;
}

async function answerProduct(
  request: ChatRequest,
  messageForTool: string,
  intent: ChatResponse['intent'],
): Promise<ChatResponse> {
  const startedAt = Date.now();
  let response: ChatResponse;
  try {
    response = (await options.registry.execute('answer_product_question', {
      channel: request.channel,
      question: messageForTool,
    })) as ChatResponse;
  } catch (error) {
    recordToolFailure(audit, request, {
      error,
      intent,
      startedAt,
      toolName: 'answer_product_question',
    });
    recordQualitySignal(qualitySignals, request, {
      errorCode: errorCodeFrom(error),
      intent,
      reason: 'tool_failure',
      redactedQuestion: messageForTool,
    });
    throw error;
  }

  audit.record({
    channel: request.channel,
    citationCount: response.citations.length,
    intent,
    latencyMs: Date.now() - startedAt,
    sessionIdPresent: request.sessionId !== undefined,
    status: 'success',
    toolName: 'answer_product_question',
    userIdPresent: request.userId !== undefined,
  });

  if (response.confidence < qualityConfidenceThreshold) {
    recordQualitySignal(qualitySignals, request, {
      citationCount: response.citations.length,
      confidence: response.confidence,
      intent: response.intent,
      reason: 'low_confidence',
      redactedQuestion: messageForTool,
    });
  }
  if (response.citations.length === 0) {
    recordQualitySignal(qualitySignals, request, {
      citationCount: 0,
      confidence: response.confidence,
      intent: response.intent,
      reason: 'missing_citations',
      redactedQuestion: messageForTool,
    });
  }

  return response;
}
```

Add these file-scope helpers below `recordToolFailure`:

```ts
function recordBoundaryQualitySignal(
  qualitySignals: QualitySignalSink,
  request: ChatRequest,
  response: ChatResponse,
  redactedQuestion: string,
): void {
  const reason: QualitySignalReason =
    response.intent === 'investment_advice'
      ? 'boundary_investment_advice'
      : response.intent === 'realtime_account_query'
        ? 'boundary_private_data'
        : 'unknown_intent';
  recordQualitySignal(qualitySignals, request, {
    confidence: response.confidence,
    intent: response.intent,
    reason,
    redactedQuestion,
  });
}

function recordQualitySignal(
  qualitySignals: QualitySignalSink,
  request: ChatRequest,
  signal: {
    citationCount?: number;
    confidence?: number;
    errorCode?: string;
    intent: ChatResponse['intent'];
    reason: QualitySignalReason;
    redactedQuestion: string;
  },
): void {
  qualitySignals.record({
    channel: request.channel,
    ...(signal.citationCount === undefined ? {} : { citationCount: signal.citationCount }),
    ...(signal.confidence === undefined ? {} : { confidence: signal.confidence }),
    ...(signal.errorCode === undefined ? {} : { errorCode: signal.errorCode }),
    intent: signal.intent,
    reason: signal.reason,
    redactedQuestion: sanitizeSessionText(signal.redactedQuestion),
    sessionIdPresent: request.sessionId !== undefined,
    userIdPresent: request.userId !== undefined,
  });
}

async function appendSessionTurns(
  sessionContext: SessionContextStore | undefined,
  request: ChatRequest,
  response: ChatResponse,
  options: { userContent: string },
): Promise<void> {
  if (sessionContext === undefined || request.sessionId === undefined) {
    return;
  }
  const now = new Date().toISOString();
  await sessionContext.appendTurn(request.sessionId, {
    content: options.userContent,
    createdAt: now,
    metadata: { intent: response.intent },
    role: 'user',
  });
  await sessionContext.appendTurn(request.sessionId, {
    content: response.answer,
    createdAt: now,
    metadata: metadataFromResponse(response),
    role: 'assistant',
  });
}

function metadataFromResponse(response: ChatResponse): SessionTurnMetadata {
  const relatedUserTransaction =
    response.intent === 'tx_sandwich_detection'
      ? extractUserTransactionFromAnswer(response)
      : undefined;
  return {
    citationCount: response.citations.length,
    confidence: response.confidence,
    intent: response.intent,
    ...(relatedUserTransaction === undefined ? {} : relatedUserTransaction),
  };
}

function extractUserTransactionFromAnswer(
  response: ChatResponse,
): Pick<SessionTurnMetadata, 'chain' | 'txHash'> | undefined {
  const hashMatch = response.answer.match(/\b0x[a-fA-F0-9]{64}\b/u);
  if (hashMatch === null) {
    return undefined;
  }
  return { txHash: hashMatch[0] };
}
```

After adding these helpers, remove the old `shouldUseProductTool` function if it is unused.

- [ ] **Step 6: Run runtime tests**

Run:

```bash
pnpm test packages/agent-core/src/customer-agent-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-core/src/customer-agent-runtime.ts packages/agent-core/src/customer-agent-runtime.test.ts
git commit -m "feat: make customer runtime session aware"
```

## Task 6: Wire Optional Runtime Dependencies Through Chat Service

**Files:**

- Modify: `packages/agent-core/src/customer-agent-chat-service.ts`
- Modify: `packages/agent-core/src/customer-agent-chat-service.test.ts`

- [ ] **Step 1: Write failing chat-service wiring test**

Append this test to `packages/agent-core/src/customer-agent-chat-service.test.ts`:

```ts
it('passes optional session context through the customer agent runtime', async () => {
  const retrieveCalls: string[] = [];
  const retriever: Retriever = {
    retrieve(question) {
      retrieveCalls.push(question);
      return [createRetrievedChunk()];
    },
  };
  const answerProvider: AnswerProvider = {
    answer(input) {
      return Promise.resolve({
        answer: `answered ${input.question}`,
        citations: [],
        confidence: 0.9,
        intent: input.classification.intent,
      });
    },
  };
  const sessionContext = createInMemorySessionContextStore();
  const service = createCustomerAgentChatService({
    answerProvider,
    retriever,
    sessionContext,
    txAnalysisProvider: undefined,
  });

  await service.ask({ channel: 'web', message: 'XXYY Pro 有哪些权益？', sessionId: 's1' });
  await service.ask({ channel: 'web', message: '怎么升级？', sessionId: 's1' });

  expect(retrieveCalls.at(-1)).toBe('XXYY Pro 怎么升级？');
});
```

Add import:

```ts
import { createInMemorySessionContextStore } from './session-context.js';
```

- [ ] **Step 2: Run chat-service tests to verify failure**

Run:

```bash
pnpm test packages/agent-core/src/customer-agent-chat-service.test.ts
```

Expected: FAIL because `CreateCustomerAgentChatServiceOptions` does not accept `sessionContext`.

- [ ] **Step 3: Add optional session and quality dependencies to chat service**

Modify imports in `packages/agent-core/src/customer-agent-chat-service.ts`:

```ts
import type { QualitySignalSink } from './quality-signals.js';
import type { SessionContextStore } from './session-context.js';
```

Modify `CreateCustomerAgentChatServiceOptions`:

```ts
export interface CreateCustomerAgentChatServiceOptions {
  answerProvider: AnswerProvider;
  audit?: ToolAuditSink;
  config?: Partial<RagConfig>;
  index?: RagIndex;
  qualityConfidenceThreshold?: number;
  qualitySignals?: QualitySignalSink;
  retriever?: Retriever;
  sessionContext?: SessionContextStore;
  txAnalysisProvider: TxAnalysisProvider | undefined;
  txAnalysisReportReader?: TxAnalysisReportReader;
}
```

Modify the `createCustomerAgentRuntime` call:

```ts
return createCustomerAgentRuntime({
  registry,
  ...(options.audit === undefined ? {} : { audit: options.audit }),
  ...(options.qualityConfidenceThreshold === undefined
    ? {}
    : { qualityConfidenceThreshold: options.qualityConfidenceThreshold }),
  ...(options.qualitySignals === undefined ? {} : { qualitySignals: options.qualitySignals }),
  ...(options.sessionContext === undefined ? {} : { sessionContext: options.sessionContext }),
});
```

- [ ] **Step 4: Run chat-service tests**

Run:

```bash
pnpm test packages/agent-core/src/customer-agent-chat-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/customer-agent-chat-service.ts packages/agent-core/src/customer-agent-chat-service.test.ts
git commit -m "feat: pass agent session dependencies through chat service"
```

## Task 7: Add Autonomous Answering Skill

**Files:**

- Create: `skills/xxyy-autonomous-answering-agent/SKILL.md`
- Create: `skills/xxyy-autonomous-answering-agent/agents/openai.yaml`

- [ ] **Step 1: Create the skill document**

Create `skills/xxyy-autonomous-answering-agent/SKILL.md`:

```markdown
---
name: xxyy-autonomous-answering-agent
description: Use when routing XXYY customer messages through the fully automated answering agent. Applies to product support, public transaction analysis, clarification, boundary replies, session follow-ups, and answer quality signals. Do not use for business-action execution, private account/order/balance lookup, investment advice, user-facing tickets, or human handoff.
---

# XXYY Autonomous Answering Agent

## Overview

Use the autonomous answering agent as the customer-facing route planner for XXYY support. It answers from product knowledge, analyzes one public transaction reference, asks a clarifying question, or returns a boundary reply. It does not hand off to human support and does not execute business actions.

## Route Policy

| User need                                                   | Route                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Product feature, setup, Pro benefits, public update         | `answer_product_question`                                          |
| One supported public transaction hash or explorer link      | `analyze_transaction`                                              |
| Short follow-up with clear prior context                    | Resolve through session context, then route                        |
| Ambiguous follow-up or multiple possible transactions       | Ask one clarifying question                                        |
| Wallet balance, account, order, private transaction history | Boundary reply                                                     |
| Buy/sell, profit promise, investment recommendation         | Boundary reply                                                     |
| Low confidence or missing citations                         | Say the knowledge base is insufficient and record a quality signal |

## Safety Rules

- Never promise user-facing human handoff or ticket creation.
- Never ask users to paste secrets, private keys, seed phrases, order identifiers, or sensitive account data.
- Never infer a transaction when multiple hashes or conflicting chains are present.
- Never publish feedback-derived or Telegram-derived content directly into production RAG.
- Record quality signals for low-confidence answers, missing citations, unknown intent, boundary requests, transaction failures, and tool failures.
```

- [ ] **Step 2: Create OpenAI agent metadata**

Create `skills/xxyy-autonomous-answering-agent/agents/openai.yaml`:

```yaml
interface:
  display_name: 'XXYY Autonomous Answering Agent'
  short_description: 'Route XXYY support messages without human handoff'
  default_prompt: 'Use $xxyy-autonomous-answering-agent to route this XXYY support message through automatic answering, clarification, transaction analysis, or boundary reply.'
```

- [ ] **Step 3: Run formatting check for the new skill**

Run:

```bash
pnpm exec prettier --check skills/xxyy-autonomous-answering-agent/SKILL.md skills/xxyy-autonomous-answering-agent/agents/openai.yaml
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add skills/xxyy-autonomous-answering-agent
git commit -m "docs: add autonomous answering agent skill"
```

## Task 8: Run Integrated Verification

**Files:**

- Verify: `packages/agent-core/src/*.test.ts`
- Verify: `skills/xxyy-autonomous-answering-agent/**`

- [ ] **Step 1: Run focused agent-core tests**

Run:

```bash
pnpm test packages/agent-core/src/session-context.test.ts packages/agent-core/src/follow-up-resolver.test.ts packages/agent-core/src/answer-planner.test.ts packages/agent-core/src/quality-signals.test.ts packages/agent-core/src/customer-agent-runtime.test.ts packages/agent-core/src/customer-agent-chat-service.test.ts
```

Expected: PASS for all listed test files.

- [ ] **Step 2: Run agent-core typecheck**

Run:

```bash
pnpm --filter @xxyy/agent-core typecheck
```

Expected: PASS.

- [ ] **Step 3: Run formatting check on touched files**

Run:

```bash
pnpm exec prettier --check packages/agent-core/src/session-context.ts packages/agent-core/src/session-context.test.ts packages/agent-core/src/follow-up-resolver.ts packages/agent-core/src/follow-up-resolver.test.ts packages/agent-core/src/answer-planner.ts packages/agent-core/src/answer-planner.test.ts packages/agent-core/src/quality-signals.ts packages/agent-core/src/quality-signals.test.ts packages/agent-core/src/customer-agent-runtime.ts packages/agent-core/src/customer-agent-runtime.test.ts packages/agent-core/src/customer-agent-chat-service.ts packages/agent-core/src/customer-agent-chat-service.test.ts packages/agent-core/src/index.ts skills/xxyy-autonomous-answering-agent/SKILL.md skills/xxyy-autonomous-answering-agent/agents/openai.yaml
```

Expected: PASS.

- [ ] **Step 4: Scan for forbidden customer-facing handoff language**

Run:

```bash
rg -n "转人工|人工接管|工单创建|客服工单工作流|will hand off|take over" packages/agent-core/src skills/xxyy-autonomous-answering-agent README.md docs -g '!docs/archive/**'
```

Expected: only negative-policy wording is allowed, such as “不依赖人工接管” or “Never promise user-facing human handoff”. Any positive promise of handoff or ticket creation must be removed.

- [ ] **Step 5: Run full project check if the focused checks pass**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Commit verification follow-ups if any formatting or test fixes were required**

If Step 1-5 required fixes, commit them:

```bash
git add packages/agent-core/src skills/xxyy-autonomous-answering-agent
git commit -m "test: verify autonomous answering agent"
```

If no files changed during verification, skip this commit.

## Self-Review Notes

- Spec coverage: this plan covers session context, follow-up resolution, explicit routing, clarification, boundary stability, quality signals, and no-handoff wording. It does not build dashboards, Postgres session persistence, quality-signal persistence, or new MCP servers; those are separate implementation slices after the in-process runtime behavior is proven.
- Placeholder scan: this plan uses concrete file paths, function names, test cases, commands, and expected outcomes.
- Type consistency: `SessionContextStore`, `QualitySignalSink`, `resolveFollowUp`, and `planAnswer` are introduced before runtime integration uses them.
