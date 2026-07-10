# XXYY Ask Repository Hardening Design

**Date:** 2026-07-10

**Goal:** Fix the confirmed security, boundary, grounding, ingestion, Web, API, Telegram, and stream-parity defects without weakening the current knowledge-only product-support boundary.

## Scope

This design covers the ten confirmed findings from the repository review:

1. Prevent ignored transaction-analysis artifacts from being served through `/assets/*`.
2. Deterministically reject transaction hash, explorer, pool, chain-forensics, and generic MEV requests before planner execution.
3. Prevent support answers from treating roadmap language or substring matches as current direct evidence.
4. Reject pgvector candidates that have neither adequate lexical nor semantic relevance.
5. Prevent empty or materially incomplete full X refreshes from replacing the authoritative local source.
6. Build Web assets on supported start and CI paths, and let internal production Web users provide an API token without embedding it in the bundle or persisting it.
7. Make full knowledge replacement atomic and fail clearly when the configured embedding dimension differs from the existing pgvector column.
8. Prevent a permanently failing Telegram update from blocking every later update, and avoid splitting invalid Telegram HTML.
9. Give streaming and non-streaming Agent requests equivalent multi-step planning, evidence accumulation, repeated-search handling, and step-limit behavior.
10. Decode HTTP JSON bodies once after byte-accurate buffering so UTF-8 characters cannot be corrupted across network chunks.

The work does not add transaction analysis, account access, investment advice, end-user identity, a new database, or a new Agent tool surface.

## Delivery Strategy

The implementation is split into three independently testable batches. Each behavior change starts with a regression test that fails for the reviewed reason, followed by the smallest production change that makes it pass.

### Batch 1: Security and deterministic boundaries

- Replace the generic product asset directory exposure with an explicit allowlist of approved product media filenames. The current approved asset is `xxyy-add-to-home.mp4`; ignored `tx-analysis-*` files and report indexes remain on disk but are never addressable through the API.
- Add deterministic unsupported-request patterns for transaction hashes, explorer URLs, pool lookup, chain forensics, sandwich detection, and generic MEV analysis.
- Represent these requests as `intent: unknown` with a dedicated boundary reason. The LangGraph pre-guard owns the response and runs before any planner or product tool.
- Restrict planner-selected product override to questions that contain a positive XXYY product-domain signal. A generic `unknown` classification is not sufficient authority.
- Keep boundary copy server-owned. Planner output cannot introduce citations, product intent, or transaction conclusions for a boundary route.

### Batch 2: Grounding, Agent parity, and knowledge integrity

- Support evidence matching uses normalized exact tokens or boundary-aware aliases. Short identifiers such as `OP` cannot match substrings such as `Copy`.
- Sentences containing future or roadmap markers such as `计划`, `即将`, `预计`, `soon`, or `coming` cannot establish current support. They may be quoted only when the user explicitly asks about roadmap or future plans.
- Direct support questions require the selected chunk and the selected evidence sentence to contain the requested entity. The standard-customer-answer shortcut runs only after this direct-evidence gate.
- pgvector results pass a relevance gate before ranking: a candidate must have lexical overlap or a cosine-derived `vectorScore` of at least `0.25`. Status and source boosts cannot rescue a candidate with no topical evidence. The threshold is a named constant covered by boundary tests rather than a new environment option.
- The streaming runtime extracts and reuses the same planner, tool execution, observe, replan, repeated-input, and maximum-step transition functions as `ask`. Search tools may execute across multiple steps; when the terminal plan is `answer_product_question`, the runtime uses that tool's existing stream implementation so answer deltas remain incremental.
- Full knowledge replacement acquires one database connection and wraps chunk upserts, stale-chunk pruning, and ingestion-run recording in one transaction. Readers observe either the old snapshot or the committed new snapshot.
- Migration inspects the actual `knowledge_chunks.embedding` type. A dimension mismatch fails with `VectorStoreConfigurationError` before content writes and instructs the operator to run `pnpm rag:ingest -- --rebuild-embedding-schema`. That explicit ingest mode embeds the complete replacement first, then transactionally recreates only the knowledge embedding column/index and writes the complete new snapshot; ordinary `rag:migrate` never performs a destructive conversion.

### Batch 3: Operational and client reliability

