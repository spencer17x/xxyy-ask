# Answer Quality Evaluation and Observability Design

**Date:** 2026-07-11

## Goal

Establish a measurable answer-quality improvement loop for XXYY Ask while retaining the current Postgres + pgvector architecture. The system must separate intent, retrieval, grounding, answer, trajectory, latency, and cost signals; support optional privacy-preserving LangSmith traces; turn failed evaluations and negative feedback into reviewable regression candidates; and keep the default runtime independent of any observability SaaS.

Elasticsearch and Neo4j are explicitly out of scope. They may only be reconsidered after repeatable evaluation data shows that the current retrieval architecture is the bottleneck or the product develops genuine multi-hop graph-query requirements.

## Considered Approaches

### Direct LangSmith instrumentation

Wrap the current LangGraph, planner, retriever, and answer provider directly with LangSmith SDK calls. This gives the fastest hosted trace UI, but couples core packages to one vendor and makes privacy/offline testing harder.

### Vendor-neutral trace contract with optional LangSmith adapter — selected

Introduce a small internal tracing contract with no-op and in-memory implementations, then provide an optional LangSmith adapter at the composition root. Core runtime code emits structured, already-redacted span inputs and outputs without importing LangSmith. This adds a small amount of plumbing but preserves testability, keeps SaaS tracing optional, and allows a future OpenTelemetry adapter without changing Agent/RAG behavior.

### OpenTelemetry-only instrumentation

Emit generic spans to an existing observability backend. This minimizes vendor coupling but does not provide the dataset, experiment, annotation, and evaluator workflow needed for the initial quality loop without building more internal tooling.

## Architecture

### Trace contract

Add a focused quality-observability module in `packages/rag-core` because `agent-core`, API, CLI, and Telegram already depend on it. The contract supports nested asynchronous spans and async-iterable spans:

```ts
interface QualityTracer {
  run<T>(span: QualitySpanInput, task: () => Promise<T>): Promise<T>;
  stream<T>(span: QualitySpanInput, task: () => AsyncIterable<T>): AsyncIterable<T>;
}
```

Every tracer receives structured data that has already passed through the existing sensitive-text redaction. The no-op implementation is the default. An in-memory implementation supports deterministic tests. The LangSmith adapter is loaded only when tracing is explicitly enabled and configured.

The root trace is one chat request. Child spans cover:

1. deterministic guard and intent classification;
2. planner LLM request and parsed plan;
3. tool selection and validated tool execution;
4. query embedding;
5. pgvector candidate retrieval;
6. metadata reranking and grounding selection;
7. answer LLM generation or deterministic fallback;
8. final response metadata.

Span metadata includes request ID, channel, application revision, prompt version, model, embedding model, route, tool name, top K, candidate and selected chunk IDs, retrieval scores, citation IDs, token usage, first-token/total latency where available, and normalized error type. It never includes API keys, user/session identifiers, complete knowledge chunks, or unredacted user content.

### LangSmith configuration

Tracing remains disabled unless all required opt-in configuration is present. Supported configuration:

- `LANGSMITH_TRACING=true`
- `LANGSMITH_API_KEY`
- `LANGSMITH_ENDPOINT`, optional
- `LANGSMITH_PROJECT`, default `xxyy-ask`
- `QUALITY_TRACE_SAMPLE_RATE`, default `0` outside explicit tracing and bounded to `0..1`
- `APP_REVISION`, optional deployment/git identifier

Missing LangSmith configuration must never prevent chat startup when tracing is disabled. When tracing is explicitly enabled but invalid, startup or first composition must fail with a distinct observability configuration error rather than silently dropping all traces.

The adapter applies the same credential, transaction, address, email, and phone redaction already used by the application. Full prompts and knowledge chunks are not attached to traces. Chrome may be used for read-only validation of an authenticated LangSmith project, but code completion and tests must not depend on browser access or a live LangSmith account.

## Evaluation Model

### Case schema

Extend the existing golden case contract without invalidating current JSONL records. New optional fields:

- `referenceFacts`: atomic facts expected in a correct answer;
- `relevantChunkIds`: known relevant chunk IDs for retrieval measurement;
- `forbiddenChunkIds`: stale or misleading chunks that must not be retrieved in the evaluated top K;
- `expectedAgentRoute`: expected `boundary`, `clarify`, or `product_answer` route;
- `expectedToolNames`: expected tool trajectory when a traced runtime is evaluated.

Existing `mustContain`, `mustNotContain`, citation files/titles/URLs, and boundary assertions remain deterministic CI gates.

### Retrieval metrics

Add a retrieval evaluator that receives the case, retriever output, and K. For cases with `relevantChunkIds`, calculate:

- Recall@K;
- Precision@K;
- reciprocal rank;
- nDCG@K using binary relevance;
- forbidden-chunk hit count.

Aggregate metrics are reported only over annotated retrieval cases. Cases without chunk annotations remain answer-only cases and do not dilute retrieval scores.

The provider-backed CLI path evaluates the actual pgvector retriever. The deterministic path uses the current local evaluation index. Retrieval metrics must identify whether an answer failure occurred before generation.

