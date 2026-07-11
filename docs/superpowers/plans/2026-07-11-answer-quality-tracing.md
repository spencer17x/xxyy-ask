# Answer Quality Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional, sampled, privacy-preserving nested traces across the XXYY request, Agent planner, tools, retrieval, reranking, grounding, and answer generation paths, with a LangSmith adapter that is disabled by default.

**Architecture:** Core packages depend on a vendor-neutral `QualityTracer` contract with no-op, in-memory, and composite implementations. A LangSmith 0.7 adapter lives in `rag-core`, transforms every trace input/output before transmission, and is constructed only at API/CLI/Telegram composition roots from explicit environment configuration.

**Tech Stack:** TypeScript ESM, Node AsyncLocalStorage, LangGraph JS, LangSmith TypeScript SDK, Vitest, pnpm workspace

---

## File Map

- Create `packages/rag-core/src/quality-trace.ts`: trace contracts, no-op, in-memory, composite, and safe summarizers.
- Create `packages/rag-core/src/quality-trace.test.ts`: nesting, concurrency, streaming, errors, cancellation, sampling, and privacy tests.
- Create `packages/rag-core/src/langsmith-quality-trace.ts`: LangSmith adapter and environment configuration.
- Create `packages/rag-core/src/langsmith-quality-trace.test.ts`: disabled/configuration/request-transformation tests.
- Modify `packages/rag-core/package.json` and `pnpm-lock.yaml`: direct `langsmith` dependency.
- Modify `packages/rag-core/src/pgvector-store.ts`: embedding and candidate-retrieval spans.
- Modify `packages/rag-core/src/retriever.ts`: reranking spans.
- Modify `packages/rag-core/src/openai-answer-provider.ts`: grounding and answer-model spans.
- Modify `packages/agent-core/src/planner-model.ts`: planner LLM spans.
- Modify `packages/agent-core/src/tool-registry.ts`: validated tool spans.
- Modify `packages/agent-core/src/langgraph-customer-runtime.ts`: request, guard, route, and final-response spans.
- Modify `packages/agent-core/src/customer-agent-chat-service.ts`: propagate tracer to all Agent components.
- Modify `apps/api/src/index.ts`, `apps/cli/src/index.ts`, and `apps/telegram-bot/src/runtime.ts`: construct and inject one configured tracer.
- Modify `.env.example`, `README.md`, and `docs/production-readiness.md`: configuration, privacy, sampling, and LangSmith operations.

### Task 1: Vendor-Neutral Trace Contract

**Files:**

- Create: `packages/rag-core/src/quality-trace.test.ts`
- Create: `packages/rag-core/src/quality-trace.ts`
- Modify: `packages/rag-core/src/index.ts`

- [ ] **Step 1: Write failing no-op and in-memory tracer tests**

Use this public shape:

```ts
export type QualityRunType = 'chain' | 'embedding' | 'llm' | 'retriever' | 'tool';

export interface QualitySpanInput<T = unknown> {
  inputs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  name: string;
  output?: (value: T) => Record<string, unknown>;
  runType: QualityRunType;
}

export interface QualityStreamSpanInput<T> extends Omit<QualitySpanInput<never>, 'output'> {
  event?: (value: T) => Record<string, unknown> | undefined;
  output?: (events: readonly Record<string, unknown>[]) => Record<string, unknown>;
}

export interface QualityTracer {
  run<T>(span: QualitySpanInput<T>, task: () => Promise<T>): Promise<T>;
  stream<T>(span: QualityStreamSpanInput<T>, task: () => AsyncIterable<T>): AsyncIterable<T>;
}
```

Assert the no-op tracer does not call `span.output`, preserves returned values/events, and preserves thrown errors. Assert the in-memory tracer records nested parent IDs through concurrent async calls, sanitized inputs/outputs, duration, error names, stream completion, stream failure, and iterator early-return as `cancelled`.

Add a composite tracer test proving two recorders receive the same nested spans without executing the underlying task twice.