- Full X refresh validates numeric scraper configuration before any network or file operation.
- A full refresh must return a non-empty completed traversal. Reaching the configured page cap while another cursor exists is incomplete. When a previous snapshot exists, a replacement below `80%` of the previous post count is rejected unless the operator explicitly passes `--allow-shrink`.
- Scraped output is validated before any authoritative file is replaced. Existing files remain unchanged on validation failure.
- `app:dev` builds Web assets before starting the combined API/Web service. The root quality gate also runs the production Web build, so clean-checkout asset failures are caught in CI.
- The built-in Web UI includes an optional token input for internal production use. The token lives only in React memory, is never written to local or session storage, and is sent as a Bearer header by both chat and AI-service-check calls.
- HTTP request bodies accumulate raw bytes, enforce `API_MAX_BODY_BYTES` against those raw bytes, and decode the complete buffer once before `JSON.parse`.
- Telegram handles each update once per polling batch. If handling throws, it records the failure through the existing logger, advances the in-memory offset, and continues processing later updates instead of asking the model again. Long formatted messages keep HTML only when the complete message fits the platform limit; oversized messages use plain-text chunks so no chunk can contain an unbalanced HTML tag.

## Data and Error Flows

### Product request

1. The deterministic classifier checks unsafe operations, private credentials, account-specific queries, investment advice, and transaction/MEV boundary patterns.
2. Boundary matches return a server-owned response without loading the planner, vector store, embedding provider, or answer provider.
3. Product questions enter the planner and retrieval path.
4. Retrieval removes below-threshold candidates before grounding.
5. Support questions apply direct entity and temporal evidence checks before deterministic or LLM answer generation.

### Full ingest

1. Documents are loaded, chunked, and embedded before knowledge rows are changed.
2. The store validates schema dimension compatibility.
3. One transaction upserts the complete new chunk set, prunes stale rows, and writes the ingestion-run record.
4. Any error rolls back the complete transaction and leaves the prior knowledge snapshot and audit record intact.

### Full X refresh

1. Scraper configuration is validated.
2. The timeline traversal completes into memory.
3. Completeness and shrink checks run against the previous snapshot.
4. Only validated output replaces the local JSONL, metadata, and rendered index inputs.
5. A failed validation exits non-zero and preserves the previous source files and database.

## Testing Strategy

Regression tests will cover each reviewed reproduction:

- Anonymous requests cannot fetch `tx-analysis-*` files or `tx-analysis-report-index.jsonl`, while approved product media still returns `200`.
- Transaction/MEV prompts never call the planner, retriever, or answer provider and always return the boundary route.
- `计划支持 Robinhood，预计下季度上线` does not produce `支持`, and `OP` does not match `Copy Trading`.
- A pgvector row with zero lexical overlap and sub-threshold semantic similarity is removed even when source/status boosts are positive.
- `ask` and `stream` return the same accumulated citations for a two-module comparison and the same clarification for repeated or empty searches.
- A failing chunk upsert or ingestion-run insert rolls back upserts and pruning; migration reports an embedding-dimension mismatch before writes.
- Empty, page-capped, invalid-config, and below-80%-coverage full X refreshes leave existing source files unchanged; `--allow-shrink` is covered as the explicit operator override.
- A clean start plan includes the Web build, and the Web request helpers add an in-memory Bearer token without persistence.
- A Chinese character split across request chunks is parsed unchanged.
- One failing Telegram update is logged once, later updates continue, and every long outgoing Telegram message is valid within the platform limit.

After targeted tests pass, the release gate is:

```bash
pnpm --filter @xxyy/web build
pnpm check
```

## Rollout and Compatibility

- Existing API clients without authentication continue to work in development. Production API authentication remains enabled by default.
- Existing service clients using Bearer or `x-api-key` remain compatible.
- The Web token is optional in development and required only when the server returns an authentication error.
- Existing databases with the configured embedding dimension migrate normally. Mismatched databases fail safely and require `pnpm rag:ingest -- --rebuild-embedding-schema`; no ordinary migration performs an automatic destructive conversion.
- Existing ignored transaction-analysis files are not deleted or modified. They simply stop being publicly served.
- Existing user changes in `packages/rag-core` and `packages/agent-core` remain the base for the support-answer fixes rather than being reverted.

## Success Criteria

- Every reviewed reproduction has a regression test that fails before its corresponding fix and passes afterward.
- No transaction, explorer, pool, or MEV request reaches product retrieval or planner-authored analysis.
- No unapproved file in `docs/product-features/assets` is publicly retrievable.
- Unsupported support claims return an evidence-insufficient response with no misleading citation.
- Full X refresh and full ingest failures preserve the prior authoritative state.
- Clean-checkout startup serves working Web assets, and authenticated production Web calls do not embed or persist credentials.
- `ask` and `stream` are behaviorally equivalent for multi-step cases.
- `pnpm --filter @xxyy/web build` and `pnpm check` pass with no new warnings.
