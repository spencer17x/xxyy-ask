# xxyy-ask 文档

## 产品功能知识库

- [XXYY 产品功能知识库](product-features/README.md)
- [XXYY 产品功能整理文档](product-features/xxyy-product-functions.md)
- [XXYY X 历史推文产品更新汇总](product-features/xxyy-x-updates.md)
- [页面级清洗文档](product-features/pages/)
- [页面元数据 manifest](product-features/manifest.jsonl)

这些文档主要由 `https://docs.xxyy.io/` 的中文产品功能页面整理而来，并补充官方 X 账号历史更新内容，后续可作为 RAG 客服系统的知识库种子。

## 产品客服 RAG

当前实现采用轻量 pnpm workspace monorepo：

- `packages/shared`：共享类型与聊天请求/响应契约。
- `packages/knowledge`：产品文档加载、Markdown chunk、tokenize、索引读写。
- `packages/rag-core`：意图分类、混合检索、客服回答、评测。
- `apps/cli`：本地 `ingest` / `ask` / `evaluate`。
- `apps/api`：`GET /health`、`POST /api/chat`，并在 `/` 提供 Web UI。
- `apps/web`：静态聊天页，调用同源 `/api/chat`。

常用命令：

```bash
pnpm rag:ingest
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
pnpm rag:evaluate
pnpm start
```

默认索引文件写入 `.rag/index.json`，该目录不提交。启动 API 前如果索引不存在，先运行 `pnpm rag:ingest`。Web UI 由 `apps/api` 在 `/` 提供，因此本地体验直接运行 `pnpm start` 后打开 API 地址即可。

HTTP 交互：

```http
POST /api/chat
```

```json
{
  "message": "如何设置 Telegram 钱包监控？",
  "channel": "web"
}
```

第一期只做产品客服。涉及个人账户、订单、钱包余额、交易记录、MEV/夹子检测和投资建议的问题会走边界回复，不会假装查询实时数据。
