# xxyy-ask 文档

## 项目状态

- [业务架构](architecture.md)
- [功能状态](feature-status.md)
- [Roadmap](roadmap.md)
- [交易哈希夹子检测设计](tx-hash-sandwich-detection-design.md)

## 产品功能知识库

- [XXYY 产品功能知识库](product-features/README.md)
- [XXYY 产品功能整理文档](product-features/xxyy-product-functions.md)
- [XXYY X 历史推文产品更新汇总](product-features/xxyy-x-updates.md)
- [页面级清洗文档](product-features/pages/)
- [页面元数据 manifest](product-features/manifest.jsonl)

这些文档由 XXYY 产品文档和官方 X 更新整理而来，是当前 Product RAG 的种子知识库。

## 当前系统

当前项目是 XXYY 产品客服 Agentic RAG 系统，正式路径为 LangGraph JS + Postgres + pgvector + OpenAI-compatible embeddings/chat completion。

- `packages/shared`：共享类型与聊天请求/响应契约。
- `packages/knowledge`：产品文档加载、Markdown chunk、tokenize、本地索引和 embedding provider。
- `packages/rag-core`：意图分类、检索接口、pgvector store、LLM answer provider、边界回复和交易分析 runtime。
- `packages/agent-core`：LangGraph customer runtime、planner/state 合约和产品/交易分析工具。
- `packages/product-qa-mcp`：产品问答 MCP stdio server。
- `packages/tx-analysis-mcp`：交易哈希夹子查询 MCP stdio server。
- `apps/cli`：`rag:ask`、`rag:ingest`、`rag:migrate`、`rag:stats`、`rag:sync:x`。
- `apps/api`：`GET /`、`GET /health`、`GET /health/deep`、`POST /api/chat`、`POST /api/chat/stream`、`POST /api/tx-analysis`、`GET /assets/*`。
- `apps/web`：静态聊天 UI。

## 常用命令

```bash
pnpm start           # 启动前检查/增量更新知识库，然后启动 API + Web
pnpm sync            # 增量抓取 X 更新并同步知识库
pnpm sync -- --full  # 全量重抓 X 更新并重建知识库
pnpm check           # lint + format check + typecheck + tests
pnpm agent:smoke     # 轻量验证已启动服务的 health 和核心 agentRoute
```

聚焦命令：

```bash
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
pnpm rag:ingest
pnpm rag:sync:x
pnpm rag:stats
TX_ANALYSIS_PROVIDER=mock pnpm tx:mcp:smoke
```

`pnpm sync` 默认执行增量 `x:scrape` 和 `rag:sync:x`；`--full` 会执行全量 scrape 和正式 ingest。

## HTTP 交互

```http
GET /health
GET /health/deep
GET /assets/*
POST /api/chat
POST /api/chat/stream
POST /api/tx-analysis
```

`/health` 是轻量存活检查。`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM；全部可用返回 `200`，任一项不可用返回 `503` 和分项原因。

`POST /api/chat` 和 `POST /api/chat/stream` 是客服入口。Agent 会在 `boundary`、`clarify`、`product_answer` 和 `transaction_analysis` 之间规划路线。

`POST /api/tx-analysis` 是后台、测试工具或未来独立分析页可复用的交易分析入口，返回与聊天入口一致的 `ChatResponse`。

## 边界

当前客服 Agent 回答 XXYY 产品功能、配置步骤、权益说明、文档更新和公开交易哈希夹子分析问题。

以下请求必须走边界回复：

- 用户账户、订单、钱包余额、私有交易记录等实时私有数据查询。
- 代开通、代取消、代修改等账户或订单操作。
- 投资建议。
- 无法从公开产品知识库或已启用工具得到依据的实时数据。

## MCP 与 Skills

产品客服 MCP：

```bash
pnpm product:mcp
```

交易分析 MCP：

```bash
pnpm tx:mcp
```

当前保留的本地 Skill 源文件：

- `skills/xxyy-product-support`
- `skills/xxyy-transaction-analysis`

未来交易池子查询、链上交易分析和更多客服工具，优先以 MCP/tool adapter 接入 LangGraph runtime。
