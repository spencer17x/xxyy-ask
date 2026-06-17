# XXYY Agent Tool Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first Agentic RAG foundation: a shared `@xxyy/agent-core` package with Tool Registry, transaction/product tools, and a controlled Customer Agent Runtime that existing MCP/API/CLI entrypoints can migrate to.

**Architecture:** `@xxyy/agent-core` depends on `@xxyy/rag-core` and `@xxyy/shared`; `@xxyy/rag-core` must not import `@xxyy/agent-core`. Business capabilities are registered once as tools and used through in-process calls internally. The existing transaction MCP server is refactored to register MCP tools from the same agent-core tool definitions, keeping external behavior stable.

**Tech Stack:** TypeScript ESM, pnpm workspace, Vitest, Zod, existing `@xxyy/rag-core` providers and `@modelcontextprotocol/sdk`.

---

## Scope

This plan implements Phase 1A of `docs/agent-system-design.md`: the shared tool layer, customer Agent Runtime, and tx-analysis MCP reuse. It does not implement Telegram ingestion, knowledge candidate review, or the full Ops Agent. Those should be separate plans after this foundation lands.

## File Map

- Create `packages/agent-core/package.json`: package metadata and dependencies.
- Create `packages/agent-core/tsconfig.json`: package TypeScript config.
- Create `packages/agent-core/src/tool-registry.ts`: generic tool definition, registry, policy filtering, and typed execution.
- Create `packages/agent-core/src/audit.ts`: in-memory test audit sink and audit event types.
- Create `packages/agent-core/src/tools/tx-analysis-tools.ts`: transaction analysis/report tools backed by `@xxyy/rag-core`.
- Create `packages/agent-core/src/tools/product-tools.ts`: product search and answer tools backed by retriever and answer provider.
- Create `packages/agent-core/src/customer-agent-runtime.ts`: controlled planner for customer chat requests.
- Create `packages/agent-core/src/index.ts`: public exports.
- Create tests under `packages/agent-core/src/*.test.ts`.
- Modify `tsconfig.json`: add `packages/agent-core` project reference.
- Modify `packages/tx-analysis-mcp/package.json`: depend on `@xxyy/agent-core`.
- Modify `packages/tx-analysis-mcp/src/tools.ts`: make tx MCP handlers come from agent-core tool definitions.
- Modify `packages/tx-analysis-mcp/src/server.ts`: register MCP tools from agent-core metadata instead of duplicated local schema.
- Modify `packages/tx-analysis-mcp/src/*.test.ts`: preserve existing MCP behavior.

---

### Task 1: Scaffold `@xxyy/agent-core`

**Files:**