- [ ] **Step 2: Run trace contract tests and verify RED**

```bash
pnpm exec vitest run packages/rag-core/src/quality-trace.test.ts
```

Expected: FAIL because the trace contract is absent.

- [ ] **Step 3: Implement no-op, in-memory, and composite tracers**

Use `AsyncLocalStorage<string | undefined>` for parent propagation. Export:

```ts
export const noopQualityTracer: QualityTracer;
export function createInMemoryQualityTracer(options?: { now?: () => number }): {
  tracer: QualityTracer;
  records: QualityTraceRecord[];
};
export function composeQualityTracers(tracers: readonly QualityTracer[]): QualityTracer;
```

`stream` must yield immediately, pass each event through `span.event`, retain only the returned bounded summary records needed by `span.output`, and close in `finally`. It must never retain raw events or rebuild the complete answer from deltas. Never serialize task closures, errors with stacks, or arbitrary class instances.

- [ ] **Step 4: Run trace contract tests and typecheck and verify GREEN**

```bash
pnpm exec vitest run packages/rag-core/src/quality-trace.test.ts
pnpm --filter @xxyy/rag-core typecheck
```

Expected: all tests pass.

- [ ] **Step 5: Commit the trace contract**

```bash
git add packages/rag-core/src/quality-trace.ts packages/rag-core/src/quality-trace.test.ts packages/rag-core/src/index.ts
git commit -m "feat: add vendor-neutral quality tracing"
```

### Task 2: Optional LangSmith Adapter

**Files:**

- Create: `packages/rag-core/src/langsmith-quality-trace.test.ts`
- Create: `packages/rag-core/src/langsmith-quality-trace.ts`
- Modify: `packages/rag-core/src/index.ts`
- Modify: `packages/rag-core/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add a direct LangSmith dependency**

```bash
pnpm --filter @xxyy/rag-core add langsmith@^0.7.10
```

Expected: `packages/rag-core/package.json` and `pnpm-lock.yaml` record the direct dependency without changing LangGraph versions.

- [ ] **Step 2: Write failing configuration and adapter tests**

Assert:

- absent/false `LANGSMITH_TRACING` returns the exact no-op tracer without requiring a key;
- enabled tracing without `LANGSMITH_API_KEY` throws `QualityTracingConfigurationError`;
- sample rates outside `0..1` throw;
- project defaults to `xxyy-ask`;
- endpoint and application revision are propagated;
- `Client` receives `tracingSamplingRate`, `hideInputs`, `hideOutputs`, and an anonymizer;
- traceable runs receive only supplied redacted records, never task arguments or raw return values;
- nested and streamed calls keep their values while `processInputs`/`processOutputs` return bounded records.

Use injectable `createClient` and `wrapTraceable` factories so tests make no network requests.

- [ ] **Step 3: Run adapter tests and verify RED**

```bash
pnpm exec vitest run packages/rag-core/src/langsmith-quality-trace.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 4: Implement environment parsing and the adapter**

Expose:

```ts
export type QualityTraceEnv = Record<string, string | undefined>;

export function createQualityTracerFromEnv(
  env: QualityTraceEnv,
  options?: LangSmithQualityTracerDependencies,
): QualityTracer;
```

Construct `Client` with explicit `apiKey`, optional `apiUrl`, `tracingSamplingRate`, `hideInputs` and `hideOutputs` transforms, and the existing sensitive-text redactor. Use `traceable` with `processInputs` and `processOutputs`; wrap raw task results in a private value holder so only `span.output` reaches LangSmith.

For async iterables, use LangSmith's `aggregator` to publish only event count, event types, final metadata summary, and cancellation/error state. Do not aggregate answer deltas into a full unredacted answer.

- [ ] **Step 5: Run adapter tests and all rag-core tests and verify GREEN**

```bash
pnpm exec vitest run packages/rag-core/src/langsmith-quality-trace.test.ts packages/rag-core/src/quality-trace.test.ts
pnpm --filter @xxyy/rag-core typecheck
```

