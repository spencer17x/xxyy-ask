---
name: xxyy-knowledge-ops
description: Use when operating XXYY knowledge learning workflows, reviewing Telegram-derived knowledge candidates, publishing approved candidates, running post-publish RAG gates, or wiring an internal agent to the xxyy-knowledge-ops MCP tools.
---

# XXYY Knowledge Ops

## Overview

Use the internal XXYY knowledge-ops MCP server for the audited knowledge learning loop. The first version is human-review-first: Telegram messages can create candidates, but unreviewed content must not be published or embedded into production RAG.

## Tool Map

| Need                                      | MCP tool                      |
| ----------------------------------------- | ----------------------------- |
| Sync authorized Telegram support messages | `sync_telegram_support`       |
| List review candidates                    | `list_knowledge_candidates`   |
| Record a review decision                  | `review_knowledge_candidate`  |
| Publish an approved candidate             | `publish_knowledge_candidate` |
| Ingest and evaluate a published candidate | `run_knowledge_gate`          |

## Safe Workflow

1. Use `sync_telegram_support` only for explicitly authorized support chats configured by the service environment.
2. Use `list_knowledge_candidates` to inspect `needs_review`, `approved`, `published`, `eval_failed`, or other candidate queues.
3. Use `review_knowledge_candidate` to apply a human decision. Prefer `approve` only when the candidate is product-support knowledge, redacted, and not private account/order/balance data or investment advice.
4. Use `publish_knowledge_candidate` only after a candidate is `approved`. Never publish `draft`, `needs_review`, `rejected`, `ingested`, `eval_passed`, or `eval_failed` candidates.
5. After publishing, use `run_knowledge_gate` with `{ id, fast: true }` for the first pass. Treat `status: "passed"` as the candidate reaching `eval_passed`; treat `status: "failed"` as requiring correction or rollback planning.

## Boundaries

- Do not publish unreviewed Telegram content.
- Do not turn private account, wallet balance, order, user identity, private transaction history, or investment-advice content into product knowledge.
- Do not bypass `run_knowledge_gate` after publishing.
- Do not present `eval_failed` knowledge as production-confirmed.
- Use product support or transaction analysis skills for user-facing answers; this skill is for internal knowledge operations.
