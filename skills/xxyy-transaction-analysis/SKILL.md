---
name: xxyy-transaction-analysis
description: Use when a user asks whether an XXYY-related transaction hash or supported explorer link was sandwiched, clipped, front-run/back-run, 被夹, or 夹子检测; when reviewing stored XXYY transaction analysis reports; or when wiring an agent to the xxyy-transaction-analysis MCP tools. Do not use for private account, order, wallet balance, user identity, or investment-advice requests.
---

# XXYY Transaction Analysis

## Overview

Use the XXYY transaction-analysis MCP server as the source of truth for 交易夹子检测. The MCP only analyzes public transaction evidence; it does not query private user accounts.

## Tool Map

| Need                    | MCP tool                                        |
| ----------------------- | ----------------------------------------------- |
| Check one transaction   | `analyze_transaction` with `{ txHash, chain? }` |
| Fetch one stored report | `get_analysis_report` with `{ id }`             |
| Search stored reports   | `list_analysis_reports` with filters            |

## Analyze Flow

1. Extract exactly one transaction hash or supported explorer URL. If the user provides several transactions, ask which one to check first unless they explicitly want a batch.
2. Set `chain` only when clear: `solana`, `base`, `ethereum`, or `bsc`. Use `unknown` only for a bare EVM `0x...` hash when the chain is not stated; it means auto-detect across Base, Ethereum, and BSC, not a real chain.
3. Call `analyze_transaction` with `{ txHash, chain }` when an MCP tool is available.
4. If the same request asks for trading advice, still limit the MCP result to public transaction evidence and explicitly refuse the buy/sell/加仓/减仓 recommendation.
5. Explain the returned `status`, `result.verdict`, `confidence`, short summary, evidence, and related transactions. Include explorer/report links when returned.
6. If `status` is `failure`, report the failure reason plainly and ask for the missing public input only when useful, such as a clearer chain or explorer link.

## Boundaries

- Do not use this MCP for wallet balances, account data, orders, user identity, or private transaction histories.
- Do not provide investment advice or profit/loss recommendations from the sandwich result.
- Do not invent live chain data when the provider is `none`, unavailable, or returns a failure.
- Do not present `mock` / fixture results as real evidence.
- Treat `inconclusive` as inconclusive; do not upgrade it to sandwiched.

## Reports

Use `list_analysis_reports` for ops/support review queues. Common filters are `chain`, `status`, `reason`, `reviewStatus`, `reviewAssignee`, `txHash`, and `limit`.

Use `get_analysis_report` with `{ id: "<report id>" }` when the user gives a report id or a list result points to a stored JSON report that needs details.