Expected: tests and typecheck pass without network access.

- [ ] **Step 6: Commit the optional adapter**

```bash
git add packages/rag-core/package.json packages/rag-core/src/langsmith-quality-trace.ts packages/rag-core/src/langsmith-quality-trace.test.ts packages/rag-core/src/index.ts pnpm-lock.yaml
git commit -m "feat: add optional LangSmith quality tracer"
```

### Task 3: Retrieval, Rerank, and Answer Spans

**Files:**

- Modify: `packages/rag-core/src/pgvector-store.test.ts`
- Modify: `packages/rag-core/src/pgvector-store.ts`
- Modify: `packages/rag-core/src/reranker.test.ts`
- Modify: `packages/rag-core/src/retriever.ts`
- Modify: `packages/rag-core/src/openai-answer-provider.test.ts`
- Modify: `packages/rag-core/src/openai-answer-provider.ts`

- [ ] **Step 1: Add failing retrieval span tests**

Inject an in-memory tracer and assert one pgvector retrieval emits nested spans:

```text
rag.query_embedding
rag.pgvector_candidates
```

Inputs contain only normalized question length/top K/model metadata. Outputs contain embedding dimension or candidate chunk IDs/ranks/scores/source/status, never query text, embedding vectors, database URLs, or chunk content.

Assert `createRerankingRetriever` emits `rag.metadata_rerank` with pre/post chunk IDs and scores and keeps ranking behavior identical.

- [ ] **Step 2: Run retrieval tests and verify RED**

```bash
pnpm exec vitest run packages/rag-core/src/pgvector-store.test.ts packages/rag-core/src/reranker.test.ts
```

Expected: FAIL because tracer options and spans are absent.

- [ ] **Step 3: Add optional tracer plumbing to retrieval**

Add `tracer?: QualityTracer` to `PgVectorStoreOptions` and `RerankingRetrieverOptions`, defaulting to `noopQualityTracer`. Wrap only the embedding call, candidate SQL/mapping, and reranker call. Use bounded chunk summaries:

```ts
{
  (id, rank, score, lexicalScore, vectorScore, sourceType, status);
}
```

- [ ] **Step 4: Add failing grounding and answer LLM tests**

Assert `createOpenAiAnswerProvider({ tracer })` emits:

```text
rag.grounding_selection
llm.answer
```

Grounding outputs include selected chunk IDs/source/status only. LLM metadata includes model, prompt version, stream flag, token usage, HTTP status, fallback reason, and redacted answer summary; it excludes prompts, API keys, complete chunks, and Authorization headers. Cover non-stream, stream, deterministic fallback, invalid model output, timeout, and stream error.

- [ ] **Step 5: Run answer provider tests and verify RED**

```bash
pnpm exec vitest run packages/rag-core/src/openai-answer-provider.test.ts
```

Expected: FAIL because answer-provider tracing is absent.

- [ ] **Step 6: Implement grounding and answer spans**

Add optional `tracer` and `promptVersion` to `OpenAiAnswerProviderOptions`. Default prompt version to a source-controlled constant. Wrap grounding selection with a resolved promise span and wrap model request/parse or stream iteration without delaying delta delivery.

- [ ] **Step 7: Run retrieval/answer tests and verify GREEN**

```bash
pnpm exec vitest run packages/rag-core/src/pgvector-store.test.ts packages/rag-core/src/reranker.test.ts packages/rag-core/src/openai-answer-provider.test.ts
pnpm --filter @xxyy/rag-core typecheck
```

Expected: all tests pass and existing retrieval/answer outputs remain identical.

- [ ] **Step 8: Commit RAG spans**

```bash
git add packages/rag-core/src/pgvector-store.ts packages/rag-core/src/pgvector-store.test.ts packages/rag-core/src/retriever.ts packages/rag-core/src/reranker.test.ts packages/rag-core/src/openai-answer-provider.ts packages/rag-core/src/openai-answer-provider.test.ts
git commit -m "feat: trace retrieval grounding and answer generation"
```

