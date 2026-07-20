---
title: "Token Information"
source_url: "https://docs.xxyy.io/en/token-information"
source_markdown_url: "https://docs.xxyy.io/en/token-information.md"
language: "en"
category: "English documentation"
section: "English / Product documentation"
lastmod: "2025-09-14T16:53:51.564Z"
retrieved_at: "2026-07-19T14:24:48.800Z"
content_state: "content"
ingest: true
---

# Token Information

The Token Information panel provides a comprehensive, real-time overview of any token, powered by one of the fastest data feeds on the market. It includes key on-chain metrics and security checks to help you make informed trading decisions.

Basic Token Info

This section displays the token's essential data:

* Contract Address
* Trading DEXs
* Price
* Liquidity
* Market Cap

Time-based Trading Data

Analyze recent activity across 5-minute, 1-hour, 6-hour, and 24-hour intervals. This includes a breakdown of buy vs. sell activity for:

* Number of trades
* Total volume
* Number of unique traders

Security Analysis

A series of automated safety checks to help you assess a project's risk:

* Mint Authority: Disabled (Green) / Enabled (Red).
  * A "Disabled" status is safer, as it means no new tokens can be created.
* Freeze Authority: Disabled (Green) / Enabled (Red).
  * A "Disabled" status is safer, as it means the developer cannot freeze assets or trading.
* Top 10 Holder Concentration: Shows the percentage of the supply held by the top 10 wallets.
  * A value of 15% or less is considered safer (Green).
* LP Burned Percentage: Shows the percentage of liquidity pool (LP) tokens that have been burned.
  * 100% (Green) is the ideal, as it means the initial liquidity cannot be removed, preventing a "rug pull."

Liquidity Pool & Project Details

* Pooled \[Token Name]: The total amount of the token and its USD value held in the liquidity pool.
* Pooled SOL: The total amount of SOL and its USD value held in the liquidity pool.
* Developer Address: Displays the Dev's wallet address and links directly to its page on Solscan.
* Pair Creation Time: The exact date and time the trading pair was created.

Special Status Indicators

* Bonding Curve Progress: For tokens on launchpads like pump.fun, this shows the completion percentage of their bonding curve.
* Migrating to Raydium: A status indicator that appears when a token is in the process of migrating. Trading is temporarily paused during this period (typically under 30 minutes).

Social Media Intelligence

* Twitter Rename History: For Pro users, this feature displays any past changes to the project's associated Twitter account name.
* Banner Image: If the project has an official banner on Dexscreener, it will be displayed here.
* Search Twitter by Address/Name: These buttons automatically search Twitter for the token's contract address (CA) or name, allowing you to quickly gauge community sentiment.
