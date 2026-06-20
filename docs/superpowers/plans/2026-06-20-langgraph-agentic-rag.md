# LangGraph Agentic RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current deterministic customer runtime with a LangGraph-powered XXYY Customer Support Agentic RAG runtime while removing the heavy ops, knowledge-ops, long-term session, feedback-loop, and eval-gate surfaces from the first production slice.

**Architecture:** Keep XXYY business capabilities independent from LangGraph. `packages/agent-core` owns LangGraph state, planner, tool execution, policy guard, and answer normalization; `packages/rag-core` and existing tool modules continue to own Product RAG and transaction analysis logic. MCP servers wrap the same capability/tool layer for external agents.

**Tech Stack:** TypeScript ESM, pnpm workspace, Vitest, LangGraph JS (`@langchain/langgraph`), LangChain core tool/message types (`@langchain/core`), Zod, existing OpenAI-compatible chat completions, Postgres + pgvector, existing MCP packages.

---

## File Structure

Create:

- `packages/agent-core/src/langgraph-state.ts`  
  LangGraph state annotation, state types, planner action types, and small state helpers.
- `packages/agent-core/src/langgraph-state.test.ts`  
  Unit tests for state helper defaults and route normalization.
- `packages/agent-core/src/planner-model.ts`  
  Planner model interface, scripted planner for tests, and OpenAI-compatible JSON planner implementation.
- `packages/agent-core/src/planner-model.test.ts`  
  Tests for scripted planner and JSON planner parsing/failure handling.
- `packages/agent-core/src/langgraph-customer-runtime.ts`  
  LangGraph graph construction and `CustomerAgentRuntime` implementation.
- `packages/agent-core/src/langgraph-customer-runtime.test.ts`  
  Runtime tests for product RAG path, transaction tool path, guardrail boundary path, unauthorized tool path, and step-limit path.
- `scripts/agent-smoke.mjs`  
  Lightweight smoke script replacing `ops:smoke`.

Modify:

- `packages/agent-core/package.json`  
  Add `@langchain/langgraph` and `@langchain/core`.
- `packages/agent-core/src/tool-registry.ts`  
  Add `ToolContext`, optional context-aware execution, and allowed-tool checks for planner use.
- `packages/agent-core/src/tools/tx-analysis-tools.ts`  
  Keep `analyze_transaction`; remove report-list/review-oriented tool exports from the first runtime surface.
- `packages/agent-core/src/customer-agent-chat-service.ts`  
  Build registry and return the LangGraph runtime.
- `packages/agent-core/src/customer-agent-runtime.ts`  
  Delete after `langgraph-customer-runtime.ts` is exported and tests pass, or leave a compatibility re-export for one commit before deletion.
- `packages/agent-core/src/index.ts`  
  Export LangGraph runtime, planner model, state, and trimmed tool APIs. Remove knowledge-ops, quality-signal, audit, and session exports after dependent code is removed.
- `packages/shared/src/index.ts`  
  Remove `preference_capture` from first-slice `supportedAgentRoutes`; keep `product_answer`, `transaction_analysis`, `boundary`, and `clarify`.
- `apps/api/src/index.ts`  
  Remove ops, knowledge-ops, feedback, session context, tool audit, candidate queue, report review, and ops HTML routes. Keep health, deep health, chat, stream, direct tx-analysis, static assets, rate limit, and CORS.
- `apps/api/src/index.test.ts`  
  Remove ops/feedback/session assertions; add LangGraph chat routing assertions.
- `apps/web/src` files if feedback UI is wired there  
  Remove feedback submission UI and API calls.
- `package.json`  
  Add `agent:smoke`; remove `ops:*`, `knowledge-ops:mcp`, `rag:sync:telegram`, `rag:publish:knowledge`, `rag:gate:knowledge`, `rag:feedback`, and `rag:evaluate`.
- `pnpm-workspace.yaml`  
  Remove `packages/knowledge-ops` and `packages/knowledge-ops-mcp` only after imports are gone.
- `README.md`, `AGENTS.md`, `docs/feature-status.md`, `docs/roadmap.md`  
  Update project positioning and command tables to match LangGraph Agentic RAG first slice.

Delete:

- `packages/agent-core/src/knowledge-ops-agent-runtime.ts`
- `packages/agent-core/src/knowledge-ops-agent-runtime.test.ts`
- `packages/agent-core/src/tools/knowledge-ops-tools.ts`
- `packages/agent-core/src/tools/knowledge-ops-tools.test.ts`
- `packages/agent-core/src/quality-signals.ts`
- `packages/agent-core/src/quality-signals.test.ts`
- `packages/agent-core/src/audit.ts`
- `packages/agent-core/src/audit.test.ts`
- `packages/agent-core/src/session-context.ts`
- `packages/agent-core/src/session-context.test.ts`
- `packages/agent-core/src/pg-session-context.ts`
- `packages/agent-core/src/pg-session-context.test.ts`
- `packages/agent-core/src/follow-up-resolver.ts`
- `packages/agent-core/src/follow-up-resolver.test.ts`
- `packages/knowledge-ops`
- `packages/knowledge-ops-mcp`
- `skills/xxyy-knowledge-ops`
- `skills/xxyy-autonomous-answering-agent` or rename it to `skills/xxyy-customer-agent` with LangGraph-specific policy.

---

### Task 1: Add LangGraph Dependencies And Planner Contracts

**Files:**
- Modify: `packages/agent-core/package.json`
- Create: `packages/agent-core/src/langgraph-state.ts`
- Create: `packages/agent-core/src/langgraph-state.test.ts`
- Create: `packages/agent-core/src/planner-model.ts`
- Create: `packages/agent-core/src/planner-model.test.ts`

- [ ] **Step 1: Install LangGraph dependencies**

Run:

```bash
pnpm add @langchain/langgraph @langchain/core --filter @xxyy/agent-core
```

Expected:

```text
Done
```

`packages/agent-core/package.json` should contain:

```json
{
  "dependencies": {
    "@langchain/core": "^1.0.0",
    "@langchain/langgraph": "^1.0.0",
    "@xxyy/rag-core": "workspace:*",
    "@xxyy/shared": "workspace:*",
    "zod": "^4.0.0"
  }
}
```

Keep the exact versions pnpm resolves in `pnpm-lock.yaml`.

- [ ] **Step 2: Write failing state tests**

Create `packages/agent-core/src/langgraph-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  AGENT_MAX_STEPS_DEFAULT,
  createInitialAgentState,
  isAllowedAgentToolName,
  normalizeAgentRoute,
} from './langgraph-state.js';

describe('langgraph agent state helpers', () => {
  it('creates initial state from a chat request', () => {
    const state = createInitialAgentState({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
      sessionId: 's1',
    });

    expect(state).toMatchObject({
      currentStep: 0,
      errors: [],
      evidence: [],
      maxSteps: AGENT_MAX_STEPS_DEFAULT,
      messages: [{ role: 'user', content: 'XXYY Pro 有哪些权益？' }],
      request: {
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 's1',
      },
      toolCalls: [],
      toolResults: [],
    });
  });

  it('allows only first-slice customer support tools', () => {
    expect(isAllowedAgentToolName('answer_product_question')).toBe(true);
    expect(isAllowedAgentToolName('analyze_transaction')).toBe(true);
    expect(isAllowedAgentToolName('boundary_reply')).toBe(true);
    expect(isAllowedAgentToolName('clarify_request')).toBe(true);
    expect(isAllowedAgentToolName('list_analysis_reports')).toBe(false);
    expect(isAllowedAgentToolName('sync_telegram_support')).toBe(false);
  });

  it('normalizes planner routes into shared agent routes', () => {
    expect(normalizeAgentRoute('product_answer')).toBe('product_answer');
    expect(normalizeAgentRoute('transaction_analysis')).toBe('transaction_analysis');
    expect(normalizeAgentRoute('boundary')).toBe('boundary');
    expect(normalizeAgentRoute('clarify')).toBe('clarify');
    expect(normalizeAgentRoute('unsupported')).toBe('clarify');
  });
});
```