- Create: `packages/agent-core/package.json`
- Create: `packages/agent-core/tsconfig.json`
- Create: `packages/agent-core/src/index.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Add package metadata**

Create `packages/agent-core/package.json`:

```json
{
  "name": "@xxyy/agent-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@xxyy/rag-core": "workspace:*",
    "@xxyy/shared": "workspace:*",
    "zod": "^4.0.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

- [ ] **Step 2: Add TypeScript config**

Create `packages/agent-core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Add an initial public export**

Create `packages/agent-core/src/index.ts`:

```ts
export const workspacePackageName = '@xxyy/agent-core';
```

- [ ] **Step 4: Add root TypeScript project reference**

Modify the root `tsconfig.json` references so `packages/agent-core` appears after `packages/rag-core` and before `packages/tx-analysis-mcp`:

```json
{
  "path": "./packages/agent-core"
}
```

- [ ] **Step 5: Verify package scaffold**

Run:

```bash
pnpm --filter @xxyy/agent-core typecheck
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 6: Commit scaffold**

```bash
git add tsconfig.json packages/agent-core/package.json packages/agent-core/tsconfig.json packages/agent-core/src/index.ts
git commit -m "feat: scaffold agent core package"
```

---

### Task 2: Implement Tool Registry Core

**Files:**

- Create: `packages/agent-core/src/tool-registry.ts`
- Create: `packages/agent-core/src/tool-registry.test.ts`
- Modify: `packages/agent-core/src/index.ts`

- [ ] **Step 1: Write failing registry tests**

Create `packages/agent-core/src/tool-registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createToolRegistry,
  ToolRegistryDuplicateNameError,
  ToolRegistryToolNotFoundError,
} from './tool-registry.js';

describe('createToolRegistry', () => {
  it('registers and executes a tool with schema validation', async () => {
    const registry = createToolRegistry();
    registry.register({
      description: 'Echo a message.',
      handler(input) {
        return Promise.resolve({ echoed: input.message });
      },
      inputSchema: z.object({ message: z.string().min(1) }),
      name: 'echo_message',
      outputSchema: z.object({ echoed: z.string() }),
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
    });

    await expect(registry.execute('echo_message', { message: 'hello' })).resolves.toEqual({
      echoed: 'hello',
    });
  });

  it('rejects duplicate names', () => {
    const registry = createToolRegistry();
    const tool = {
      description: 'Echo a message.',
      handler(input: { message: string }) {
        return Promise.resolve({ echoed: input.message });
      },
      inputSchema: z.object({ message: z.string() }),
      name: 'echo_message',
      outputSchema: z.object({ echoed: z.string() }),
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
    } as const;

    registry.register(tool);

    expect(() => registry.register(tool)).toThrow(ToolRegistryDuplicateNameError);
  });

  it('filters externally callable tools', () => {
    const registry = createToolRegistry();
    registry.register({
      description: 'Public tool.',
      handler() {
        return Promise.resolve({ ok: true });
      },
      inputSchema: z.object({}),
      name: 'public_tool',
      outputSchema: z.object({ ok: z.boolean() }),
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
    });
    registry.register({
      description: 'Internal tool.',
      handler() {
        return Promise.resolve({ ok: true });
      },
      inputSchema: z.object({}),
      name: 'internal_tool',
      outputSchema: z.object({ ok: z.boolean() }),
      policy: { allowExternalMcp: false, requiresOpsAuth: true },
    });

    expect(registry.list({ externalMcpOnly: true }).map((tool) => tool.name)).toEqual([
      'public_tool',
    ]);
  });

  it('throws a stable not-found error for missing tools', async () => {
    const registry = createToolRegistry();

    await expect(registry.execute('missing_tool', {})).rejects.toBeInstanceOf(
      ToolRegistryToolNotFoundError,
    );
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm test packages/agent-core/src/tool-registry.test.ts
```

Expected: FAIL because `tool-registry.ts` does not exist.

- [ ] **Step 3: Implement the registry**

Create `packages/agent-core/src/tool-registry.ts`:

```ts
import type { z } from 'zod';

export interface ToolPolicy {
  allowExternalMcp: boolean;
  requiresOpsAuth: boolean;
}

export interface ToolDefinition<
  Name extends string = string,
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  name: Name;
  description: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  policy: ToolPolicy;
  handler(input: z.infer<InputSchema>): Promise<z.infer<OutputSchema>>;
}

export interface ListToolsOptions {
  externalMcpOnly?: boolean;
}

export class ToolRegistryDuplicateNameError extends Error {
  constructor(name: string) {
    super(`Tool is already registered: ${name}`);
    this.name = 'ToolRegistryDuplicateNameError';
  }
}

export class ToolRegistryToolNotFoundError extends Error {
  constructor(name: string) {
    super(`Tool is not registered: ${name}`);
    this.name = 'ToolRegistryToolNotFoundError';
  }
}

export interface ToolRegistry {
  execute(name: string, input: unknown): Promise<unknown>;
  get(name: string): ToolDefinition;
  list(options?: ListToolsOptions): ToolDefinition[];
  register(tool: ToolDefinition): void;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    async execute(name, input) {
      const tool = this.get(name);
      const parsedInput = tool.inputSchema.parse(input);
      const output = await tool.handler(parsedInput);
      return tool.outputSchema.parse(output);
    },
    get(name) {
      const tool = tools.get(name);
      if (tool === undefined) {
        throw new ToolRegistryToolNotFoundError(name);
      }
      return tool;
    },
    list(options = {}) {
      const allTools = [...tools.values()];
      if (options.externalMcpOnly !== true) {
        return allTools;
      }
      return allTools.filter((tool) => tool.policy.allowExternalMcp);
    },
    register(tool) {
      if (tools.has(tool.name)) {
        throw new ToolRegistryDuplicateNameError(tool.name);
      }
      tools.set(tool.name, tool);
    },
  };
}
```

- [ ] **Step 4: Export registry APIs**

Modify `packages/agent-core/src/index.ts`:

```ts
export const workspacePackageName = '@xxyy/agent-core';

export {
  createToolRegistry,
  ToolRegistryDuplicateNameError,
  ToolRegistryToolNotFoundError,
} from './tool-registry.js';

export type {
  ListToolsOptions,
  ToolDefinition,
  ToolPolicy,
  ToolRegistry,
} from './tool-registry.js';
```

- [ ] **Step 5: Run registry tests**

Run:

```bash
pnpm test packages/agent-core/src/tool-registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit registry**

```bash
git add packages/agent-core/src/index.ts packages/agent-core/src/tool-registry.ts packages/agent-core/src/tool-registry.test.ts
git commit -m "feat: add agent tool registry"
```

---

### Task 3: Add Audit Event Support

**Files:**

- Create: `packages/agent-core/src/audit.ts`
- Create: `packages/agent-core/src/audit.test.ts`
- Modify: `packages/agent-core/src/index.ts`

- [ ] **Step 1: Write failing audit tests**

Create `packages/agent-core/src/audit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createInMemoryAuditSink } from './audit.js';

