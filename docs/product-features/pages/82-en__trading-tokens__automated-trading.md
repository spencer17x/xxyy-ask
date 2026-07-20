---
title: "Automated Trading"
source_url: "https://docs.xxyy.io/en/trading-tokens/automated-trading"
source_markdown_url: "https://docs.xxyy.io/en/trading-tokens/automated-trading.md"
language: "en"
category: "English documentation"
section: "English / Trading tokens"
lastmod: "2025-09-14T16:37:50.800Z"
retrieved_at: "2026-07-19T14:24:48.800Z"
content_state: "content"
ingest: true
---

# Automated Trading

This section includes advanced features for automating your trades.

* Auto-Sell on Dev Activity: Automatically sell 100% of your holdings if the token's developer initiates a sell transaction.
* Launch Snipe: Automatically buy a token the moment it becomes publicly tradable (at launch).
* Auto-Sell on Raydium Listing: Automatically sell a token as soon as it is listed on the Raydium DEX.

Critical Settings Warning

Please be aware: The Trading Mode you select when configuring these features will apply to all of your automated transactions. Review your settings carefully before enabling any automation.

Recommended Settings (for High-Volatility Launches):

* Trading Mode: Sandwich Attack Protection (or Anti-MEV Mode)
* Slippage Tolerance: 2000%

(Note: Extremely high slippage is often required to ensure that launch snipe and other time-sensitive transactions are successfully processed during periods of high network congestion and price volatility.)
