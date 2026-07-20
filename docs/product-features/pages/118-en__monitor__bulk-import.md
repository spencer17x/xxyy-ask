---
title: "Bulk Import"
source_url: "https://docs.xxyy.io/en/monitor/bulk-import"
source_markdown_url: "https://docs.xxyy.io/en/monitor/bulk-import.md"
language: "en"
category: "English documentation"
section: "English / Monitor"
lastmod: "2025-09-14T17:11:33.346Z"
retrieved_at: "2026-07-19T14:24:48.800Z"
content_state: "content"
ingest: true
---

# Bulk Import

The Bulk Import feature allows you to add multiple wallets to your Monitor list at once. There are two methods for importing: by text or by file.

1\. Import via Text

To import using text, you must format your data with each wallet on a new line, following this comma-separated format:\
Wallet Name,Wallet Address,Group

For example:\
Smart Money Whale,So111...abc,KOLs

If there are any formatting errors in your list, the system will notify you that the import has failed or will specify the incorrect entries.

2\. Import Wallet File

You can also import wallets by uploading a file.

* Download Template: For convenience, we provide a template file that you can download, fill out with your wallet information, and then upload.
* Upload Abot File: You can also directly upload a wallet file that has been exported from the Abot tool.

Applying Batch Settings

When importing a group of wallets, you can apply a universal set of monitoring rules to the entire batch. During the import process, you will be prompted to configure the default alert settings for all imported wallets, such as which transaction types to receive alerts for (e.g., Buys only, Sells only) and whether to enable or disable push notifications for the entire group.
