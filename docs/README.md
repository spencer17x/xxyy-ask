# xxyy-ask 文档

## 项目状态

- [业务架构](architecture.md)
- [功能状态](feature-status.md)
- [Roadmap](roadmap.md)

## 产品功能知识库

- [XXYY 产品功能知识库](product-features/README.md)
- [XXYY 产品功能整理文档](product-features/xxyy-product-functions.md)
- [XXYY X 历史推文产品更新汇总](product-features/xxyy-x-updates.md)
- [页面级清洗文档](product-features/pages/)
- [页面元数据 manifest](product-features/manifest.jsonl)

这些文档由 XXYY 产品文档和官方 X 更新整理而来，是当前 Product RAG 的种子知识库。

## 当前系统

当前项目是 XXYY 产品客服 Agentic RAG 系统，正式路径为 LangGraph JS + Postgres + pgvector + OpenAI-compatible embeddings/chat completion。当前运行面只保留知识库产品问答，不暴露 MCP server、本地 project skills 或交易分析入口。

- `packages/shared`：共享类型与聊天请求/响应契约。
- `packages/knowledge`：产品文档加载、Markdown chunk、tokenize、本地索引和 embedding provider。
- `packages/rag-core`：意图分类、检索接口、pgvector store、LLM answer provider、边界回复和配置错误类型。
- `packages/agent-core`：LangGraph customer runtime、planner/state 合约和产品问答工具。
- `apps/cli`：`rag:ask`、`rag:ingest`、`rag:migrate`、`rag:stats`、`rag:sync:x`。
- `apps/api`：`GET /`、`GET /health`、`GET /health/deep`、`POST /api/chat`、`POST /api/chat/stream`、`GET /assets/*`。
- `apps/telegram-bot`：Telegram Bot long polling 入口，复用 LangGraph 客服 Agent。
- `apps/web`：静态聊天 UI。

## 常用命令

```bash
pnpm run app:dev                 # 启动 API + Web，默认不刷新知识库
pnpm run app:dev -- --sync       # 启动前增量抓取 X 更新并同步知识库
pnpm run app:dev -- --full-sync  # 启动前全量重抓 X 更新并重建知识库
pnpm check                       # lint + format check + typecheck + tests
pnpm agent:smoke                 # 轻量验证已启动服务的 health 和核心 agentRoute
```

聚焦命令：

```bash
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
pnpm rag:ingest
pnpm rag:sync:x
pnpm rag:stats
pnpm rag:evaluate
pnpm run telegram:dev
```

`pnpm run app:dev -- --sync` 会执行增量 `x:scrape` 和 `rag:sync:x` 后启动服务；`--full-sync` 会执行全量 scrape 和正式 ingest 后启动服务。

## HTTP 交互

```http
GET /health
GET /health/deep
GET /assets/*
POST /api/chat
POST /api/chat/stream
```

`/health` 是轻量存活检查，不调用外部模型。`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM；开发模式默认开放，生产模式默认禁用，配置 `API_DEEP_HEALTH_TOKEN` 后需要 Bearer token 访问。

`POST /api/chat` 和 `POST /api/chat/stream` 是客服入口。生产模式默认要求 `API_CHAT_AUTH_TOKEN`，本地开发默认不要求。Agent 当前只在 `boundary`、`clarify` 和 `product_answer` 之间规划路线。

## Telegram Bot

```bash
pnpm run telegram:dev
```

Bot 通过 Telegram Bot API long polling 接收文本消息，转成 `channel: "telegram"` 的客服请求。默认只需要配置 `TELEGRAM_BOT_TOKEN`。图片附件公网 URL、轮询超时和重试间隔都有默认处理，只有特殊部署才需要额外覆盖。

## 边界

当前客服 Agent 回答 XXYY 产品功能、配置步骤、权益说明和官方更新相关问题。

以下请求必须走边界或澄清回复：

- 用户账户、订单、钱包余额、私有交易记录等实时私有数据查询。
- 代开通、代取消、代修改等账户或订单操作。
- 投资建议。
- 交易哈希、交易链接、池子查询、链上取证和泛 MEV 分析请求。
- 无法从公开产品知识库得到依据的实时数据。
