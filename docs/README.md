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

这些文档主要由 `https://docs.xxyy.io/` 的中文产品功能页面整理而来，并补充官方 X 账号历史更新内容，后续可作为 RAG 客服系统的知识库种子。

## 产品客服 Agentic RAG

当前实现采用轻量 pnpm workspace monorepo：

- `packages/shared`：共享类型与聊天请求/响应契约。
- `packages/knowledge`：产品文档加载、Markdown chunk、tokenize、索引读写。
- `packages/rag-core`：意图分类、混合检索、LLM 回答生成、边界回复、反馈存储、评测。
- `apps/cli`：本地 `ingest` / `sync:x` / `migrate` / `stats` / `feedback` / `ask` / `evaluate`。
- `apps/api`：`GET /health`、`GET /health/deep`、`POST /api/chat`、`POST /api/feedback`，并在 `/` 提供 Web UI。
- `apps/web`：静态聊天页，调用同源 `/api/chat`。

LLM 配置：

```bash
cp .env.example .env
export OPENAI_API_KEY="你的 API Key"
export OPENAI_MODEL="你的模型名"
```

默认使用 OpenAI 兼容的 Chat Completions 接口，`OPENAI_BASE_URL` 默认是 `https://api.openai.com/v1`。如果使用兼容服务，可以把 `OPENAI_BASE_URL` 改成对应地址。
API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat` 和 `/api/chat/stream` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。
配置 `API_OPS_TOKEN` 后会启用受保护的 `GET /api/ops/summary` 运维摘要接口，请求需带 `Authorization: Bearer <token>` 或 `x-ops-token`。该接口聚合 deep health、知识库 stats 和反馈 stats，适合接生产监控、后台页或告警系统。
启动 API 后可以打开 `/ops` 查看同源运维页面；页面不会内置 token，需要手动输入 `API_OPS_TOKEN` 后加载 summary。

常用命令：

```bash
pnpm start           # 启动前检查/增量更新知识库，然后启动 API + Web
pnpm sync            # 增量同步知识库，适合线上定时任务
pnpm sync -- --full  # 全量重建知识库，适合发布前或文档结构大改
pnpm check           # lint + format check + typecheck + tests
```

`pnpm rag:ingest` 会执行数据库迁移、重新生成全部 embeddings、写入 pgvector，并记录一次 ingestion run，包含 run id、文档数、chunk 数、来源分布和内容指纹。`pnpm rag:sync:x` 用于 X 更新日志增量入库：按 DB 中已有 chunk content hash 只 embedding 新增或变更的 X chunks，并且不会 prune 旧知识块。`pnpm rag:migrate` 只执行数据库迁移，不调用 embedding 或 LLM。`pnpm rag:stats` 可以查看当前知识库文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。

Web UI 会在每条回答后提供正负反馈入口，写入 Postgres `rag_feedback` 表，不记录明文 `userId`。`pnpm rag:feedback` 可以查看用户反馈总数、正负反馈数量和最近反馈明细，用于补知识库或扩展评测集；生产 triage 可以用 `pnpm rag:feedback -- --rating negative --limit 25 --json` 导出负反馈队列。

`pnpm sync` 是对底层刷新流程的主入口：默认会增量抓取 X 更新、执行 `rag:sync:x`、跑 RAG 生产检查，并导出负反馈 JSON 队列。只刷新本地/已更新文档时可以用 `pnpm sync -- --skip-scrape`，发布前可用 `pnpm sync -- --full` 执行全量 scrape、全量 ingest 和完整 LLM eval。

`pnpm ops:smoke` 用于检查已经启动的 API 服务，默认检查 `http://localhost:3000/health` 和 `/health/deep`。线上可用 `pnpm ops:smoke -- --base-url https://你的域名 --ops-token "$API_OPS_TOKEN"` 检查受保护的 ops summary；加 `--chat` 会额外请求一次 `/api/chat` 并校验回答和 citations。

`pnpm rag:evaluate -- --fast` 只跳过 chat LLM 回答生成，仍会调用 embedding 模型并查询 pgvector；它用于快速检查检索、引用和边界分类。`pnpm rag:evaluate` 会调用配置的大模型，用于检查最终客服回答质量。

正式知识库写入 Postgres + pgvector。本地体验直接运行 `pnpm start`：启动脚本会尝试启动本地 pgvector、检查知识库，在知识库为空时先跑 ingest，然后执行增量 `x:scrape` 和 `rag:sync:x`，最后启动 API + Web。生产环境使用 `NODE_ENV=production pnpm start` 会跳过本地 Docker，但同样会做知识库检查和增量同步。完全跳过启动前同步的内部入口是 `pnpm start:service`。

HTTP 交互：

```http
GET /health
GET /health/deep
GET /ops
GET /api/ops/summary
```

`/health` 是轻量存活检查。`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM；全部可用返回 `200`，任一项不可用返回 `503` 和分项原因。

```http
POST /api/chat
POST /api/feedback
```

```json
{
  "message": "如何设置 Telegram 钱包监控？",
  "channel": "web"
}
```

第一期仍以产品客服为主。涉及个人账户、订单、钱包余额、交易记录、泛 MEV/链上取证和投资建议的问题会走边界回复，不会假装查询实时数据。交易哈希夹子检测已有专用 MVP 路由；默认未接真实数据源时会提示暂未启用，`TX_ANALYSIS_PROVIDER=mock` 只返回 fixture 演示结果和截图，`TX_ANALYSIS_PROVIDER=browser` 会用本机 Chrome 查询 Solscan 和 XXYY Discover，当前先支持 Solana。

## 正式 RAG：Postgres + pgvector

配置：

```bash
export POSTGRES_DB="xxyy_ask"
export POSTGRES_HOST="localhost"
export POSTGRES_PORT="5432"
export POSTGRES_USER="xxyy"
export POSTGRES_PASSWORD="换成强密码"
export OPENAI_API_KEY="你的 API Key"
export OPENAI_MODEL="你的回答模型"
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
export RAG_TOP_K=6
export RAG_ANSWER_PROVIDER=openai
export TX_ANALYSIS_PROVIDER=none
export TX_ANALYSIS_BROWSER_HEADLESS=false
export TX_ANALYSIS_BROWSER_TIMEOUT_MS=60000
export TX_ANALYSIS_SCREENSHOT_BASE_URL=/assets
```

应用会从 `POSTGRES_*` 自动组装数据库连接串。使用外部托管数据库时，也可以只配置 `DATABASE_URL` 覆盖。

本地启动：

```bash
pnpm start
```

线上启动：

```bash
NODE_ENV=production pnpm start
```

线上增量同步：

```bash
pnpm sync
```