- [ ] **Step 3: Run state tests to verify failure**

Run:

```bash
pnpm test packages/agent-core/src/langgraph-state.test.ts
```

Expected:

```text
FAIL  packages/agent-core/src/langgraph-state.test.ts
Error: Failed to load url ./langgraph-state.js
```

- [ ] **Step 4: Implement LangGraph state contracts**

Create `packages/agent-core/src/langgraph-state.ts`:

```ts
import { Annotation } from '@langchain/langgraph';

import type { AgentRoute, ChatRequest, ChatResponse } from '@xxyy/shared';

export const AGENT_MAX_STEPS_DEFAULT = 4;

export const ALLOWED_AGENT_TOOL_NAMES = [
  'answer_product_question',
  'analyze_transaction',
  'boundary_reply',
  'clarify_request',
] as const;

export type AllowedAgentToolName = (typeof ALLOWED_AGENT_TOOL_NAMES)[number];

export type AgentMessage = {
  role: 'assistant' | 'system' | 'tool' | 'user';
  content: string;
};

export type PlannerRoute =
  | 'boundary'
  | 'clarify'
  | 'product_answer'
  | 'transaction_analysis'
  | 'unsupported';

export type AgentPlan =
  | {
      kind: 'tool';
      reason: string;
      route: PlannerRoute;
      toolName: AllowedAgentToolName;
      input: unknown;
    }
  | {
      kind: 'final';
      reason: string;
      route: PlannerRoute;
      response: ChatResponse;
    };

export type AgentToolCallRecord = {
  input: unknown;
  step: number;
  toolName: string;
};

export type AgentToolResultRecord = {
  output: unknown;
  step: number;
  toolName: string;
};

export type AgentEvidence =
  | {
      kind: 'chat_response';
      response: ChatResponse;
      toolName: string;
    }
  | {
      kind: 'tx_analysis';
      output: unknown;
      toolName: string;
    };

export type AgentPolicyDecision =
  | {
      action: 'continue';
    }
  | {
      action: 'final';
      response: ChatResponse;
    };

export type AgentState = {
  currentStep: number;
  errors: string[];
  evidence: AgentEvidence[];
  finalResponse?: ChatResponse;
  maxSteps: number;
  messages: AgentMessage[];
  plan?: AgentPlan;
  policyDecision?: AgentPolicyDecision;
  request: ChatRequest;
  route?: AgentRoute;
  toolCalls: AgentToolCallRecord[];
  toolResults: AgentToolResultRecord[];
};

export const AgentStateAnnotation = Annotation.Root({
  currentStep: Annotation<number>({
    default: () => 0,
    reducer: (_left, right) => right,
  }),
  errors: Annotation<string[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  evidence: Annotation<AgentEvidence[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  finalResponse: Annotation<ChatResponse | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  maxSteps: Annotation<number>({
    default: () => AGENT_MAX_STEPS_DEFAULT,
    reducer: (_left, right) => right,
  }),
  messages: Annotation<AgentMessage[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  plan: Annotation<AgentPlan | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  policyDecision: Annotation<AgentPolicyDecision | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  request: Annotation<ChatRequest>({
    reducer: (_left, right) => right,
  }),
  route: Annotation<AgentRoute | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  toolCalls: Annotation<AgentToolCallRecord[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  toolResults: Annotation<AgentToolResultRecord[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
});

export function createInitialAgentState(
  request: ChatRequest,
  options: { maxSteps?: number } = {},
): AgentState {
  return {
    currentStep: 0,
    errors: [],
    evidence: [],
    maxSteps: options.maxSteps ?? AGENT_MAX_STEPS_DEFAULT,
    messages: [{ role: 'user', content: request.message }],
    request,
    toolCalls: [],
    toolResults: [],
  };
}

export function isAllowedAgentToolName(name: string): name is AllowedAgentToolName {
  return ALLOWED_AGENT_TOOL_NAMES.includes(name as AllowedAgentToolName);
}

export function normalizeAgentRoute(route: PlannerRoute): AgentRoute {
  if (route === 'unsupported') {
    return 'clarify';
  }
  return route;
}
```

- [ ] **Step 5: Run state tests to verify pass**

Run:

```bash
pnpm test packages/agent-core/src/langgraph-state.test.ts
```

Expected:

```text
PASS  packages/agent-core/src/langgraph-state.test.ts
```

- [ ] **Step 6: Write failing planner model tests**

Create `packages/agent-core/src/planner-model.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import {
  PlannerModelParseError,
  createOpenAiCompatiblePlannerModel,
  createScriptedPlannerModel,
} from './planner-model.js';

describe('planner model', () => {
  it('returns scripted plans in order for deterministic graph tests', async () => {
    const planner = createScriptedPlannerModel([
      {
        input: { channel: 'web', question: 'XXYY Pro 有哪些权益？' },
        kind: 'tool',
        reason: 'product question',
        route: 'product_answer',
        toolName: 'answer_product_question',
      },
    ]);

    await expect(
      planner.plan({
        request: { channel: 'web', message: 'XXYY Pro 有哪些权益？' },
        stateSummary: 'no tools called',
        tools: [],
      }),
    ).resolves.toMatchObject({
      kind: 'tool',
      route: 'product_answer',
      toolName: 'answer_product_question',
    });
  });

  it('parses OpenAI-compatible JSON planner responses', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  input: { channel: 'web', question: 'XXYY Pro 有哪些权益？' },
                  kind: 'tool',
                  reason: 'product question',
                  route: 'product_answer',
                  toolName: 'answer_product_question',
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl,
      model: 'test-model',
    });

    await expect(
      planner.plan({
        request: { channel: 'web', message: 'XXYY Pro 有哪些权益？' },
        stateSummary: 'no tools called',
        tools: [
          {
            description: 'Answer product questions.',
            name: 'answer_product_question',
          },
        ],
      }),
    ).resolves.toMatchObject({
      kind: 'tool',
      route: 'product_answer',
      toolName: 'answer_product_question',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('throws a planner parse error for unusable model output', async () => {
    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
          status: 200,
        }),
      model: 'test-model',
    });

    await expect(
      planner.plan({
        request: { channel: 'web', message: 'hello' },
        stateSummary: 'no tools called',
        tools: [],
      }),
    ).rejects.toBeInstanceOf(PlannerModelParseError);
  });
});
```

- [ ] **Step 7: Run planner tests to verify failure**

Run:

```bash
pnpm test packages/agent-core/src/planner-model.test.ts
```

Expected:

```text
FAIL  packages/agent-core/src/planner-model.test.ts
Error: Failed to load url ./planner-model.js
```

- [ ] **Step 8: Implement planner model**

Create `packages/agent-core/src/planner-model.ts`:

