# Golden QA maintenance

`golden-qa.jsonl` is the cheap deterministic regression set that runs in `pnpm check`.
Keep it stable, source-grounded, and focused on customer-support behavior.

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

## When to add cases

Add or update a golden case when:

- fixing an answer-quality bug;
- changing retrieval, reranking, chunking, prompts, or source metadata;
- adding product docs for important limits, eligibility, supported chains, or current-vs-historical rules;
- tightening a safety boundary for account data, transaction forensics, private credentials, or investment advice.

Prefer realistic user wording. Keep assertions short and factual; avoid checking prose style unless the style is the behavior under test.

## Verification

Run:

```bash
pnpm rag:evaluate
pnpm check
```

Use `pnpm rag:evaluate -- --provider` only for human review before releases or model/retriever changes; it may call configured external providers.
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