describe('createInMemoryAuditSink', () => {
  it('records immutable audit events for tests', () => {
    const sink = createInMemoryAuditSink();

    sink.record({
      channel: 'web',
      latencyMs: 12,
      status: 'success',
      toolName: 'answer_product_question',
    });

    expect(sink.events()).toEqual([
      {
        channel: 'web',
        latencyMs: 12,
        status: 'success',
        toolName: 'answer_product_question',
      },
    ]);
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm test packages/agent-core/src/audit.test.ts
```

Expected: FAIL because `audit.ts` does not exist.

- [ ] **Step 3: Implement audit sink**

Create `packages/agent-core/src/audit.ts`:

```ts
export type ToolAuditStatus = 'failure' | 'success';

export interface ToolAuditEvent {
  candidateId?: string;
  channel?: string;
  citationCount?: number;
  errorCode?: string;
  intent?: string;
  latencyMs: number;
  reportId?: string;
  sessionIdPresent?: boolean;
  sourceId?: string;
  status: ToolAuditStatus;
  toolName: string;
  userIdPresent?: boolean;
}

export interface ToolAuditSink {
  record(event: ToolAuditEvent): void;
}

export interface InMemoryAuditSink extends ToolAuditSink {
  events(): ToolAuditEvent[];
}

export function createNoopAuditSink(): ToolAuditSink {
  return {
    record() {
      return undefined;
    },
  };
}

export function createInMemoryAuditSink(): InMemoryAuditSink {
  const recorded: ToolAuditEvent[] = [];

  return {
    events() {
      return recorded.map((event) => ({ ...event }));
    },
    record(event) {
      recorded.push({ ...event });
    },
  };
}
```

- [ ] **Step 4: Export audit APIs**

Modify `packages/agent-core/src/index.ts`:

```ts
export { createInMemoryAuditSink, createNoopAuditSink } from './audit.js';

export type { InMemoryAuditSink, ToolAuditEvent, ToolAuditSink, ToolAuditStatus } from './audit.js';
```

Keep the existing `workspacePackageName` and registry exports in the same file.

- [ ] **Step 5: Run audit tests**

Run:

```bash
pnpm test packages/agent-core/src/audit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit audit support**

```bash
git add packages/agent-core/src/index.ts packages/agent-core/src/audit.ts packages/agent-core/src/audit.test.ts
git commit -m "feat: add agent tool audit sink"
```

---

### Task 4: Move Transaction Analysis Tools Into Agent Core

**Files:**

- Create: `packages/agent-core/src/tools/tx-analysis-tools.ts`
- Create: `packages/agent-core/src/tools/tx-analysis-tools.test.ts`
- Modify: `packages/agent-core/src/index.ts`

- [ ] **Step 1: Write failing transaction tool tests**

Create `packages/agent-core/src/tools/tx-analysis-tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '../tool-registry.js';
import { createTxAnalysisTools, TX_ANALYSIS_TOOL_NAMES } from './tx-analysis-tools.js';

const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

describe('createTxAnalysisTools', () => {
  it('registers stable transaction tool names', () => {
    expect(TX_ANALYSIS_TOOL_NAMES).toEqual([
      'analyze_transaction',
      'get_analysis_report',
      'list_analysis_reports',
    ]);
  });

  it('analyzes a transaction through the registry', async () => {
    const registry = createToolRegistry();
    for (const tool of createTxAnalysisTools({
      provider: {
        analyze(reference) {
          return Promise.resolve({
            analyzedAt: '2026-06-16T00:00:00.000Z',
            chain: reference.chain,
            confidence: 0.61,
            dataSource: 'fixture',
            evidence: [],
            relatedTransactions: [],
            summary: '未发现典型 sandwich。',
            txHash: reference.txHash,
            verdict: 'not_sandwiched',
          });
        },
      },
    })) {
      registry.register(tool);
    }

    await expect(
      registry.execute('analyze_transaction', { chain: 'base', channel: 'agent', txHash: evmTx }),
    ).resolves.toMatchObject({
      result: {
        chain: 'base',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
      status: 'success',
    });
  });

  it('returns empty report results when report reader is missing', async () => {
    const registry = createToolRegistry();
    for (const tool of createTxAnalysisTools({ provider: undefined })) {
      registry.register(tool);
    }

    await expect(registry.execute('list_analysis_reports', { chain: 'base' })).resolves.toEqual({
      reports: [],
    });
    await expect(
      registry.execute('get_analysis_report', { id: 'missing-report' }),
    ).resolves.toEqual({});
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm test packages/agent-core/src/tools/tx-analysis-tools.test.ts
```

Expected: FAIL because `tx-analysis-tools.ts` does not exist.

- [ ] **Step 3: Implement transaction tools**

Create `packages/agent-core/src/tools/tx-analysis-tools.ts`:

```ts
import { z } from 'zod';

import {
  analyzeTransaction,
  type AnalyzeTransactionInput,
  type AnalyzeTransactionOutput,
  type FindTxAnalysisReportsOptions,
  type TxAnalysisProvider,
  type TxAnalysisReportReader,
  type TxAnalysisUnavailableReason,
} from '@xxyy/rag-core';

import type { ToolDefinition } from '../tool-registry.js';

export const TX_ANALYSIS_TOOL_NAMES = [
  'analyze_transaction',
  'get_analysis_report',
  'list_analysis_reports',
] as const;

export type TxAnalysisToolName = (typeof TX_ANALYSIS_TOOL_NAMES)[number];
export type TxAnalysisToolChannel = 'agent' | 'cli' | 'ops' | 'support' | 'telegram' | 'web';

export type AnalyzeTransactionToolInput = AnalyzeTransactionInput & {
  channel?: TxAnalysisToolChannel;
};

export interface CreateTxAnalysisToolsOptions {
  provider: TxAnalysisProvider | undefined;
  reportReader?: TxAnalysisReportReader;
}

const chainSchema = z.enum(['solana', 'base', 'ethereum', 'bsc', 'unknown']).optional();
const reportStatusSchema = z.enum(['success', 'failure']).optional();
const reviewStatusSchema = z.enum(['open', 'in_review', 'closed']).optional();
const txAnalysisUnavailableReasons = [
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
] as const satisfies readonly TxAnalysisUnavailableReason[];
const failureReasonSchema = z.enum(txAnalysisUnavailableReasons).optional();

export const analyzeTransactionInputSchema = z.object({
  chain: chainSchema,
  channel: z.enum(['agent', 'cli', 'ops', 'support', 'telegram', 'web']).optional(),
  txHash: z.string().min(1),
});

export const analyzeTransactionOutputSchema = z.custom<AnalyzeTransactionOutput>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value.status === 'success' || value.status === 'failure'),
);

export const getAnalysisReportInputSchema = z.object({
  id: z.string().min(1),
});

export const getAnalysisReportOutputSchema = z.object({
  document: z.unknown().optional(),
});

export const listAnalysisReportsInputSchema = z.object({
  chain: chainSchema,
  limit: z.number().int().positive().optional(),
  reason: failureReasonSchema,
  reviewAssignee: z.string().min(1).optional(),
  reviewStatus: reviewStatusSchema,
  status: reportStatusSchema,
  txHash: z.string().min(1).optional(),
});

export const listAnalysisReportsOutputSchema = z.object({
  reports: z.array(z.unknown()),
});

export function createTxAnalysisTools(
  options: CreateTxAnalysisToolsOptions,
): ToolDefinition<TxAnalysisToolName>[] {
  return [
    {
      description:
        'Analyze whether one XXYY-related transaction hash or supported explorer link was sandwiched.',
      handler(input) {
        return analyzeTransaction({
          input: toRagAnalyzeTransactionInput(input),
          provider: options.provider,
        });
      },
      inputSchema: analyzeTransactionInputSchema,
      name: 'analyze_transaction',
      outputSchema: analyzeTransactionOutputSchema,
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
    },
    {
      description: 'Fetch one stored XXYY transaction analysis report document by report id.',
      async handler(input) {
        const document = await options.reportReader?.getReportDocument?.(input.id);
        return document === undefined ? {} : { document };
      },
      inputSchema: getAnalysisReportInputSchema,
      name: 'get_analysis_report',
      outputSchema: getAnalysisReportOutputSchema,
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
    },
    {
      description: 'List stored XXYY transaction analysis reports with optional filters.',
      async handler(input) {
        if (options.reportReader === undefined) {
          return { reports: [] };
        }
        return { reports: await options.reportReader.findReports(toFindReportsInput(input)) };
      },
      inputSchema: listAnalysisReportsInputSchema,
      name: 'list_analysis_reports',
      outputSchema: listAnalysisReportsOutputSchema,
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
    },
  ];
}

function toRagAnalyzeTransactionInput(input: AnalyzeTransactionToolInput): AnalyzeTransactionInput {
  return {
    ...(input.chain === undefined ? {} : { chain: input.chain }),
    txHash: input.txHash,
  };
}

function toFindReportsInput(
  input: z.infer<typeof listAnalysisReportsInputSchema>,
): FindTxAnalysisReportsOptions {
  return {
    ...(input.chain === undefined ? {} : { chain: input.chain }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.reviewAssignee === undefined ? {} : { reviewAssignee: input.reviewAssignee }),
    ...(input.reviewStatus === undefined ? {} : { reviewStatus: input.reviewStatus }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.txHash === undefined ? {} : { txHash: input.txHash }),
  };
}
```

- [ ] **Step 4: Export transaction tools**

Modify `packages/agent-core/src/index.ts`:

```ts
export {
  analyzeTransactionInputSchema,
  analyzeTransactionOutputSchema,
  createTxAnalysisTools,
  getAnalysisReportInputSchema,
  getAnalysisReportOutputSchema,
  listAnalysisReportsInputSchema,
  listAnalysisReportsOutputSchema,
  TX_ANALYSIS_TOOL_NAMES,
} from './tools/tx-analysis-tools.js';

export type {
  AnalyzeTransactionToolInput,
  CreateTxAnalysisToolsOptions,
  TxAnalysisToolChannel,
  TxAnalysisToolName,
} from './tools/tx-analysis-tools.js';
```

- [ ] **Step 5: Run transaction tool tests**

Run:

```bash
pnpm test packages/agent-core/src/tools/tx-analysis-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit transaction tools**

```bash
git add packages/agent-core/src/index.ts packages/agent-core/src/tools/tx-analysis-tools.ts packages/agent-core/src/tools/tx-analysis-tools.test.ts
git commit -m "feat: add transaction analysis agent tools"
```

---

### Task 5: Add Product Search and Answer Tools

**Files:**

- Create: `packages/agent-core/src/tools/product-tools.ts`
- Create: `packages/agent-core/src/tools/product-tools.test.ts`
- Modify: `packages/agent-core/src/index.ts`

- [ ] **Step 1: Write failing product tool tests**

Create `packages/agent-core/src/tools/product-tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { ChatResponse, RagIndex, SourceType } from '@xxyy/shared';
import type { AnswerProvider } from '@xxyy/rag-core';

import { createToolRegistry } from '../tool-registry.js';
import { createProductTools } from './product-tools.js';

function createAgentFixtureIndex(
  chunks: Array<{ file: string; id: string; sourceType: SourceType; text: string; title: string }>,
): RagIndex {
  return {
    builtAt: '2026-06-16T00:00:00.000Z',
    entries: chunks.map((chunk) => ({
      documentId: chunk.id.split(':chunk:')[0] ?? chunk.id,
      embedding: [1, 0, 0],
      id: chunk.id,
      metadata: {
        file: chunk.file,
        headingPath: [],
        module: chunk.title,
        sourceType: chunk.sourceType,
        title: chunk.title,
      },
      text: chunk.text,
      tokens: chunk.text.toLowerCase().split(/\s+/u),
    })),
    version: 1,
  };
}

describe('createProductTools', () => {
  it('searches product docs through the configured retriever', async () => {
    const registry = createToolRegistry();
    for (const tool of createProductTools({
      config: { topK: 1 },
      index: createAgentFixtureIndex([
        {
          id: 'official_docs:telegram:chunk:0001',
          title: 'Telegram 钱包监控',
          sourceType: 'official_docs',
          file: 'docs/telegram.md',
          text: 'XXYY 支持 Telegram 钱包监控。',
        },
      ]),
    })) {
      registry.register(tool);
    }

    const result = await registry.execute('search_product_docs', {
      query: '如何设置 Telegram 钱包监控？',
      topK: 1,
    });

    expect(result).toMatchObject({
      confidence: expect.any(Number),
      chunks: [
        {
          text: expect.stringContaining('Telegram 钱包监控'),
        },
      ],
      citations: [
        {
          file: 'docs/telegram.md',
          title: 'Telegram 钱包监控',
        },
      ],
    });
  });

  it('answers product questions through the answer provider', async () => {
    const answerProvider: AnswerProvider = {
      answer(input) {
        const response: ChatResponse = {
          answer: `已根据 ${input.retrievedChunks.length} 条资料回答。`,
          citations: input.retrievedChunks.map((chunk) => ({
            excerpt: chunk.text,
            file: chunk.metadata.file,
            title: chunk.metadata.title,
          })),
          confidence: 0.9,
          intent: input.classification.intent,
        };
        return Promise.resolve(response);
      },
    };
    const registry = createToolRegistry();
    for (const tool of createProductTools({
      answerProvider,
      config: { topK: 1 },
      index: createAgentFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro 权益',
          sourceType: 'official_docs',
          file: 'docs/pro.md',
          text: 'XXYY Pro 支持 Telegram 钱包监控。',
        },
      ]),
    })) {
      registry.register(tool);
    }

    await expect(
      registry.execute('answer_product_question', {
        channel: 'web',
        question: 'XXYY Pro 有哪些权益？',
      }),
    ).resolves.toMatchObject({
      answer: expect.stringContaining('已根据 1 条资料回答'),
      confidence: 0.9,
      intent: 'product_qa',
    });
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm test packages/agent-core/src/tools/product-tools.test.ts
```

Expected: FAIL because `product-tools.ts` does not exist.

- [ ] **Step 3: Implement product tools**

Create `packages/agent-core/src/tools/product-tools.ts`:

```ts
import { z } from 'zod';

import type { ChatChannel, ChatResponse, RagIndex } from '@xxyy/shared';
import {
  classifyQuestion,
  createLocalRetriever,
  loadRagConfig,
  type AnswerProvider,
  type RagConfig,
  type RetrievedChunk,
  type Retriever,
} from '@xxyy/rag-core';

import type { ToolDefinition } from '../tool-registry.js';

export const PRODUCT_TOOL_NAMES = ['search_product_docs', 'answer_product_question'] as const;
export type ProductToolName = (typeof PRODUCT_TOOL_NAMES)[number];

export interface CreateProductToolsOptions {
  answerProvider?: AnswerProvider;
  config?: Partial<RagConfig>;
  index?: RagIndex;
  retriever?: Retriever;
}

const searchProductDocsInputSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().optional(),
});

const citationSchema = z.object({
  excerpt: z.string(),
  file: z.string(),
  sourceUrl: z.string().optional(),
  title: z.string(),
});

const searchProductDocsOutputSchema = z.object({
  chunks: z.array(z.unknown()),
  citations: z.array(citationSchema),
  confidence: z.number(),
});

const answerProductQuestionInputSchema = z.object({
  channel: z.enum(['cli', 'web', 'telegram', 'agent']).optional(),
  question: z.string().min(1),
});

const answerProductQuestionOutputSchema = z.custom<ChatResponse>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'answer' in value &&
    'intent' in value &&
    'citations' in value &&
    'confidence' in value,
);

export function createProductTools(
  options: CreateProductToolsOptions,
): ToolDefinition<ProductToolName>[] {
  const config = { ...loadRagConfig(), ...options.config };
  const retriever = createRetriever(options);

  return [
    {
      description:
        'Search XXYY product documentation and return relevant chunks without writing a final answer.',
      async handler(input) {
        const retrievedChunks = await retriever.retrieve(input.query, {
          topK: input.topK ?? config.topK,
        });
        return {
          chunks: retrievedChunks,
          citations: retrievedChunks.map(toCitation),
          confidence: averageScore(retrievedChunks),
        };
      },
      inputSchema: searchProductDocsInputSchema,
      name: 'search_product_docs',
      outputSchema: searchProductDocsOutputSchema,
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
    },
    {
      description:
        'Answer XXYY product, setup, entitlement, and official-update questions using retrieved documentation.',
      async handler(input) {
        if (options.answerProvider === undefined) {
          throw new Error('answer_product_question requires an answerProvider.');
        }
        const classification = classifyQuestion(input.question);
        const retrievedChunks = await retriever.retrieve(input.question, { topK: config.topK });
        return options.answerProvider.answer({
          classification,
          question: input.question,
          retrievedChunks,
        });
      },
      inputSchema: answerProductQuestionInputSchema,
      name: 'answer_product_question',
      outputSchema: answerProductQuestionOutputSchema,
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
    },
  ];
}

function createRetriever(options: CreateProductToolsOptions): Retriever {
  if (options.retriever !== undefined) {
    return options.retriever;
  }
  if (options.index !== undefined) {
    return createLocalRetriever(options.index);
  }
  throw new Error('createProductTools requires either index or retriever.');
}

function toCitation(chunk: RetrievedChunk) {
  return {
    excerpt: chunk.text,
    file: chunk.metadata.file,
    ...(chunk.metadata.sourceUrl === undefined ? {} : { sourceUrl: chunk.metadata.sourceUrl }),
    title: chunk.metadata.title,
  };
}

function averageScore(chunks: RetrievedChunk[]): number {
  if (chunks.length === 0) {
    return 0;
  }
  return chunks.reduce((sum, chunk) => sum + chunk.score, 0) / chunks.length;
}
```

- [ ] **Step 4: Export product tools**

Modify `packages/agent-core/src/index.ts`:

```ts
export { createProductTools, PRODUCT_TOOL_NAMES } from './tools/product-tools.js';

export type { CreateProductToolsOptions, ProductToolName } from './tools/product-tools.js';
```

- [ ] **Step 5: Run product tool tests**

Run:

```bash
pnpm test packages/agent-core/src/tools/product-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit product tools**

```bash
git add packages/agent-core/src/index.ts packages/agent-core/src/tools/product-tools.ts packages/agent-core/src/tools/product-tools.test.ts
git commit -m "feat: add product qa agent tools"
```

---

### Task 6: Add Controlled Customer Agent Runtime

**Files:**

- Create: `packages/agent-core/src/customer-agent-runtime.ts`
- Create: `packages/agent-core/src/customer-agent-runtime.test.ts`
- Modify: `packages/agent-core/src/index.ts`
- Modify: `packages/rag-core/src/index.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `packages/agent-core/src/customer-agent-runtime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ChatResponse } from '@xxyy/shared';

import { createInMemoryAuditSink } from './audit.js';
import { createCustomerAgentRuntime } from './customer-agent-runtime.js';
import { createToolRegistry } from './tool-registry.js';

describe('createCustomerAgentRuntime', () => {
  it('uses answer_product_question for product questions', async () => {
    const registry = createToolRegistry();
    registry.register({
      description: 'Answer product question.',
      handler(input) {
        const response: ChatResponse = {
          answer: `回答：${input.question}`,
          citations: [],
          confidence: 0.9,
          intent: 'product_qa',
        };
        return Promise.resolve(response);
      },
      inputSchema: z.object({
        channel: z.enum(['cli', 'web', 'telegram']).optional(),
        question: z.string(),
      }),
      name: 'answer_product_question',
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
    });

    const audit = createInMemoryAuditSink();
    const runtime = createCustomerAgentRuntime({ audit, registry });

    await expect(
      runtime.ask({ channel: 'web', message: 'XXYY Pro 有哪些权益？' }),
    ).resolves.toMatchObject({
      answer: expect.stringContaining('XXYY Pro'),
      intent: 'product_qa',
    });
    expect(audit.events()).toEqual([
      expect.objectContaining({
        channel: 'web',
        intent: 'product_qa',
        status: 'success',
        toolName: 'answer_product_question',
      }),
    ]);
  });

  it('returns boundary answers without executing tools', async () => {
    const registry = createToolRegistry();
    const runtime = createCustomerAgentRuntime({ registry });

    const response = await runtime.ask({
      channel: 'web',
      message: '帮我查一下钱包余额',
    });

    expect(response.intent).toBe('realtime_account_query');
    expect(response.citations).toEqual([]);
  });
});
```

- [ ] **Step 2: Export boundary answer from rag-core**

Modify `packages/rag-core/src/index.ts` so the answer exports include `createBoundaryAnswer`:

```ts
export { createBoundaryAnswer, createGroundedAnswer } from './answer.js';
```

Keep the existing exports in the same file unchanged.

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
pnpm test packages/agent-core/src/customer-agent-runtime.test.ts
```

Expected: FAIL because `customer-agent-runtime.ts` does not exist.

- [ ] **Step 4: Implement customer runtime**

Create `packages/agent-core/src/customer-agent-runtime.ts`:

```ts
import {
  classifyQuestion,
  createBoundaryAnswer,
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
} from '@xxyy/rag-core';
import type { ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';

import { createNoopAuditSink, type ToolAuditSink } from './audit.js';
import type { ToolRegistry } from './tool-registry.js';

export interface CustomerAgentRuntime {
  ask(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export interface CreateCustomerAgentRuntimeOptions {
  audit?: ToolAuditSink;
  registry: ToolRegistry;
}

export function createCustomerAgentRuntime(
  options: CreateCustomerAgentRuntimeOptions,
): CustomerAgentRuntime {
  const audit = options.audit ?? createNoopAuditSink();

  return {
    async ask(request) {
      const startedAt = Date.now();
      const classification = classifyQuestion(request.message);

      if (classification.intent === 'tx_sandwich_detection') {
        const output = await options.registry.execute('analyze_transaction', {
          txHash: request.message,
        });
        audit.record({
          channel: request.channel,
          intent: classification.intent,
          latencyMs: Date.now() - startedAt,
          sessionIdPresent: request.sessionId !== undefined,
          status: 'success',
          toolName: 'analyze_transaction',
          userIdPresent: request.userId !== undefined,
        });
        return toTxChatResponse(output);
      }

      if (classification.intent !== 'product_qa' && classification.intent !== 'how_to') {
        return createBoundaryAnswer(classification);
      }

      const response = (await options.registry.execute('answer_product_question', {
        channel: request.channel,
        question: request.message,
      })) as ChatResponse;
      audit.record({
        channel: request.channel,
        citationCount: response.citations.length,
        intent: response.intent,
        latencyMs: Date.now() - startedAt,
        sessionIdPresent: request.sessionId !== undefined,
        status: 'success',
        toolName: 'answer_product_question',
        userIdPresent: request.userId !== undefined,
      });
      return response;
    },
    async *stream(request) {
      yield* streamChatResponse(await this.ask(request));
    },
  };
}

function toTxChatResponse(output: unknown): ChatResponse {
  const typedOutput = output as
    | { result: Parameters<typeof createTxAnalysisAnswer>[0]; status: 'success' }
    | {
        failure: {
          message: string;
          metadata?: Record<string, unknown>;
          reason: Parameters<typeof createTxAnalysisUnavailableAnswer>[0];
          reportUrl?: string;
        };
        status: 'failure';
      };

  if (typedOutput.status === 'success') {
    return createTxAnalysisAnswer(typedOutput.result);
  }

  return createTxAnalysisUnavailableAnswer(typedOutput.failure.reason, {
    ...(typedOutput.failure.metadata === undefined
      ? {}
      : { metadata: typedOutput.failure.metadata }),
    ...(typedOutput.failure.reportUrl === undefined
      ? {}
      : { reportUrl: typedOutput.failure.reportUrl }),
  });
}

function streamChatResponse(response: ChatResponse): AsyncIterable<ChatStreamEvent> {
  return toAsyncIterable([
    ...(response.answer.length > 0
      ? [{ type: 'answer_delta' as const, delta: response.answer }]
      : []),
    {
      type: 'metadata' as const,
      ...(response.attachments === undefined ? {} : { attachments: response.attachments }),
      citations: response.citations,
      confidence: response.confidence,
      intent: response.intent,
    },
  ]);
}

async function* toAsyncIterable<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}
```

- [ ] **Step 5: Export runtime**

Modify `packages/agent-core/src/index.ts`:

```ts
export { createCustomerAgentRuntime } from './customer-agent-runtime.js';

export type {
  CreateCustomerAgentRuntimeOptions,
  CustomerAgentRuntime,
} from './customer-agent-runtime.js';
```

- [ ] **Step 6: Run runtime tests**

Run:

```bash
pnpm test packages/agent-core/src/customer-agent-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit runtime**

```bash
git add packages/rag-core/src/index.ts packages/agent-core/src/index.ts packages/agent-core/src/customer-agent-runtime.ts packages/agent-core/src/customer-agent-runtime.test.ts
git commit -m "feat: add controlled customer agent runtime"
```

---

### Task 7: Refactor Transaction MCP To Use Agent-Core Tools

**Files:**

- Modify: `packages/tx-analysis-mcp/package.json`
- Modify: `packages/tx-analysis-mcp/src/tools.ts`
- Modify: `packages/tx-analysis-mcp/src/server.ts`
- Modify: `packages/tx-analysis-mcp/src/tools.test.ts`
- Modify: `packages/tx-analysis-mcp/src/server.test.ts`

- [ ] **Step 1: Add agent-core dependency**

Modify `packages/tx-analysis-mcp/package.json` dependencies:

```json
"@xxyy/agent-core": "workspace:*"
```

Keep existing `@xxyy/rag-core`, `@xxyy/shared`, MCP SDK, and `zod` dependencies until the refactor is complete.

- [ ] **Step 2: Replace tx MCP handlers with agent-core wrapper**

Modify `packages/tx-analysis-mcp/src/tools.ts` so it imports from `@xxyy/agent-core`:

```ts
import {
  createToolRegistry,
  createTxAnalysisTools,
  type AnalyzeTransactionToolInput,
} from '@xxyy/agent-core';
import type {
  AnalyzeTransactionOutput,
  FindTxAnalysisReportsOptions,
  TxAnalysisProvider,
  TxAnalysisReportReader,
} from '@xxyy/rag-core';

export type TxAnalysisToolChannel = AnalyzeTransactionToolInput['channel'];

export interface TxAnalysisToolHandlersOptions {
  provider: TxAnalysisProvider | undefined;
  reportReader?: TxAnalysisReportReader;
}

export interface TxAnalysisToolHandlers {
  analyzeTransaction(input: AnalyzeTransactionToolInput): Promise<AnalyzeTransactionOutput>;
  getAnalysisReport(input: { id: string }): Promise<{ document?: unknown }>;
  listAnalysisReports(
    input: FindTxAnalysisReportsOptions,
  ): Promise<{ reports: Awaited<ReturnType<TxAnalysisReportReader['findReports']>> }>;
}

export function createTxAnalysisToolHandlers(
  options: TxAnalysisToolHandlersOptions,
): TxAnalysisToolHandlers {
  const registry = createToolRegistry();
  for (const tool of createTxAnalysisTools(options)) {
    registry.register(tool);
  }

  return {
    analyzeTransaction(input) {
      return registry.execute('analyze_transaction', input) as Promise<AnalyzeTransactionOutput>;
    },
    getAnalysisReport(input) {
      return registry.execute('get_analysis_report', input) as Promise<{ document?: unknown }>;
    },
    listAnalysisReports(input) {
      return registry.execute('list_analysis_reports', input) as Promise<{
        reports: Awaited<ReturnType<TxAnalysisReportReader['findReports']>>;
      }>;
    },
  };
}
```

- [ ] **Step 3: Make server tool names come from agent-core**

Modify `packages/tx-analysis-mcp/src/server.ts` imports and constants:

```ts
import {
  analyzeTransactionInputSchema,
  getAnalysisReportInputSchema,
  listAnalysisReportsInputSchema,
  TX_ANALYSIS_TOOL_NAMES,
} from '@xxyy/agent-core';

export const TX_ANALYSIS_MCP_TOOL_NAMES = [...TX_ANALYSIS_TOOL_NAMES];
```

Remove local duplicated `chainSchema`, `reportStatusSchema`, `reviewStatusSchema`, `txAnalysisUnavailableReasons`, `failureReasonSchema`, `analyzeTransactionInputSchema`, `getAnalysisReportInputSchema`, and `listAnalysisReportsInputSchema` declarations from `server.ts`.

- [ ] **Step 4: Keep MCP behavior stable**

Run:

```bash
pnpm test packages/tx-analysis-mcp/src/tools.test.ts packages/tx-analysis-mcp/src/server.test.ts
```

Expected: PASS. Existing tests should still verify stable tool names, structured content, channel forwarding, report lookup, and list filtering.

- [ ] **Step 5: Remove direct rag-core dependency only if unused**

After `server.ts` no longer imports rag-core types, run:

```bash
rg -n "@xxyy/rag-core" packages/tx-analysis-mcp/src packages/tx-analysis-mcp/package.json
```

Expected: `tools.ts` still imports rag-core types. Keep the dependency in `package.json`.

- [ ] **Step 6: Commit MCP refactor**

```bash
git add packages/tx-analysis-mcp/package.json packages/tx-analysis-mcp/src/tools.ts packages/tx-analysis-mcp/src/server.ts packages/tx-analysis-mcp/src/tools.test.ts packages/tx-analysis-mcp/src/server.test.ts
git commit -m "refactor: back tx mcp tools with agent registry"
```

---

### Task 8: Final Verification

**Files:**

- Verify only. No planned file edits.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm test packages/agent-core/src packages/tx-analysis-mcp/src
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full check**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 4: Confirm public behavior**

Run:

```bash
TX_ANALYSIS_PROVIDER=mock pnpm tx:mcp:smoke
```

Expected: PASS using existing mock MCP smoke samples.

- [ ] **Step 5: Commit verification fixes if needed**

If verification required small fixes, commit only those changed files:

```bash
git status --short
git add tsconfig.json packages/rag-core/src/index.ts packages/agent-core packages/tx-analysis-mcp
git commit -m "test: verify agent registry integration"
```

If no files changed after verification, do not create an empty commit.

---

## Self-Review

- Spec coverage: This plan covers Tool Registry, in-process tool execution, product tools, transaction tools, Customer Agent Runtime, audit logging, and MCP reuse. Ops Agent tools and Telegram knowledge learning are intentionally split into follow-up plans because they touch separate API, storage, auth, and UI boundaries.
- Placeholder scan: The plan contains no unfinished placeholder markers. Each task has concrete files, code shapes, commands, and expected results.
- Type consistency: Tool names are stable across registry, runtime, and MCP: `search_product_docs`, `answer_product_question`, `analyze_transaction`, `get_analysis_report`, and `list_analysis_reports`.