```ts
import { z } from 'zod';

import type { ChatRequest } from '@xxyy/shared';

import type { AgentPlan, AllowedAgentToolName, PlannerRoute } from './langgraph-state.js';

export interface PlannerToolDescriptor {
  name: string;
  description: string;
}

export interface PlannerModelInput {
  request: ChatRequest;
  stateSummary: string;
  tools: PlannerToolDescriptor[];
}

export interface PlannerModel {
  plan(input: PlannerModelInput): Promise<AgentPlan>;
}

export interface OpenAiCompatiblePlannerModelOptions {
  apiKey: string | undefined;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  model: string | undefined;
  requestTimeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

const plannerRouteSchema = z.enum([
  'boundary',
  'clarify',
  'product_answer',
  'transaction_analysis',
  'unsupported',
]);

const allowedToolNameSchema = z.enum([
  'answer_product_question',
  'analyze_transaction',
  'boundary_reply',
  'clarify_request',
]);

const plannerToolPlanSchema = z.object({
  input: z.unknown(),
  kind: z.literal('tool'),
  reason: z.string().trim().min(1),
  route: plannerRouteSchema,
  toolName: allowedToolNameSchema,
});

const plannerFinalPlanSchema = z.object({
  kind: z.literal('final'),
  reason: z.string().trim().min(1),
  response: z.object({
    answer: z.string(),
    citations: z.array(z.unknown()).default([]),
    confidence: z.number(),
    intent: z.enum([
      'product_qa',
      'how_to',
      'tx_sandwich_detection',
      'realtime_account_query',
      'mev_or_chain_forensics',
      'investment_advice',
      'unknown',
    ]),
  }),
  route: plannerRouteSchema,
});

const plannerPlanSchema = z.discriminatedUnion('kind', [
  plannerToolPlanSchema,
  plannerFinalPlanSchema,
]);

export class PlannerConfigurationError extends Error {}

export class PlannerModelParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerModelParseError';
  }
}

export class PlannerModelRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerModelRequestError';
  }
}

export function createScriptedPlannerModel(plans: AgentPlan[]): PlannerModel {
  const remaining = [...plans];
  return {
    async plan() {
      const next = remaining.shift();
      if (next === undefined) {
        throw new PlannerModelParseError('Scripted planner did not have another plan.');
      }
      return next;
    },
  };
}

export function createOpenAiCompatiblePlannerModel(
  options: OpenAiCompatiblePlannerModelOptions,
): PlannerModel {
  if (options.apiKey === undefined || options.apiKey.trim().length === 0) {
    throw new PlannerConfigurationError('OPENAI_API_KEY is required for agent planning.');
  }
  if (options.model === undefined || options.model.trim().length === 0) {
    throw new PlannerConfigurationError('OPENAI_MODEL is required for agent planning.');
  }

  const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    async plan(input) {
      const response = await fetchWithTimeout(fetchImpl, endpoint, {
        apiKey: options.apiKey as string,
        body: createPlannerRequestBody(options.model as string, input),
        requestTimeoutMs,
      });
      const payload = (await response.json()) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (content === undefined) {
        throw new PlannerModelParseError('Planner response did not include message content.');
      }
      return parsePlannerContent(content);
    },
  };
}

function createPlannerRequestBody(model: string, input: PlannerModelInput): Record<string, unknown> {
  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You are the XXYY customer support agent planner.',
          'Return only a JSON object matching one of these shapes:',
          '{"kind":"tool","route":"product_answer|transaction_analysis|boundary|clarify|unsupported","toolName":"answer_product_question|analyze_transaction|boundary_reply|clarify_request","input":{},"reason":"..."}',
          '{"kind":"final","route":"boundary|clarify|unsupported","response":{"answer":"...","intent":"unknown","citations":[],"confidence":0.3},"reason":"..."}',
          'Never request account, order, wallet, balance, private transaction, or investment-advice tools.',
          'Use product tools for XXYY product questions.',
          'Use transaction analysis only for a single concrete transaction hash or supported explorer link.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          request: input.request,
          stateSummary: input.stateSummary,
          tools: input.tools,
        }),
      },
    ],
  };
}

function parsePlannerContent(content: string): AgentPlan {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonFence(content));
  } catch (error) {
    throw new PlannerModelParseError(`Planner returned invalid JSON: ${String(error)}`);
  }

  const parsed = plannerPlanSchema.safeParse(value);
  if (!parsed.success) {
    throw new PlannerModelParseError(parsed.error.message);
  }

  return parsed.data as AgentPlan;
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed.replace(/^```(?:json)?/u, '').replace(/```$/u, '').trim();
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  endpoint: string,
  options: {
    apiKey: string;
    body: Record<string, unknown>;
    requestTimeoutMs: number;
  },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      body: JSON.stringify(options.body),
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PlannerModelRequestError(`Planner request failed with status ${response.status}.`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 9: Run planner tests to verify pass**

Run:

```bash
pnpm test packages/agent-core/src/planner-model.test.ts
```

Expected:

```text
PASS  packages/agent-core/src/planner-model.test.ts
```

- [ ] **Step 10: Commit task 1**

Run:

```bash
git add packages/agent-core/package.json packages/agent-core/src/langgraph-state.ts packages/agent-core/src/langgraph-state.test.ts packages/agent-core/src/planner-model.ts packages/agent-core/src/planner-model.test.ts pnpm-lock.yaml
git commit -m "feat: add langgraph planner contracts"
```

Expected:

```text
[main <hash>] feat: add langgraph planner contracts
```

---

### Task 2: Make Tool Registry Context-Aware And Trim First-Slice Tools

**Files:**
- Modify: `packages/agent-core/src/tool-registry.ts`
- Modify: `packages/agent-core/src/tool-registry.test.ts`
- Modify: `packages/agent-core/src/tools/tx-analysis-tools.ts`
- Modify: `packages/agent-core/src/tools/tx-analysis-tools.test.ts`
- Modify: `packages/agent-core/src/index.ts`

- [ ] **Step 1: Write failing tool registry context tests**

Add this case to `packages/agent-core/src/tool-registry.test.ts`:

```ts
it('passes tool context into execute handlers', async () => {
  const registry = createToolRegistry();
  const calls: unknown[] = [];

  registry.register({
    name: 'context_tool',
    description: 'Use context.',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ ok: z.literal(true) }),
    policy: { allowExternalMcp: false, requiresOpsAuth: false },
    execute(input, context) {
      calls.push({ context, input });
      return { ok: true };
    },
  });

  await expect(
    registry.execute('context_tool', { value: 'x' }, { channel: 'web', requestId: 'req-1' }),
  ).resolves.toEqual({ ok: true });

  expect(calls).toEqual([
    {
      context: { channel: 'web', requestId: 'req-1' },
      input: { value: 'x' },
    },
  ]);
});
```

- [ ] **Step 2: Run registry tests to verify failure**

Run:

```bash
pnpm test packages/agent-core/src/tool-registry.test.ts
```

Expected:

```text
FAIL  packages/agent-core/src/tool-registry.test.ts
Expected ... context ...
```

- [ ] **Step 3: Update tool registry types and implementation**

Modify `packages/agent-core/src/tool-registry.ts` so the relevant declarations read:

```ts
export interface ToolContext {
  channel?: string;
  requestId?: string;
  sessionId?: string;
  userIdPresent?: boolean;
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
  execute: (
    input: z.output<InputSchema>,
    context: ToolContext,
  ) => z.input<OutputSchema> | Promise<z.input<OutputSchema>>;
}

type RegisteredToolDefinition = Omit<ToolDefinition, 'execute'> & {
  execute: (input: unknown, context: ToolContext) => unknown;
};

