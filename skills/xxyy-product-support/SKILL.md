---
name: xxyy-product-support
description: Use when a user asks about XXYY product features, setup steps, docs, plans, limits, public product updates, or when wiring an agent to the xxyy-product-support MCP tools. Do not use for private account, wallet balance, order, business-action execution, private transaction history, or investment-advice requests.
---

# XXYY Product Support

## Overview

Use the XXYY product-support MCP server as the source of truth for product documentation questions. The MCP only answers from the public/product knowledge base; it does not query private user accounts or live business records.

## Tool Map

| Need                         | MCP tool                               |
| ---------------------------- | -------------------------------------- |
| Search product docs          | `search_product_docs` with `{ query }` |
| Answer a product question    | `answer_product_question`              |
| Check one public transaction | Use `$xxyy-transaction-analysis`       |

## Answer Flow

1. Use `answer_product_question` for XXYY product feature, configuration, how-to, plan, limit, and public update questions.
2. Use `search_product_docs` when you need source snippets before answering, when another agent needs citations, or when the user asks where the information came from.
3. If the user asks about a public transaction hash or sandwich detection, use `$xxyy-transaction-analysis` instead.
4. If the user asks for wallet balance, account status, order status, private transaction history, identity lookup, or other private data, do not call this MCP. Give the automatic boundary response and say the agent cannot query private/live account data.
5. If the user asks you to open, cancel, modify, recover, claim, place, withdraw, transfer, or execute an account/order/product action for them, do not call this MCP. Give the automatic business-action boundary response; you may answer a separate “how do I do it myself?” product-usage question.
6. If the user asks for buy/sell/加仓/减仓/收益承诺/investment advice, refuse that part and only answer product-usage portions if present.
7. Cite returned `citations` when available. Do not invent product details that are not in the returned answer or search results.

## Boundaries

- Do not use this MCP for private account, order, wallet balance, user identity, or private transaction history lookup.
- Do not use this MCP to execute business actions or imply a human handoff path.
- Do not provide investment advice or profit guarantees.
- Do not invent live product status, prices, balances, or account-specific data.
- Treat empty citations or low confidence as a signal to say the current knowledge base does not contain enough information.
