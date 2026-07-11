# Answer Quality Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing deterministic golden QA into layered answer, retrieval, judge, trajectory, and reviewable-failure evaluation without changing the default cheap CI path.

**Architecture:** Keep `evaluateCases` as the deterministic answer gate, add a separate retrieval-metrics module and optional OpenAI-compatible judge, and let CLI orchestration combine their results. Failed results are exported only through an explicit path as redacted review candidates; current golden records remain backward compatible.

**Tech Stack:** TypeScript ESM, Vitest, Node `fetch`, Postgres/pgvector retriever contract, pnpm workspace

---

## File Map

- Modify `packages/rag-core/src/evaluate.ts`: richer case/result observations and route/tool checks.
- Create `packages/rag-core/src/retrieval-evaluate.ts`: deterministic per-case and aggregate retrieval metrics.
- Create `packages/rag-core/src/retrieval-evaluate.test.ts`: metric boundary and aggregation coverage.
- Create `packages/rag-core/src/answer-quality-judge.ts`: optional OpenAI-compatible judge contract/provider.
- Create `packages/rag-core/src/answer-quality-judge.test.ts`: judge configuration, request, parsing, and error coverage.
- Create `packages/rag-core/src/evaluation-failures.ts`: redacted review-only JSONL records.
- Create `packages/rag-core/src/evaluation-failures.test.ts`: failure filtering and privacy coverage.
- Modify `packages/rag-core/src/index.ts`: export new evaluation APIs and types.
- Modify `apps/cli/src/index.ts`: parse evaluation flags, run retrieval/judge layers, and write explicit failure artifacts.
- Modify `apps/cli/src/index.test.ts`: CLI parsing, report formatting, and output tests.
- Modify `docs/eval/golden-qa.jsonl`: annotate a focused subset with reference facts and relevant chunk IDs.
- Modify `docs/eval/README.md`: document layered metrics and review workflow.

### Task 1: Retrieval Metrics

**Files:**

- Create: `packages/rag-core/src/retrieval-evaluate.test.ts`
- Create: `packages/rag-core/src/retrieval-evaluate.ts`
- Modify: `packages/rag-core/src/index.ts`

- [ ] **Step 1: Write failing metric tests**

Cover one ranked list with relevant IDs `b` and `d`, forbidden ID `legacy`, and retrieved IDs `a,b,legacy,d` at K=4. Assert:

```ts
expect(result).toMatchObject({
  annotated: true,
  forbiddenHitCount: 1,
  ndcgAtK: expect.closeTo((1 / Math.log2(3) + 1 / Math.log2(5)) / (1 + 1 / Math.log2(3))),
  precisionAtK: 0.5,
  recallAtK: 1,
  reciprocalRank: 0.5,
  retrievedChunkIds: ['a', 'b', 'legacy', 'd'],
});
```

Also assert that an unannotated case returns `{ annotated: false }`, a missing relevant document produces zero metrics, duplicate relevant IDs are normalized, K is bounded to the supplied ranked list, and aggregate averages exclude unannotated cases.

- [ ] **Step 2: Run the new test and verify RED**

```bash
pnpm exec vitest run packages/rag-core/src/retrieval-evaluate.test.ts
```

Expected: FAIL because `evaluateRetrievalRanking` and `aggregateRetrievalResults` do not exist.

- [ ] **Step 3: Implement deterministic metric types and functions**

Create these public contracts:

```ts
export interface RetrievalEvaluationInput {
  forbiddenChunkIds?: readonly string[];
  relevantChunkIds?: readonly string[];
  retrievedChunkIds: readonly string[];
  topK: number;
}

export interface RetrievalEvaluationResult {
  annotated: boolean;
  forbiddenHitCount?: number;
  ndcgAtK?: number;
  precisionAtK?: number;
  recallAtK?: number;
  reciprocalRank?: number;
  retrievedChunkIds: string[];
  topK: number;
}

export interface RetrievalEvaluationSummary {
  annotatedCaseCount: number;
  averageNdcgAtK?: number;
  averagePrecisionAtK?: number;
  averageRecallAtK?: number;
  meanReciprocalRank?: number;
  totalForbiddenHits: number;
}
```

Use binary relevance and standard discounted cumulative gain `1 / log2(rank + 1)`. Round public aggregate values to six decimals and do not invent zero averages when no case is annotated.

- [ ] **Step 4: Run metric tests and rag-core typecheck and verify GREEN**

```bash
pnpm exec vitest run packages/rag-core/src/retrieval-evaluate.test.ts
pnpm --filter @xxyy/rag-core typecheck
```

Expected: all metric tests pass and typecheck exits 0.

- [ ] **Step 5: Commit retrieval metrics**

```bash
git add packages/rag-core/src/retrieval-evaluate.ts packages/rag-core/src/retrieval-evaluate.test.ts packages/rag-core/src/index.ts
git commit -m "feat: add layered retrieval evaluation metrics"
```

### Task 2: Evaluation Observations and Trajectory Checks

**Files:**

- Modify: `packages/rag-core/src/evaluate.test.ts`
- Modify: `packages/rag-core/src/evaluate.ts`