### Answer and trajectory metrics

Keep deterministic answer checks as the required CI gate. Add an optional OpenAI-compatible answer judge interface for release and experiment runs. Its rubric produces bounded JSON scores for:

- correctness against `referenceFacts`;
- groundedness against selected citation excerpts;
- completeness of required facts;
- relevance to the user question;
- safe refusal correctness for boundary cases.

The judge is optional, disabled in `pnpm check`, and invoked only through an explicit CLI flag. It uses `EVAL_JUDGE_MODEL` when configured and otherwise reports a configuration error rather than silently judging with the production answer model. Human review remains authoritative for disputed cases.

Agent trajectory checks compare recorded tool names with `expectedToolNames` where annotated. This is not required for direct deterministic-boundary responses.

## CLI and Failure Feedback Loop

Evolve `rag:evaluate` without changing its cheap default:

```text
pnpm rag:evaluate
pnpm rag:evaluate -- --provider
pnpm rag:evaluate -- --provider --judge
pnpm rag:evaluate -- --provider --failures-out .rag/provider-failures.jsonl
```

The human-readable report includes answer pass counts and, when annotated, retrieval aggregates. Judge metrics appear only when enabled.

`--failures-out` writes review-only JSONL records for failed cases. Each record contains the redacted question, actual intent/route, failure reasons, answer, citations, retrieval chunk IDs/ranks/scores, deterministic and judge scores, and `_review` instructions. The output path must be explicit and remains under ignored `.rag/` by documentation and examples.

The existing `rag:feedback:backlog` remains the path for negative user feedback. Documentation defines one review queue fed by:

1. failed offline/provider evaluations;
2. negative/no-citation feedback backlog;
3. LangSmith traces tagged as errors, low-confidence, product answers with no citations, or failed online evaluator scores.

A reviewer must remove private data, define reference facts and relevant chunks, then promote an item into `docs/eval/golden-qa.jsonl`. No production trace or negative feedback is automatically promoted to a CI fixture.

## Runtime Integration

API, CLI, and Telegram composition roots construct one tracer and inject it into the shared customer Agent service, planner, retriever wrappers, and answer provider. The tracer is optional throughout so existing tests and callers remain source-compatible.

The API keeps its current summary JSON logs. The root trace uses the same request ID, enabling operators to correlate summary logs with detailed spans. Trace failure must not change a successful customer answer unless tracing was explicitly configured in strict startup validation and could not be constructed.

Streaming spans close only after metadata, error, or iterator completion. Cancellation and consumer disconnects are recorded as incomplete/error spans without buffering the entire answer before yielding deltas.

## Privacy and Safety

- Redact before values enter the tracing interface, not only inside a backend adapter.
- Never emit API keys, auth headers, database URLs, private keys, seed phrases, user/session IDs, or full knowledge chunks.
- Use chunk IDs, source type, status, scores, and bounded excerpts only where required by an evaluator.
- Do not send trace data unless tracing is explicitly enabled.
- Support sampling before any trace content is constructed.
- Keep failure artifacts local and ignored by Git.
- Document LangSmith retention and input/output masking settings before production enablement.

## Testing Strategy

Development follows red-green TDD. Tests cover:

- backward-compatible golden case parsing;
- exact Recall@K, Precision@K, reciprocal-rank, nDCG, and forbidden-hit calculations;
- report aggregation excluding unannotated cases;
- review-only failure JSONL generation and redaction;
- no-op, in-memory, sampling, nesting, stream-completion, stream-error, and cancellation tracing;
- LangSmith configuration parsing and disabled-by-default behavior;
- planner, tool, retrieval, rerank, grounding, answer, and final-response span emission;
- no prompt, chunk, credential, user ID, or session ID leakage in emitted trace records;
- optional judge schema parsing, invalid-output handling, timeout/error handling, and explicit-model requirement;
- unchanged chat and streaming behavior when tracing is disabled.

Final verification:

```bash
pnpm rag:evaluate
pnpm check
```

Provider-backed and judge evaluation are run when the configured local environment has the required database and model credentials. Otherwise their configuration and HTTP behavior are verified with deterministic fakes, and the exact live validation command is documented.

## Success Criteria

- Existing 37 golden cases remain valid and the deterministic quality gate remains cheap.
- Annotated cases report reproducible retrieval metrics separately from answer correctness.
- A failed case can be exported as a redacted, reviewable regression candidate.
- Optional judge evaluation produces structured correctness, groundedness, completeness, relevance, and refusal scores without entering the default CI path.
- A single request can produce a nested, privacy-preserving trace across guard, planner, tools, retrieval, grounding, and answer generation.
- Tracing is optional, sampled, disabled by default, and never required for answering.
- Existing API summary logs and request IDs remain compatible.
- No Elasticsearch or Neo4j dependency is introduced.
- Documentation explains configuration, privacy, local failure review, LangSmith experiment workflow, and when retrieval infrastructure should be reconsidered.
- `pnpm check` passes with no new warning.