### Task 4: Planner, Tool, and Request Spans

**Files:**

- Modify: `packages/agent-core/src/planner-model.test.ts`
- Modify: `packages/agent-core/src/planner-model.ts`
- Modify: `packages/agent-core/src/tool-registry.test.ts`
- Modify: `packages/agent-core/src/tool-registry.ts`
- Modify: `packages/agent-core/src/langgraph-customer-runtime.test.ts`
- Modify: `packages/agent-core/src/langgraph-customer-runtime.ts`
- Modify: `packages/agent-core/src/customer-agent-chat-service.test.ts`
- Modify: `packages/agent-core/src/customer-agent-chat-service.ts`

- [ ] **Step 1: Add failing planner and tool trace tests**

Assert the planner emits `llm.planner` with redacted question, state counters, allowed tool names, model, prompt version, and parsed plan summary. It must not emit system prompt text, API keys, user/session IDs, or raw response content.

Assert registry execution and streaming emit `agent.tool` spans after schema validation with tool name, channel, request ID, safe input keys, outcome, and output citation/chunk counts. Invalid input should fail before a successful tool span is recorded.

- [ ] **Step 2: Run planner/tool tests and verify RED**

```bash
pnpm exec vitest run packages/agent-core/src/planner-model.test.ts packages/agent-core/src/tool-registry.test.ts
```

Expected: FAIL because tracer options are absent.

- [ ] **Step 3: Implement planner and tool spans**

Add optional tracer and prompt version to `OpenAiCompatiblePlannerModelOptions`. Add optional tracer to `createToolRegistry`. Keep schema parsing inside the span but emit only safe summaries.

- [ ] **Step 4: Add failing root request and guard tests**

Inject an in-memory tracer into `createLangGraphCustomerRuntime`. Assert:

- a boundary request emits `chat.request`, `agent.classify`, and `agent.guard`, but no planner/tool span;
- a product request nests planner/tool/RAG spans below `chat.request`;
- final root output includes route, intent, confidence, citation count, attachment count, and token usage only;
- streaming closes after metadata, records cancellation, and never buffers or records complete raw deltas;
- concurrent requests retain independent parent trees by request ID.

- [ ] **Step 5: Run runtime tests and verify RED**

```bash
pnpm exec vitest run packages/agent-core/src/langgraph-customer-runtime.test.ts packages/agent-core/src/customer-agent-chat-service.test.ts
```

Expected: FAIL because runtime tracer plumbing is absent.

- [ ] **Step 6: Implement root, classification, guard, route, and final spans**

Add `tracer?: QualityTracer` to runtime and customer-service options and pass it to registry, planner, product tools, and runtime. Use request ID as metadata; record only booleans for session/user presence. Keep all public response and stream event contracts unchanged.

- [ ] **Step 7: Run all agent-core tests and typecheck and verify GREEN**

```bash
pnpm exec vitest run packages/agent-core/src
pnpm --filter @xxyy/agent-core typecheck
```

Expected: all tests pass.

- [ ] **Step 8: Commit Agent spans**

```bash
git add packages/agent-core/src/planner-model.ts packages/agent-core/src/planner-model.test.ts packages/agent-core/src/tool-registry.ts packages/agent-core/src/tool-registry.test.ts packages/agent-core/src/langgraph-customer-runtime.ts packages/agent-core/src/langgraph-customer-runtime.test.ts packages/agent-core/src/customer-agent-chat-service.ts packages/agent-core/src/customer-agent-chat-service.test.ts
git commit -m "feat: trace agent planning and tool execution"
```

### Task 5: Composition Roots and Evaluation Trajectory

**Files:**

