# Golden QA maintenance

`golden-qa.jsonl` is the cheap deterministic regression set that runs in `pnpm check`.
Keep it stable, source-grounded, and focused on customer-support behavior.
The current set contains 48 reviewed cases, including current-vs-historical conflicts,
colloquial support questions, constraint preservation, boundary replies, and citation stability.

## Record format

Each line is one JSON object:

```json
{
  "name": "wallet-monitor-current-capacity",
  "question": "现在钱包监控最多支持多少个地址？",
  "expectedIntent": "product_qa",
  "mustContain": ["5000个地址"],
  "mustNotContain": ["2000个钱包"],
  "expectedCitationFiles": ["docs/product-features/sources/usexxyyio-x-posts.jsonl"],
  "expectedCitationTitles": ["X Post 2031333475010355227"],
  "expectedSourceUrls": ["https://x.com/useXXYYio/status/2031333475010355227"],
  "forbiddenCitationFiles": ["docs/product-features/pages/59-getting-started__xxyy-pro-quan-yi.md"],
  "referenceFacts": ["钱包监控最多支持5000个地址"],
  "relevantChunkIds": ["x_updates:sources/usexxyyio-x-posts/2031333475010355227:chunk:0001"],
  "forbiddenChunkIds": ["official_docs:pages/59-getting-started__xxyy-pro-quan-yi:chunk:0002"],
  "requireCitationSupport": true,
  "boundaryExpected": false
}
```

Supported checks:

- `expectedIntent`: required intent.
- `mustContain`: answer phrases that must appear.
- `mustNotContain`: phrases that must not appear.
- `expectedCitationFiles`: exact citation file paths expected in the response.
- `expectedCitationTitles`: exact citation titles expected in the response.
- `expectedSourceUrls`: exact source URLs expected in the response.
- `forbiddenCitationFiles`: exact citation file paths that must not appear; use this for stale or conflicting sources.
- `forbiddenSourceUrls`: exact source URLs that must not appear.
- `requireCitationSupport`: when true, each `mustContain` phrase that appears in the answer must also appear in citation excerpts, ignoring whitespace.
- `boundaryExpected`: marks boundary cases that should not require citations.
- `referenceFacts`: short source-verified facts used by the optional judge and human review.
- `relevantChunkIds`: exact chunk IDs that should be recalled. Only cases with this field contribute retrieval metrics.
- `forbiddenChunkIds`: stale, conflicting, or unsafe chunks that must not enter the evaluated ranking.
- `expectedAgentRoute` and `expectedToolNames`: optional exact route and ordered tool trajectory checks for provider-backed cases with trace observations.
  普通产品问题的标准轨迹是 `['search_product_docs']`；复杂比较问题可以出现多个该工具调用，但 rewritten query 必须不同且每次带来新证据。`agent.observe` 和 `agent.answer_composer` 是 chain spans，不计入 toolNames。

Chunk IDs must come from `prepareKnowledgeChunks`, not from hand-written guesses. Keep annotations small: list the chunks required to answer the question, not every vaguely related chunk.

## Current and historical facts

- For questions about the current product, use the latest explicit official update as the expected fact.
- A newer update only supersedes the scope it names, such as a specific chain, plan, or user tier.
- Put older conflicting chunks in `forbiddenChunkIds` for current-product cases.
- Historical questions may cite older chunks, but the expected answer must make the historical timeframe clear.
- If official sources do not uniquely identify the applicable scope, keep the case in review instead of inventing a golden answer.

## Layered metrics

- Recall@K: retrieved relevant chunks divided by all annotated relevant chunks.
- Precision@K: relevant chunks divided by returned chunks within K.
- MRR: reciprocal rank of the first relevant chunk.
- nDCG@K: binary relevance with `1 / log2(rank + 1)` discount.
- forbidden hits: count of annotated stale/conflicting chunks returned within K.

Unannotated cases are excluded from retrieval averages. The deterministic answer checks remain the merge gate; retrieval metrics explain why an answer may be weak, and an LLM judge supplies an additional review signal only when explicitly requested.

## When to add cases