- [ ] **Step 1: Add failing compatibility and observation tests**

Extend a test case with:

```ts
referenceFacts: ['5000个地址'],
expectedAgentRoute: 'product_answer',
expectedToolNames: ['answer_product_question'],
relevantChunkIds: ['chunk-current'],
forbiddenChunkIds: ['chunk-old'],
```

Run `evaluateCases` with an observer returning:

```ts
{
  retrievedChunkIds: ['chunk-current'],
  toolNames: ['answer_product_question'],
}
```

Assert the result retains the response, route, reference facts, tool names, and retrieval ranking. Add failures for route mismatch and tool trajectory mismatch while proving an old case without the new fields still passes unchanged.

- [ ] **Step 2: Run evaluate tests and verify RED**

```bash
pnpm exec vitest run packages/rag-core/src/evaluate.test.ts
```

Expected: FAIL because the extended case/result fields and observation callback are absent.

- [ ] **Step 3: Extend evaluation contracts without breaking old cases**

Add optional case fields:

```ts
expectedAgentRoute?: AgentRoute;
expectedToolNames?: string[];
forbiddenChunkIds?: string[];
referenceFacts?: string[];
relevantChunkIds?: string[];
```

Add:

```ts
export interface EvaluationObservation {
  retrievedChunkIds?: string[];
  toolNames?: string[];
}

export interface EvaluationResult {
  // existing fields
  response: ChatResponse;
  retrievedChunkIds: string[];
  toolNames: string[];
}
```

Extend `EvaluateCasesOptions` with `observe?(testCase, response): EvaluationObservation | Promise<EvaluationObservation>`. Check route and exact ordered tool names only when the case declares expectations.

- [ ] **Step 4: Run evaluate and package tests and verify GREEN**

```bash
pnpm exec vitest run packages/rag-core/src/evaluate.test.ts
pnpm --filter @xxyy/rag-core typecheck
```

Expected: all tests pass with old and new case shapes.

- [ ] **Step 5: Commit richer evaluation observations**

```bash
git add packages/rag-core/src/evaluate.ts packages/rag-core/src/evaluate.test.ts
git commit -m "feat: capture answer quality evaluation observations"
```

### Task 3: Optional OpenAI-Compatible Answer Judge

**Files:**

- Create: `packages/rag-core/src/answer-quality-judge.test.ts`
- Create: `packages/rag-core/src/answer-quality-judge.ts`
- Modify: `packages/rag-core/src/index.ts`

- [ ] **Step 1: Write failing judge provider tests**

Assert missing `EVAL_JUDGE_MODEL` produces `AnswerJudgeConfigurationError`. With a fake fetch, assert one `/chat/completions` request uses `temperature: 0`, `response_format: { type: 'json_object' }`, a fixed evaluation system prompt, redacted question/answer, reference facts, citation excerpts, and no API key in the body.

Return this fake model content and assert exact parsing:

```json
{
  "correctness": 0.9,
  "groundedness": 1,
  "completeness": 0.8,
  "relevance": 0.95,
  "safeRefusal": 1,
  "reason": "The required fact is present and cited."
}
```

Add tests rejecting scores outside `0..1`, missing fields, invalid JSON, non-2xx responses, and timeouts.

- [ ] **Step 2: Run judge tests and verify RED**

```bash
pnpm exec vitest run packages/rag-core/src/answer-quality-judge.test.ts
```

Expected: FAIL because the judge module does not exist.

- [ ] **Step 3: Implement the judge contract and provider**

Expose:

```ts
export interface AnswerQualityScores {
  completeness: number;
  correctness: number;
  groundedness: number;
  reason: string;
  relevance: number;
  safeRefusal: number;
}

export interface AnswerQualityJudge {
  judge(input: AnswerQualityJudgeInput): Promise<AnswerQualityScores>;
}
```

Use the existing `redactSensitiveSupportText` before constructing the body. Validate response fields manually to avoid adding Zod only for one parser. Use the configured judge model only; never silently fall back to `OPENAI_MODEL`.

- [ ] **Step 4: Run judge tests and typecheck and verify GREEN**

```bash
pnpm exec vitest run packages/rag-core/src/answer-quality-judge.test.ts
pnpm --filter @xxyy/rag-core typecheck
```

Expected: all tests pass.

- [ ] **Step 5: Commit optional judge support**

```bash
git add packages/rag-core/src/answer-quality-judge.ts packages/rag-core/src/answer-quality-judge.test.ts packages/rag-core/src/index.ts
git commit -m "feat: add optional answer quality judge"
```

### Task 4: Redacted Failure Candidate Export

**Files:**

- Create: `packages/rag-core/src/evaluation-failures.test.ts`
- Create: `packages/rag-core/src/evaluation-failures.ts`
- Modify: `packages/rag-core/src/index.ts`

- [ ] **Step 1: Write failing JSONL export tests**

Create one passing and one failing `EvaluationResult`. Put an API key, email, EVM address, and transaction hash in the failed question/answer. Assert only the failing record is emitted, `_review.reviewRequired` is true, failure reasons and observed citations/ranks/scores are retained, and all sensitive values are replaced by existing redaction markers.