- Modify: `apps/api/src/index.test.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/telegram-bot/src/runtime.test.ts`
- Modify: `apps/telegram-bot/src/runtime.ts`
- Modify: `apps/cli/src/index.test.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add failing composition tests**

Assert API, Telegram, and CLI construct one tracer from environment and inject that same instance into pgvector, reranker, planner, tools, answer provider, and root runtime. Disabled tracing must not construct a LangSmith client. Enabled invalid tracing must produce `QualityTracingConfigurationError` with no secret values.

For provider-backed CLI evaluation, compose the configured tracer with an in-memory tracer, assign `requestId: eval:<case-name>`, and use captured `agent.tool` and retrieval records to populate `expectedToolNames` and retrieval observations.

- [ ] **Step 2: Run composition tests and verify RED**

```bash
pnpm exec vitest run apps/api/src/index.test.ts apps/telegram-bot/src/runtime.test.ts apps/cli/src/index.test.ts
```

Expected: FAIL because composition roots do not construct or inject tracing.

- [ ] **Step 3: Implement one-tracer composition**

Load these environment values in `.env.example` and composition roots:

```text
LANGSMITH_TRACING=false
LANGSMITH_API_KEY=
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_PROJECT=xxyy-ask
QUALITY_TRACE_SAMPLE_RATE=
APP_REVISION=
EVAL_JUDGE_MODEL=
```

Create the tracer before lazy providers so every later dependency receives the same instance. Disabled tracing remains no-op and must not require or contact LangSmith.

Treat an omitted `QUALITY_TRACE_SAMPLE_RATE` as `1` only when `LANGSMITH_TRACING=true`; tracing disabled still produces the no-op tracer. An explicit `0` is allowed as an operational kill switch. Document this distinction so copying the example does not silently discard all enabled traces.

- [ ] **Step 4: Run app tests, typechecks, and deterministic eval and verify GREEN**

```bash
pnpm exec vitest run apps/api/src/index.test.ts apps/telegram-bot/src/runtime.test.ts apps/cli/src/index.test.ts
pnpm typecheck
pnpm rag:evaluate
```

Expected: all tests pass and 37/37 deterministic cases remain green.

- [ ] **Step 5: Commit runtime composition**

```bash
git add apps/api/src/index.ts apps/api/src/index.test.ts apps/telegram-bot/src/runtime.ts apps/telegram-bot/src/runtime.test.ts apps/cli/src/index.ts apps/cli/src/index.test.ts .env.example
git commit -m "feat: wire optional quality tracing into runtimes"
```

### Task 6: Tracing Operations and End-to-End Verification

**Files:**

- Modify: `README.md`
- Modify: `docs/production-readiness.md`
- Modify: `docs/eval/README.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Document privacy-safe LangSmith operations**

Document disabled-by-default configuration, sampling, project naming, app/prompt revision tags, masking, retention review, local and provider-backed commands, failure trace filtering, promotion to golden QA, and the fact that raw prompts/chunks and user/session IDs are intentionally absent.

- [ ] **Step 2: Run full repository verification**

```bash
pnpm check
```

Expected: Web build, lint, format check, workspace typecheck, all Vitest suites, and 37 deterministic QA cases pass.

- [ ] **Step 3: Run a local no-network trace smoke test**

Use fake planner, embedding, database, and answer-provider dependencies with the in-memory tracer to execute one product request and one boundary request. Assert the product tree contains request, classification, planner or deterministic product plan, tool, embedding, pgvector, rerank, grounding, answer, and final spans; assert the boundary tree contains no external dependency span.

- [ ] **Step 4: Perform optional Chrome validation only when an authenticated LangSmith session is available**

Open the configured LangSmith project read-only, verify one deliberately sanitized test trace has the expected nested span names and no raw prompt/chunk/user identifier, then close the tab. If no authenticated project or API key is available, record that live cloud validation was not required and rely on the fake-client HTTP contract and local trace smoke test.

- [ ] **Step 5: Commit operations documentation**

```bash
git add README.md docs/production-readiness.md docs/eval/README.md docs/roadmap.md
git commit -m "docs: operate the answer quality tracing loop"
```
