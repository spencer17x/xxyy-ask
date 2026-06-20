---
name: xxyy-transaction-analysis
description: Use when a user asks whether an XXYY-related transaction hash or supported explorer link was sandwiched, clipped, front-run/back-run, 被夹, or 夹子检测, or when wiring an agent to the first-slice xxyy-transaction-analysis MCP tool. Do not use for private account, order, wallet balance, user identity, or investment-advice requests.
---

# XXYY Transaction Analysis

## Overview

Use the XXYY transaction-analysis MCP server as the source of truth for 交易夹子检测. The current first-slice MCP surface only analyzes one public transaction at a time; it does not expose report lookup/list tools and does not query private user accounts.

## Tool Map

| Need                  | MCP tool                                        |
| --------------------- | ----------------------------------------------- |
| Check one transaction | `analyze_transaction` with `{ txHash, chain? }` |

## Analyze Flow

1. Extract exactly one transaction hash or supported explorer URL. If the user provides several transactions, ask which one to check first unless they explicitly want a batch.
2. Set `chain` only when clear: `solana`, `base`, `ethereum`, or `bsc`. Use `unknown` only for a bare EVM `0x...` hash when the chain is not stated; it means auto-detect across Base, Ethereum, and BSC, not a real chain.
3. Call `analyze_transaction` with `{ txHash, chain }` when an MCP tool is available.
4. If the same request asks for trading advice, still limit the MCP result to public transaction evidence and explicitly refuse the buy/sell/加仓/减仓 recommendation.
5. Explain the returned `status`, `result.verdict`, `confidence`, short summary, evidence, and related transactions. Include explorer, report, screenshot, or artifact links when returned by the analyze result.
6. If `status` is `failure`, report the failure reason plainly and ask for the missing public input only when useful, such as a clearer chain or explorer link.

## Boundaries

- Do not use this MCP for wallet balances, account data, orders, user identity, or private transaction histories.
- Do not provide investment advice or profit/loss recommendations from the sandwich result.
- Do not invent live chain data when the provider is `none`, unavailable, or returns a failure.
- Do not present `mock` / fixture results as real evidence.
- Treat `inconclusive` as inconclusive; do not upgrade it to sandwiched.

## Reports

The first-slice MCP does not provide `get_analysis_report` or `list_analysis_reports`. If `analyze_transaction` returns report or artifact links, include them in the answer; do not attempt a separate report lookup through MCP.