Add or update a golden case when:

- fixing an answer-quality bug;
- changing retrieval, reranking, chunking, prompts, or source metadata;
- adding product docs for important limits, eligibility, supported chains, or current-vs-historical rules;
- tightening a safety boundary for account data, transaction forensics, private credentials, or investment advice.

Prefer realistic user wording. Keep assertions short and factual; avoid checking prose style unless the style is the behavior under test.

Trustworthiness changes need two layers of regression evidence:

- Golden QA records verify real source selection, current/historical conflict handling, required facts, forbidden stale facts, and stable citation files/URLs.
- Unit tests verify adversarial properties that should not be inserted into production knowledge, including prompt injection quarantine, sentence-aware context budgets, unsupported numeric/step claim fallback, and streamed-token non-leakage.

`requireCitationSupport` is a deterministic literal check for the selected required phrases. The runtime answer provider additionally performs claim-level local grounding for the complete model answer; provider-backed evaluation exercises that runtime path.

## Verification

Run:

```bash
pnpm rag:evaluate
pnpm check
```

Use `pnpm rag:evaluate -- --provider` only for human review before releases or model/retriever changes; it may call configured external providers.

To measure the production pgvector + embedding retrieval path without involving the Agent planner or answer model, run:

```bash
pnpm rag:evaluate -- --provider --retrieval-only
```

This evaluates only cases with `relevantChunkIds`, applies the same candidate multiplier and metadata reranker as the product tools, and reports Recall@K, Precision@K, MRR, nDCG@K, and forbidden hits. Use it for before/after retrieval baselines when chat-provider failures would otherwise contaminate retrieval metrics. Retrieval failures can be exported under `.rag/` with `--failures-out`.
To add the optional judge, configure a separate model and use:

```bash
EVAL_JUDGE_MODEL=your-judge-model pnpm rag:evaluate -- --provider --judge
```

`--judge` requires `--provider`. Scores cover correctness, groundedness, completeness, relevance, and safe refusal. They do not change deterministic pass/fail and must not be promoted without source review.
Provider-backed reports include per-case expected intent, actual intent, and citation counts so reviewers can quickly inspect weak answers:

```text
Evaluation (provider-backed): 35/36 passed
[PASS] pro-benefits (expected product_qa, actual product_qa, citations 3/0)
[FAIL] bad-answer (expected product_qa, actual unknown, citations 0/1)
  - intent unknown != product_qa
```

## Feedback Backlog

Use feedback backlog export to turn stored negative feedback and no-citation feedback into review-only eval drafts:

```bash
pnpm rag:feedback:backlog
```

The command reads `rag_feedback` and prints JSONL records with `_review` metadata. Treat these as a triage queue: a reviewer must fill in precise `mustContain`, `mustNotContain`, expected citations, and source URLs before moving a draft into `golden-qa.jsonl`.

Web 的 👍/👎 通过 `/api/feedback` 写入该表。Web 和 Telegram 的无引用产品回答会以 `automatic_low_evidence` 评论自动写入；这些记录仍然只生成待审核草稿，不会自动进入 golden QA 或知识库。

Failed evals can be exported through an explicit repository-local path:

```bash
pnpm rag:evaluate -- --provider --failures-out .rag/provider-failures.jsonl
```

The file contains only failing cases and bounded observations, is redacted, and is never written by the default command. Review checklist:

1. Reproduce the failure and verify the intended answer against official docs or official X updates.
2. Decide whether the defect is classification, retrieval, freshness/conflict handling, grounding, answer generation, or a safety boundary.
3. Replace user identifiers and private details with synthetic wording.
4. Add exact facts, relevant/forbidden chunk IDs, answer phrases, and citations.
5. Run `pnpm rag:evaluate` and `pnpm check`; only then promote the case to golden QA.

Postgres + pgvector remains the default retrieval backend. Elasticsearch should be considered only after measured lexical/hybrid recall failures cannot be corrected with the existing hybrid query/reranker. Neo4j should be considered only when the product requires multi-hop relationship queries with a maintained graph schema. Neither is justified merely to add observability or improve answer prose.