export interface ToolRegistry {
  execute(name: string, input: unknown, context?: ToolContext): Promise<z.output<z.ZodType>>;
  get(name: string): ToolDefinition | undefined;
  list(options?: ListToolsOptions): ToolDefinition[];
  register<Name extends string, InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
    definition: ToolDefinition<Name, InputSchema, OutputSchema>,
  ): void;
}
```

Then change `execute` inside `createToolRegistry()` to:

```ts
async execute(name, input, context = {}) {
  const definition = tools.get(name);
  if (!definition) {
    throw new ToolRegistryToolNotFoundError(name);
  }

  const parsedInput = definition.inputSchema.parse(input);
  const output = await definition.execute(parsedInput, context);
  return definition.outputSchema.parse(output);
},
```

- [ ] **Step 4: Run registry tests to verify pass**

Run:

```bash
pnpm test packages/agent-core/src/tool-registry.test.ts
```

Expected:

```text
PASS  packages/agent-core/src/tool-registry.test.ts
```

- [ ] **Step 5: Trim tx-analysis tools to first-slice runtime tools**

Modify `packages/agent-core/src/tools/tx-analysis-tools.ts`:

```ts
export const TX_ANALYSIS_TOOL_NAMES = ['analyze_transaction'] as const;
```

Remove these exports and definitions from the file:

```ts
getAnalysisReportInputSchema
getAnalysisReportOutputSchema
listAnalysisReportsInputSchema
listAnalysisReportsOutputSchema
GetAnalysisReportToolDefinition
ListAnalysisReportsToolDefinition
getAnalysisReportTool
listAnalysisReportsTool
toReportFindOptions
```

Keep `CreateTxAnalysisToolsOptions.reportReader` out of the first-slice type:

```ts
export interface CreateTxAnalysisToolsOptions {
  provider: TxAnalysisProvider | undefined;
}
```

`createTxAnalysisTools()` should return:

```ts
return [analyzeTransactionTool];
```

- [ ] **Step 6: Update tx-analysis tool tests**

In `packages/agent-core/src/tools/tx-analysis-tools.test.ts`, keep tests that assert `analyze_transaction` behavior. Remove tests that assert report list or report document tools. Add this assertion:

```ts
expect(createTxAnalysisTools({ provider: undefined }).map((tool) => tool.name)).toEqual([
  'analyze_transaction',
]);
```

- [ ] **Step 7: Update public exports**

Modify the tx-analysis export block in `packages/agent-core/src/index.ts` to remove report schemas:

```ts
export {
  TX_ANALYSIS_TOOL_NAMES,
  analyzeTransactionInputSchema,
  analyzeTransactionOutputSchema,
  createTxAnalysisTools,
  toRagAnalyzeTransactionInput,
} from './tools/tx-analysis-tools.js';
```

Ensure the type export block remains:

```ts
export type {
  AnalyzeTransactionToolInput,
  AnalyzeTransactionToolOutput,
  CreateTxAnalysisToolsOptions,
  TxAnalysisToolChannel,
  TxAnalysisToolName,
} from './tools/tx-analysis-tools.js';
```

- [ ] **Step 8: Run agent-core tool tests**

Run:

```bash
pnpm test packages/agent-core/src/tool-registry.test.ts packages/agent-core/src/tools/tx-analysis-tools.test.ts packages/agent-core/src/tools/product-tools.test.ts
```

Expected:

```text
PASS  packages/agent-core/src/tool-registry.test.ts
PASS  packages/agent-core/src/tools/tx-analysis-tools.test.ts
PASS  packages/agent-core/src/tools/product-tools.test.ts
```

- [ ] **Step 9: Commit task 2**

Run:

```bash
git add packages/agent-core/src/tool-registry.ts packages/agent-core/src/tool-registry.test.ts packages/agent-core/src/tools/tx-analysis-tools.ts packages/agent-core/src/tools/tx-analysis-tools.test.ts packages/agent-core/src/index.ts
git commit -m "refactor: prepare agent tools for langgraph"
```

Expected:

```text
[main <hash>] refactor: prepare agent tools for langgraph
```

---

### Task 3: Build The LangGraph Customer Runtime

**Files:**
- Create: `packages/agent-core/src/langgraph-customer-runtime.ts`
- Create: `packages/agent-core/src/langgraph-customer-runtime.test.ts`
- Modify: `packages/agent-core/src/customer-agent-chat-service.ts`
- Modify: `packages/agent-core/src/index.ts`

- [ ] **Step 1: Write failing LangGraph runtime tests**

Create `packages/agent-core/src/langgraph-customer-runtime.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChatResponse } from '@xxyy/shared';
import type { AnalyzeTransactionOutput } from '@xxyy/rag-core';

import { createScriptedPlannerModel } from './planner-model.js';
import { createLangGraphCustomerRuntime } from './langgraph-customer-runtime.js';
import { createToolRegistry } from './tool-registry.js';

const toolPolicy = {
  allowExternalMcp: true,
  requiresOpsAuth: false,
};

describe('createLangGraphCustomerRuntime', () => {
  it('plans and executes product RAG answers', async () => {
    const registry = createToolRegistry();
    const productResponse: ChatResponse = {
      answer: 'XXYY Pro 提供更高监控上限。',
      citations: [
        {
          excerpt: 'XXYY Pro 提供更高监控上限。',
          file: 'docs/product-features/pro.md',
          title: 'XXYY Pro',
        },
      ],
      confidence: 0.86,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(productResponse));

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

    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { channel: 'web', question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'product question',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    });

    await expect(
      runtime.ask({ channel: 'web', message: 'XXYY Pro 有哪些权益？' }),
    ).resolves.toEqual({
      ...productResponse,
      agentRoute: 'product_answer',
    });
    expect(execute).toHaveBeenCalledWith(
      { channel: 'web', question: 'XXYY Pro 有哪些权益？' },
      expect.objectContaining({ channel: 'web' }),
    );
  });

  it('plans and executes transaction analysis', async () => {
    const registry = createToolRegistry();
    const txOutput: AnalyzeTransactionOutput = {
      result: {
        analyzedAt: '2026-06-20T00:00:00.000Z',
        chain: 'base',
        confidence: 0.91,
        evidence: [{ detail: '前后腿匹配。', label: '规则证据', severity: 'critical' }],
        relatedTransactions: [],
        summary: '检测到疑似夹子交易。',
        txHash: '0xabc',
        verdict: 'sandwiched',
      },
      status: 'success',
    };
    const execute = vi.fn(() => Promise.resolve(txOutput));

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute,
    });

    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { txHash: '0xabc' },
          kind: 'tool',
          reason: 'transaction hash',
          route: 'transaction_analysis',
          toolName: 'analyze_transaction',
        },
      ]),
      registry,
    });

    const response = await runtime.ask({ channel: 'web', message: '0xabc' });

    expect(response).toMatchObject({
      agentRoute: 'transaction_analysis',
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('检测到疑似夹子交易');
    expect(execute).toHaveBeenCalledWith(
      { txHash: '0xabc' },
      expect.objectContaining({ channel: 'web' }),
    );
  });

  it('blocks account balance requests before planner tool execution', async () => {
    const registry = createToolRegistry();
    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: {},
          kind: 'tool',
          reason: 'should not run',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    });

    await expect(runtime.ask({ channel: 'web', message: '帮我查一下钱包余额' })).resolves.toMatchObject({
      agentRoute: 'boundary',
      citations: [],
      intent: 'realtime_account_query',
    });
  });

  it('returns a safe clarification when planner requests an unauthorized tool', async () => {
    const registry = createToolRegistry();
    const runtime = createLangGraphCustomerRuntime({
      planner: {
        async plan() {
          return {
            input: {},
            kind: 'tool',
            reason: 'bad tool',
            route: 'unsupported',
            toolName: 'delete_user_wallet' as never,
          };
        },
      },
      registry,
    });

    await expect(runtime.ask({ channel: 'web', message: 'do something unsafe' })).resolves.toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      confidence: 0.2,
      intent: 'unknown',
    });
  });
});
```

- [ ] **Step 2: Run LangGraph runtime tests to verify failure**

Run:

```bash
pnpm test packages/agent-core/src/langgraph-customer-runtime.test.ts
```

Expected:

```text
FAIL  packages/agent-core/src/langgraph-customer-runtime.test.ts
Error: Failed to load url ./langgraph-customer-runtime.js
```

- [ ] **Step 3: Implement LangGraph runtime**

Create `packages/agent-core/src/langgraph-customer-runtime.ts`:

```ts
import { END, START, StateGraph } from '@langchain/langgraph';