- [ ] **Step 2: Run failure export tests and verify RED**

```bash
pnpm exec vitest run packages/rag-core/src/evaluation-failures.test.ts
```

Expected: FAIL because `formatEvaluationFailureJsonl` does not exist.

- [ ] **Step 3: Implement review-only failure records**

Expose `formatEvaluationFailureJsonl(report, options)` and return an empty string when no result failed. Each record contains only:

```ts
{
  _review: {
    failureReasons,
    observedAnswer,
    observedAgentRoute,
    observedCitations,
    retrievedChunkIds,
    reviewRequired: true,
    source: 'rag_evaluate',
    toolNames,
  },
  boundaryExpected,
  expectedAgentRoute,
  expectedIntent,
  name,
  question,
  referenceFacts,
  relevantChunkIds,
}
```

Run all string values through the existing redactor and never include session/user IDs or complete retrieved chunk text.

- [ ] **Step 4: Run export tests and verify GREEN**

```bash
pnpm exec vitest run packages/rag-core/src/evaluation-failures.test.ts
pnpm --filter @xxyy/rag-core typecheck
```

Expected: all tests pass.

- [ ] **Step 5: Commit failure feedback export**

```bash
git add packages/rag-core/src/evaluation-failures.ts packages/rag-core/src/evaluation-failures.test.ts packages/rag-core/src/index.ts
git commit -m "feat: export failed evaluations for review"
```

### Task 5: CLI Layered Evaluation

**Files:**

- Modify: `apps/cli/src/index.test.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add failing CLI argument and report tests**

Assert these parses:

```ts
parseCliArgs(['evaluate']);
// { command: 'evaluate', providerBacked: false, judge: false }

parseCliArgs(['evaluate', '--provider', '--judge', '--failures-out', '.rag/failures.jsonl']);
// { command: 'evaluate', providerBacked: true, judge: true, failuresOut: '.rag/failures.jsonl' }
```

Reject `--judge` without `--provider`, a missing failures path, an output path outside `.rag`, and unknown flags. Add report tests showing retrieval aggregates and judge averages only when present.

- [ ] **Step 2: Run CLI tests and verify RED**

```bash
pnpm exec vitest run apps/cli/src/index.test.ts
```

Expected: FAIL because layered flags and report sections are absent.

- [ ] **Step 3: Implement evaluation option parsing and orchestration**

Replace the evaluate command variant with:

```ts
{
  command: 'evaluate';
  failuresOut?: string;
  judge: boolean;
  providerBacked: boolean;
}
```

For each annotated case, call the runtime retriever with configured top K and calculate retrieval metrics. When `--judge` is enabled, construct the explicit judge from `EVAL_JUDGE_MODEL`, `OPENAI_API_KEY`, and `OPENAI_BASE_URL`, then attach scores to the result. When `--failures-out` is present, create its `.rag` parent directory and write the redacted JSONL using `writeFile`; never write during the default `pnpm rag:evaluate` path.

- [ ] **Step 4: Annotate a small stable retrieval slice**

Add `referenceFacts` and known `relevantChunkIds` to at least these cases after deriving exact IDs from `prepareKnowledgeChunks`:

- `pro-benefits`
- `limit-order-how-to`
- `wallet-monitor-current-capacity`
- `wallet-balance-boundary` with no retrieval annotation
- `transaction-forensics-boundary` with no retrieval annotation

Add one `forbiddenChunkIds` assertion for the stale Pro/wallet-monitor conflict.

- [ ] **Step 5: Run CLI tests and deterministic evaluation and verify GREEN**

```bash
pnpm exec vitest run apps/cli/src/index.test.ts packages/rag-core/src/evaluate.test.ts packages/rag-core/src/retrieval-evaluate.test.ts packages/rag-core/src/answer-quality-judge.test.ts packages/rag-core/src/evaluation-failures.test.ts
pnpm rag:evaluate
```

Expected: tests pass; all 37 golden cases pass; retrieval metrics report only the annotated cases.

- [ ] **Step 6: Commit CLI layered evaluation**

```bash
git add apps/cli/src/index.ts apps/cli/src/index.test.ts docs/eval/golden-qa.jsonl .env.example
git commit -m "feat: run layered answer quality evaluation"
```

### Task 6: Evaluation Operations Documentation

**Files:**

- Modify: `docs/eval/README.md`
- Modify: `README.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Document exact workflows**

Document metric definitions, annotation rules, judge configuration, explicit failure artifact command, human-review promotion checklist, and the rule that LLM judge scores do not replace deterministic CI or human review. Explain that Elasticsearch/Neo4j require measured retrieval or graph-query evidence before adoption.

- [ ] **Step 2: Verify documentation commands and formatting**

```bash
pnpm exec prettier --check README.md docs/eval/README.md docs/roadmap.md
pnpm rag:evaluate
```

Expected: formatting passes and the deterministic evaluation remains green.

- [ ] **Step 3: Commit evaluation documentation**

```bash
git add README.md docs/eval/README.md docs/roadmap.md
git commit -m "docs: document answer quality evaluation loop"
```