import type { ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import {
  classifyQuestion,
  createBoundaryAnswer,
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  type AnalyzeTransactionOutput,
} from '@xxyy/rag-core';

import {
  AgentStateAnnotation,
  createInitialAgentState,
  isAllowedAgentToolName,
  normalizeAgentRoute,
  type AgentPlan,
  type AgentState,
} from './langgraph-state.js';
import type { PlannerModel } from './planner-model.js';
import type { ToolRegistry } from './tool-registry.js';

export interface CustomerAgentRuntime {
  ask(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export interface CreateLangGraphCustomerRuntimeOptions {
  maxSteps?: number;
  planner: PlannerModel;
  registry: ToolRegistry;
}

type GraphState = typeof AgentStateAnnotation.State;

export function createLangGraphCustomerRuntime(
  options: CreateLangGraphCustomerRuntimeOptions,
): CustomerAgentRuntime {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('policy_guard', policyGuardNode)
    .addNode('planner', plannerNode(options))
    .addNode('tool_executor', toolExecutorNode(options))
    .addNode('answer_composer', answerComposerNode)
    .addEdge(START, 'policy_guard')
    .addConditionalEdges('policy_guard', routeAfterPolicyGuard)
    .addConditionalEdges('planner', routeAfterPlanner)
    .addConditionalEdges('tool_executor', routeAfterToolExecutor)
    .addEdge('answer_composer', END)
    .compile();

  async function ask(request: ChatRequest): Promise<ChatResponse> {
    const result = await graph.invoke(createInitialAgentState(request, { maxSteps: options.maxSteps }));
    return result.finalResponse ?? createAgentFailureAnswer('agent_finished_without_response');
  }

  return {
    ask,
    async *stream(request) {
      yield* streamChatResponse(await ask(request));
    },
  };
}

function policyGuardNode(state: GraphState): Partial<AgentState> {
  const classification = classifyQuestion(state.request.message);
  if (
    classification.intent === 'realtime_account_query' ||
    classification.intent === 'investment_advice' ||
    classification.intent === 'mev_or_chain_forensics'
  ) {
    return {
      finalResponse: withAgentRoute(createBoundaryAnswer(classification), 'boundary'),
      policyDecision: { action: 'final', response: createBoundaryAnswer(classification) },
      route: 'boundary',
    };
  }
  return { policyDecision: { action: 'continue' } };
}

function plannerNode(options: CreateLangGraphCustomerRuntimeOptions) {
  return async (state: GraphState): Promise<Partial<AgentState>> => {
    if (state.currentStep >= state.maxSteps) {
      return {
        errors: ['agent_step_limit_reached'],
        finalResponse: createAgentFailureAnswer('agent_step_limit_reached'),
        route: 'clarify',
      };
    }

    const plan = await options.planner.plan({
      request: state.request,
      stateSummary: summarizeStateForPlanner(state),
      tools: options.registry
        .list()
        .filter((tool) => isAllowedAgentToolName(tool.name))
        .map((tool) => ({ description: tool.description, name: tool.name })),
    });

    return {
      currentStep: state.currentStep + 1,
      plan,
      route: normalizeAgentRoute(plan.route),
    };
  };
}

function toolExecutorNode(options: CreateLangGraphCustomerRuntimeOptions) {
  return async (state: GraphState): Promise<Partial<AgentState>> => {
    const plan = state.plan;
    if (plan?.kind !== 'tool') {
      return {};
    }
    if (!isAllowedAgentToolName(plan.toolName)) {
      return {
        errors: [`unauthorized_tool:${String(plan.toolName)}`],
        finalResponse: createAgentFailureAnswer('unauthorized_tool'),
        route: 'clarify',
      };
    }

    const output = await options.registry.execute(plan.toolName, plan.input, {
      channel: state.request.channel,
      sessionId: state.request.sessionId,
      userIdPresent: state.request.userId !== undefined,
    });

    return {
      evidence: [toEvidence(plan, output)],
      toolCalls: [{ input: plan.input, step: state.currentStep, toolName: plan.toolName }],
      toolResults: [{ output, step: state.currentStep, toolName: plan.toolName }],
    };
  };
}

function answerComposerNode(state: GraphState): Partial<AgentState> {
  if (state.finalResponse !== undefined) {
    return {};
  }

  const lastEvidence = state.evidence.at(-1);
  if (lastEvidence?.kind === 'chat_response') {
    return {
      finalResponse: withAgentRoute(lastEvidence.response, state.route ?? 'product_answer'),
    };
  }

  if (lastEvidence?.kind === 'tx_analysis') {
    const output = lastEvidence.output as AnalyzeTransactionOutput;
    const response =
      output.status === 'success'
        ? createTxAnalysisAnswer(output.result)
        : createTxAnalysisUnavailableAnswer(output.failure.reason, {
            ...(output.failure.metadata === undefined ? {} : { metadata: output.failure.metadata }),
            ...(output.failure.reportUrl === undefined ? {} : { reportUrl: output.failure.reportUrl }),
          });
    return { finalResponse: withAgentRoute(response, 'transaction_analysis') };
  }

  const plan = state.plan;
  if (plan?.kind === 'final') {
    return {
      finalResponse: withAgentRoute(plan.response, normalizeAgentRoute(plan.route)),
    };
  }

  return {
    finalResponse: createAgentFailureAnswer('missing_evidence'),
    route: 'clarify',
  };
}

function routeAfterPolicyGuard(state: GraphState): string {
  return state.policyDecision?.action === 'final' ? 'answer_composer' : 'planner';
}

function routeAfterPlanner(state: GraphState): string {
  if (state.finalResponse !== undefined) {
    return 'answer_composer';
  }
  return state.plan?.kind === 'tool' ? 'tool_executor' : 'answer_composer';
}

function routeAfterToolExecutor(): string {
  return 'answer_composer';
}

function toEvidence(plan: AgentPlan, output: unknown): AgentState['evidence'][number] {
  if (plan.toolName === 'answer_product_question' || plan.toolName === 'boundary_reply' || plan.toolName === 'clarify_request') {
    return { kind: 'chat_response', response: output as ChatResponse, toolName: plan.toolName };
  }
  return { kind: 'tx_analysis', output, toolName: plan.toolName };
}

function summarizeStateForPlanner(state: GraphState): string {
  return JSON.stringify({
    currentStep: state.currentStep,
    evidenceCount: state.evidence.length,
    lastTool: state.toolResults.at(-1)?.toolName,
    request: state.request.message,
  });
}

function createAgentFailureAnswer(reason: string): ChatResponse {
  return {
    answer: `当前无法可靠完成这个请求（${reason}）。请补充更明确的 XXYY 产品问题，或发送单笔受支持链的交易哈希。`,
    citations: [],
    confidence: 0.2,
    intent: 'unknown',
  };
}

function withAgentRoute(response: ChatResponse, agentRoute: ChatResponse['agentRoute']): ChatResponse {
  return { ...response, agentRoute };
}

async function* streamChatResponse(response: ChatResponse): AsyncIterable<ChatStreamEvent> {
  yield { type: 'answer_delta', delta: response.answer };
  yield {
    type: 'metadata',
    agentRoute: response.agentRoute,
    attachments: response.attachments,
    citations: response.citations,
    confidence: response.confidence,
    intent: response.intent,
    tokenUsage: response.tokenUsage,
  };
}
```

- [ ] **Step 4: Run LangGraph runtime tests**

Run:

```bash
pnpm test packages/agent-core/src/langgraph-customer-runtime.test.ts
```

Expected:

```text
PASS  packages/agent-core/src/langgraph-customer-runtime.test.ts
```

- [ ] **Step 5: Switch chat service to LangGraph runtime**

Modify `packages/agent-core/src/customer-agent-chat-service.ts` imports:

```ts
import {
  createLangGraphCustomerRuntime,
  type CustomerAgentRuntime,
} from './langgraph-customer-runtime.js';
import { createOpenAiCompatiblePlannerModel, type PlannerModel } from './planner-model.js';
```

Update `CreateCustomerAgentChatServiceOptions`:

```ts
export interface CreateCustomerAgentChatServiceOptions {
  answerProvider: AnswerProvider;
  config?: Partial<RagConfig>;
  index?: RagIndex;
  planner?: PlannerModel;
  retriever?: Retriever;
  txAnalysisProvider: TxAnalysisProvider | undefined;
}
```

Remove `audit`, `qualityConfidenceThreshold`, `qualitySignals`, `sessionContext`, and `txAnalysisReportReader` from this first-slice options interface.

At the end of `createCustomerAgentChatService`, return:

```ts
return createLangGraphCustomerRuntime({
  planner:
    options.planner ??
    createOpenAiCompatiblePlannerModel({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL,
    }),
  registry,
});
```

Register tx tools with:

```ts
for (const tool of createTxAnalysisTools({
  provider: options.txAnalysisProvider,
})) {
  registry.register(tool);
}
```

- [ ] **Step 6: Update exports**

In `packages/agent-core/src/index.ts`, add:

```ts
export { createLangGraphCustomerRuntime } from './langgraph-customer-runtime.js';
export type {
  CreateLangGraphCustomerRuntimeOptions,
  CustomerAgentRuntime,
} from './langgraph-customer-runtime.js';
export {
  createOpenAiCompatiblePlannerModel,
  createScriptedPlannerModel,
  PlannerConfigurationError,
  PlannerModelParseError,
  PlannerModelRequestError,
} from './planner-model.js';
export type {
  OpenAiCompatiblePlannerModelOptions,
  PlannerModel,
  PlannerModelInput,
  PlannerToolDescriptor,
} from './planner-model.js';
export {
  AGENT_MAX_STEPS_DEFAULT,
  ALLOWED_AGENT_TOOL_NAMES,
  AgentStateAnnotation,
  createInitialAgentState,
  isAllowedAgentToolName,
  normalizeAgentRoute,
} from './langgraph-state.js';
export type {
  AgentEvidence,
  AgentMessage,
  AgentPlan,
  AgentPolicyDecision,
  AgentState,
  AgentToolCallRecord,
  AgentToolResultRecord,
  AllowedAgentToolName,
  PlannerRoute,
} from './langgraph-state.js';
```

- [ ] **Step 7: Run service tests and adjust expected behavior**

Run:

```bash
pnpm test packages/agent-core/src/customer-agent-chat-service.test.ts packages/agent-core/src/langgraph-customer-runtime.test.ts
```

Expected first run:

```text
FAIL  packages/agent-core/src/customer-agent-chat-service.test.ts
```

Update `packages/agent-core/src/customer-agent-chat-service.test.ts`:

- Pass `planner: createScriptedPlannerModel([...])` into product path tests.
- Remove the session context follow-up test because first-slice LangGraph Agent does not keep long-term session context.
- Keep boundary test.

Use this product test planner:

```ts
planner: createScriptedPlannerModel([
  {
    input: { channel: 'web', question: 'XXYY Pro 有哪些权益？' },
    kind: 'tool',
    reason: 'product question',
    route: 'product_answer',
    toolName: 'answer_product_question',
  },
])
```

- [ ] **Step 8: Run all agent-core runtime tests**

Run:

```bash
pnpm test packages/agent-core/src/langgraph-state.test.ts packages/agent-core/src/planner-model.test.ts packages/agent-core/src/langgraph-customer-runtime.test.ts packages/agent-core/src/customer-agent-chat-service.test.ts
```

Expected:

```text
PASS  packages/agent-core/src/langgraph-state.test.ts
PASS  packages/agent-core/src/planner-model.test.ts
PASS  packages/agent-core/src/langgraph-customer-runtime.test.ts
PASS  packages/agent-core/src/customer-agent-chat-service.test.ts
```

- [ ] **Step 9: Commit task 3**

Run:

```bash
git add packages/agent-core/src/langgraph-customer-runtime.ts packages/agent-core/src/langgraph-customer-runtime.test.ts packages/agent-core/src/customer-agent-chat-service.ts packages/agent-core/src/customer-agent-chat-service.test.ts packages/agent-core/src/index.ts
git commit -m "feat: add langgraph customer runtime"
```

Expected:

```text
[main <hash>] feat: add langgraph customer runtime
```

---

### Task 4: Remove Deprecated Agent-Core Runtime, Session, Audit, Quality, And Knowledge-Ops Code

**Files:**
- Delete: deprecated agent-core files listed in File Structure
- Modify: `packages/agent-core/src/index.ts`
- Modify: `packages/agent-core/tsconfig.json` only if deleted tests were explicitly listed
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Delete deprecated agent-core files**

Run:

```bash
rm packages/agent-core/src/customer-agent-runtime.ts \
  packages/agent-core/src/customer-agent-runtime.test.ts \
  packages/agent-core/src/answer-planner.ts \
  packages/agent-core/src/answer-planner.test.ts \
  packages/agent-core/src/follow-up-resolver.ts \
  packages/agent-core/src/follow-up-resolver.test.ts \
  packages/agent-core/src/session-context.ts \
  packages/agent-core/src/session-context.test.ts \
  packages/agent-core/src/pg-session-context.ts \
  packages/agent-core/src/pg-session-context.test.ts \
  packages/agent-core/src/audit.ts \
  packages/agent-core/src/audit.test.ts \
  packages/agent-core/src/quality-signals.ts \
  packages/agent-core/src/quality-signals.test.ts \
  packages/agent-core/src/knowledge-ops-agent-runtime.ts \
  packages/agent-core/src/knowledge-ops-agent-runtime.test.ts \
  packages/agent-core/src/tools/knowledge-ops-tools.ts \
  packages/agent-core/src/tools/knowledge-ops-tools.test.ts
```

Expected:

```text
```

- [ ] **Step 2: Remove deleted exports**

In `packages/agent-core/src/index.ts`, remove all export blocks that reference:

```ts
answer-planner
audit
customer-agent-runtime
follow-up-resolver
knowledge-ops-agent-runtime
quality-signals
pg-session-context
session-context
tools/knowledge-ops-tools
```

Keep only:

```ts
export const workspacePackageName = '@xxyy/agent-core';
```

and exports for:

```ts
customer-agent-chat-service
langgraph-customer-runtime
langgraph-state
planner-model
tool-registry
tools/product-tools
tools/tx-analysis-tools
```

- [ ] **Step 3: Remove `preference_capture` from shared routes**

Modify `packages/shared/src/index.ts`:

```ts
export const supportedAgentRoutes = [
  'boundary',
  'clarify',
  'product_answer',
  'transaction_analysis',
] as const;
```

- [ ] **Step 4: Search for deleted symbol references**

Run:

```bash
rg "createInMemoryAuditSink|createNoopAuditSink|createPgToolAuditSink|summarizePgToolAudit|createInMemoryQualitySignalSink|QualitySignal|createPgSessionContextStore|summarizePgSessionContext|createKnowledgeOpsAgentRuntime|createKnowledgeOpsTools|preference_capture" packages apps scripts
```

Expected:

```text
apps/api/src/index.ts
packages/product-qa-mcp/src/quality-signals.ts
packages/tx-analysis-mcp/src/quality-signals.ts
```

The remaining app/MCP references are removed in later tasks.

- [ ] **Step 5: Run typecheck to expose next dependent cleanup**

Run:

```bash
pnpm --filter @xxyy/agent-core typecheck
```

Expected:

```text
PASS
```

If TypeScript reports deleted exports from `index.ts`, remove the named export and rerun the same command until it passes.

- [ ] **Step 6: Commit task 4**

Run:

```bash
git add packages/agent-core packages/shared/src/index.ts
git commit -m "refactor: remove heavy agent-core surfaces"
```

Expected:

```text
[main <hash>] refactor: remove heavy agent-core surfaces
```

---

### Task 5: Simplify API To Chat, Stream, Direct TX Analysis, Health, And Assets

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/index.test.ts`
- Modify: `apps/api/package.json` if dependency graph changes
- Modify: `apps/web` files that call `/api/feedback`

- [ ] **Step 1: Remove ops and feedback imports from API**

In `apps/api/src/index.ts`, remove imports from `@xxyy/knowledge-ops`. Remove these `@xxyy/agent-core` imports:

```ts
createInMemoryQualitySignalSink
createInMemorySessionContextStore
createNoopAuditSink
createPgSessionContextStore
createPgToolAuditSink
sanitizeSessionText
summarizePgSessionContext
summarizePgToolAudit
PgSessionContextOpsSummary
PgToolAuditOpsSummary
QualitySignalSink
SessionContextStore
ToolAuditSink
```

Remove these `@xxyy/rag-core` imports if they are used only by ops/feedback/report review:

```ts
captureAnswerQualitySignals
createPgKnowledgeOpsStore
createPgFeedbackStore
findFileTxAnalysisReports
getFileTxAnalysisReportDocument
summarizeFileTxAnalysisReports
updateFileTxAnalysisReportReview
RecordFeedbackInput
FeedbackStats
FindTxAnalysisReportsOptions
KnowledgeStats
PgFeedbackStore
SummarizeTxAnalysisReportsOptions
TxAnalysisReportIndexEntry
TxAnalysisReportReview
TxAnalysisReportReviewStatus
TxAnalysisReportSummary
TxAnalysisStoredReportDocument
UpdateTxAnalysisReportReviewInput
```

Remove `renderOpsPage` from the `@xxyy/web` import.

- [ ] **Step 2: Simplify API env and options types**

Change `ApiEnv` to:

```ts
type ApiEnv = RagEnv &
  Partial<
    Record<
      | 'API_CORS_ORIGIN'
      | 'API_MAX_BODY_BYTES'
      | 'API_RATE_LIMIT_MAX'
      | 'API_RATE_LIMIT_WINDOW_MS'
      | 'PORT',
      string
    >
  >;
```

Change `CreateRequestHandlerOptions` to remove:

```ts
getKnowledgeCandidateStore
getOpsSummary
getTxAnalysisReportStore
recordFeedback
recordFeedbackCandidate
renderOpsHtml
```

Keep:

```ts
export interface CreateRequestHandlerOptions {
  cwd?: string;
  env?: ApiEnv;
  getChatService?: () => Promise<ChatService>;
  getHealthStatus?: () => Promise<DeepHealthStatus>;
  logger?: ApiLogger;
  now?: () => number;
  renderHtml?: () => string;
  staticAssetsDir?: string;
}
```

- [ ] **Step 3: Delete ops, feedback, candidate, and report review route handlers**

In the request router inside `createRequestHandler`, remove branches for:

```text
GET /ops
GET /api/ops/summary
POST /api/feedback
GET /api/knowledge/candidates
POST /api/knowledge/candidates/:id/review
PATCH /api/tx-analysis/reports/:id/review
PATCH /api/tx-analysis/reports/review
GET /api/tx-analysis/reports
GET /api/tx-analysis/reports/summary
GET /api/tx-analysis/reports/:id
```

Keep branches for:

```text
GET /
GET /health
GET /health/deep
POST /api/chat
POST /api/chat/stream
POST /api/tx-analysis
GET /assets/*
```

- [ ] **Step 4: Simplify chat service factory**

Where API creates the chat service, pass only first-slice options:

```ts
return createCustomerAgentChatService({
  answerProvider,
  config,
  retriever,
  txAnalysisProvider,
});
```

Do not pass audit, qualitySignals, sessionContext, or txAnalysisReportReader.

- [ ] **Step 5: Remove feedback UI calls**

Search:

```bash
rg "api/feedback|feedback" apps/web apps/api
```

Remove browser code that posts to `/api/feedback`. If the chat UI has feedback buttons, remove the buttons and related state so the UI does not call a deleted endpoint.

- [ ] **Step 6: Update API tests**

In `apps/api/src/index.test.ts`:

- Delete tests for `/ops`, `/api/ops/summary`, `/api/feedback`, knowledge candidates, report review, report list, report summary, and report detail.
- Keep tests for `/health`, `/health/deep`, `/api/chat`, `/api/chat/stream`, `/api/tx-analysis`, static assets, CORS, body limit, and rate limiting.
- Add an assertion that `/ops` now returns 404:

```ts
it('does not expose the ops page in the first LangGraph slice', async () => {
  const response = createMockResponse();
  await handler(createMockRequest({ method: 'GET', url: '/ops' }), response);
  expect(response.statusCode).toBe(404);
});
```

- [ ] **Step 7: Run API tests**

Run:

```bash
pnpm test apps/api/src/index.test.ts
```

Expected:

```text
PASS  apps/api/src/index.test.ts
```

- [ ] **Step 8: Commit task 5**

Run:

```bash
git add apps/api/src/index.ts apps/api/src/index.test.ts apps/web
git commit -m "refactor: trim api to agentic rag surface"
```

Expected:

```text
[main <hash>] refactor: trim api to agentic rag surface
```

---

### Task 6: Remove Knowledge-Ops Packages, Skills, And Scripts

**Files:**
- Delete: `packages/knowledge-ops`
- Delete: `packages/knowledge-ops-mcp`
- Delete: `skills/xxyy-knowledge-ops`
- Modify/Delete: `skills/xxyy-autonomous-answering-agent`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml` if needed after package deletion
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/index.test.ts`

- [ ] **Step 1: Remove package scripts**

Modify root `package.json` scripts so the removed entries are gone:

```json
{
  "scripts": {
    "agent:smoke": "node scripts/agent-smoke.mjs",
    "check": "pnpm lint && pnpm format:check && pnpm typecheck && pnpm test",
    "dev": "pnpm start",
    "format": "prettier --write \"**/*.{ts,js,mjs,cjs,json,md,yml,yaml}\" \".vscode/*.json\"",
    "format:check": "prettier --check \"**/*.{ts,js,mjs,cjs,json,md,yml,yaml}\" \".vscode/*.json\"",
    "lint": "eslint . --max-warnings=0",
    "lint:fix": "eslint . --fix",
    "rag:ask": "pnpm --filter @xxyy/cli rag:ask",
    "rag:ingest": "pnpm --filter @xxyy/cli rag:ingest",
    "rag:migrate": "pnpm --filter @xxyy/cli rag:migrate",
    "rag:stats": "pnpm --filter @xxyy/cli rag:stats",
    "rag:sync:x": "pnpm --filter @xxyy/cli rag:sync:x",
    "product:mcp": "pnpm --filter @xxyy/product-qa-mcp start",
    "start": "node scripts/start-agent.mjs",
    "start:service": "pnpm --filter @xxyy/api start",
    "sync": "node scripts/rag-refresh.mjs",
    "test": "vitest run",
    "tx:mcp": "pnpm --filter @xxyy/tx-analysis-mcp start",
    "tx:mcp:smoke": "node scripts/tx-analysis-mcp-smoke.mjs",
    "typecheck": "pnpm typecheck:root && pnpm -r --if-present --filter \"@xxyy/*\" typecheck",
    "typecheck:root": "tsc --noEmit -p tsconfig.json",
    "x:scrape": "node scripts/fetch-usexxyy-posts.mjs"
  }
}
```

Keep other top-level metadata unchanged.

- [ ] **Step 2: Remove CLI commands for deleted workflows**

In `apps/cli/src/index.ts`, remove command handlers and imports for:

```text
rag:sync:telegram
rag:publish:knowledge
rag:gate:knowledge
rag:feedback
rag:evaluate
```

Keep command handlers for:

```text
rag:ask
rag:ingest
rag:migrate
rag:stats
rag:sync:x
```

Update `apps/cli/src/index.test.ts` by deleting tests for the removed commands and keeping tests for retained commands.

- [ ] **Step 3: Delete packages and skills**

Run:

```bash
rm -rf packages/knowledge-ops packages/knowledge-ops-mcp skills/xxyy-knowledge-ops skills/xxyy-autonomous-answering-agent
```

Expected:

```text
```

- [ ] **Step 4: Remove references to deleted packages**

Run:

```bash
rg "@xxyy/knowledge-ops|knowledge-ops|xxyy-knowledge-ops|xxyy-autonomous-answering-agent|rag:sync:telegram|rag:publish:knowledge|rag:gate:knowledge|rag:feedback|rag:evaluate" .
```

Expected remaining references before docs task:

```text
docs/superpowers/specs/2026-06-20-lightweight-rag-mcp-design.md
docs/superpowers/plans/2026-06-20-langgraph-agentic-rag.md
```

If code references remain outside docs, remove the import, script, test, or export.

- [ ] **Step 5: Run CLI and workspace checks**

Run:

```bash
pnpm test apps/cli/src/index.test.ts
pnpm typecheck
```

Expected:

```text
PASS  apps/cli/src/index.test.ts
```

and:

```text
pnpm typecheck exits 0
```

- [ ] **Step 6: Commit task 6**

Run:

```bash
git add package.json pnpm-lock.yaml apps/cli packages skills
git commit -m "refactor: remove knowledge ops workflows"
```

Expected:

```text
[main <hash>] refactor: remove knowledge ops workflows
```

---

### Task 7: Add Lightweight Agent Smoke

**Files:**
- Create: `scripts/agent-smoke.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create smoke script**

Create `scripts/agent-smoke.mjs`:

```js
#!/usr/bin/env node

const baseUrl = process.env.API_SMOKE_BASE_URL ?? 'http://127.0.0.1:3000';

async function main() {
  await expectStatus('/health', 200);
  await expectChat({
    message: process.env.API_SMOKE_PRODUCT_QUESTION ?? 'XXYY Pro 有哪些权益？',
    expectedRoute: 'product_answer',
  });
  await expectChat({
    message: process.env.API_SMOKE_BOUNDARY_QUESTION ?? '帮我查一下钱包余额',
    expectedRoute: 'boundary',
  });

  const txHash = process.env.API_SMOKE_TX_HASH;
  if (txHash) {
    await expectChat({
      message: txHash,
      expectedRoute: 'transaction_analysis',
    });
  }

  console.log('agent smoke passed');
}

async function expectStatus(path, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`);
  if (response.status !== expectedStatus) {
    throw new Error(`${path} expected ${expectedStatus}, got ${response.status}`);
  }
}

async function expectChat({ expectedRoute, message }) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    body: JSON.stringify({ channel: 'web', message }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const payload = await response.json();
  if (response.status !== 200) {
    throw new Error(`/api/chat returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (payload.agentRoute !== expectedRoute) {
    throw new Error(
      `/api/chat expected agentRoute ${expectedRoute}, got ${payload.agentRoute}: ${JSON.stringify(payload)}`,
    );
  }
  if (typeof payload.answer !== 'string' || payload.answer.trim().length === 0) {
    throw new Error(`/api/chat returned empty answer: ${JSON.stringify(payload)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 2: Ensure root script exists**

Confirm root `package.json` has:

```json
{
  "scripts": {
    "agent:smoke": "node scripts/agent-smoke.mjs"
  }
}
```

- [ ] **Step 3: Run smoke script against missing server to verify useful failure**

Run:

```bash
pnpm agent:smoke
```

Expected if no server is running:

```text
fetch failed
```

This failure is acceptable at this step because the script is meant for a running API.

- [ ] **Step 4: Commit task 7**

Run:

```bash
git add scripts/agent-smoke.mjs package.json
git commit -m "test: add agent smoke script"
```

Expected:

```text
[main <hash>] test: add agent smoke script
```

---

### Task 8: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/feature-status.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Update README positioning**

In `README.md`, replace the first paragraph with:

```md
XXYY 客服 Agentic RAG 项目。当前目标是做 LangGraph 驱动的产品客服 Agent：自动同步官方 X / Twitter 和产品文档知识库，自动回答 XXYY 产品问题，并在交易哈希、未来池子查询和链上分析等特定问题上自主规划调用工具。
```

Remove README sections that describe:

```text
ops 页面
knowledge candidates
Telegram support sync
feedback candidate generation
approved-only publish/gate
tool audit cost budget
session context ops
```

Keep sections that describe:

```text
pnpm start
pnpm sync
rag:ingest
rag:sync:x
rag:ask
product:mcp
tx:mcp
GET /health
GET /health/deep
POST /api/chat
POST /api/tx-analysis
```

- [ ] **Step 2: Update AGENTS.md**

In `AGENTS.md`, replace the project goal section with:

```md
这是 XXYY 客服 Agentic RAG 系统。当前阶段使用 LangGraph JS 作为 Agent Runtime：产品问题调用 Product RAG，交易哈希调用交易分析工具，未来扩展交易池子查询和链上分析工具。系统会自动根据官方 X / Twitter 和产品文档更新知识库。
```

Remove instructions for:

```text
TELEGRAM_*
API_OPS_TOKEN
API_TOOL_AUDIT_*
rag:sync:telegram
rag:publish:knowledge
rag:gate:knowledge
rag:feedback
rag:evaluate
ops:smoke
ops 页面
```

Keep instructions for:

```text
POSTGRES_*
OPENAI_*
RAG_TOP_K
RAG_ANSWER_PROVIDER
TX_ANALYSIS_*
API_CORS_ORIGIN
API_MAX_BODY_BYTES
API_RATE_LIMIT_*
pnpm start
pnpm sync
pnpm check
agent:smoke
```

- [ ] **Step 3: Update feature and roadmap docs**

In `docs/feature-status.md` and `docs/roadmap.md`:

- Mark LangGraph Agentic RAG first slice as planned/in progress.
- Remove completed claims for ops, knowledge ops, feedback candidates, session context ops, tool audit ops, and eval failure clustering.
- Keep X sync, Product RAG, MCP, and transaction analysis status.

- [ ] **Step 4: Search for stale command names**

Run:

```bash
rg "ops:|knowledge-ops|rag:sync:telegram|rag:publish:knowledge|rag:gate:knowledge|rag:feedback|rag:evaluate|API_OPS_TOKEN|API_TOOL_AUDIT|TELEGRAM_" README.md AGENTS.md docs package.json
```

Expected remaining references:

```text
docs/superpowers/specs/2026-06-20-lightweight-rag-mcp-design.md
docs/superpowers/plans/2026-06-20-langgraph-agentic-rag.md
```

- [ ] **Step 5: Commit task 8**

Run:

```bash
git add README.md AGENTS.md docs/feature-status.md docs/roadmap.md
git commit -m "docs: align project docs with langgraph agent"
```

Expected:

```text
[main <hash>] docs: align project docs with langgraph agent
```

---

### Task 9: Final Verification

**Files:**
- No source edits unless verification exposes a defect.

- [ ] **Step 1: Run focused agent tests**

Run:

```bash
pnpm test packages/agent-core/src/langgraph-state.test.ts packages/agent-core/src/planner-model.test.ts packages/agent-core/src/langgraph-customer-runtime.test.ts packages/agent-core/src/customer-agent-chat-service.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 2: Run retained API and CLI tests**

Run:

```bash
pnpm test apps/api/src/index.test.ts apps/cli/src/index.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected:

```text
pnpm typecheck exits 0
```

- [ ] **Step 4: Run full check**

Run:

```bash
pnpm check
```

Expected:

```text
pnpm check exits 0
```

- [ ] **Step 5: Commit verification fixes if any**

If Step 1-4 required fixes, commit them:

```bash
git add .
git commit -m "fix: stabilize langgraph agent migration"
```

Expected if fixes existed:

```text
[main <hash>] fix: stabilize langgraph agent migration
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: LangGraph runtime, planner, tool registry, Product RAG tool, transaction tool, MCP retention, ops removal, knowledge-ops removal, long-term session removal, feedback removal, eval-gate removal, API surface, smoke, docs, and tests are all mapped to tasks.
- Marker scan: The plan contains no incomplete-work markers, no deferred implementation markers, and no unnamed test work.
- Type consistency: Runtime uses `CustomerAgentRuntime`, `ToolRegistry`, `ChatResponse`, and `AgentPlan` consistently across tasks. Tool names match first-slice allowed tools.
- Risk: Task 5 API simplification is the widest edit. Keep it as a separate commit and run `apps/api/src/index.test.ts` immediately after the route cleanup.
