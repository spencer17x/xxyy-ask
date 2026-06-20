# xxyy-ask

XXYY 客服 Agentic RAG 项目。当前目标是做 LangGraph 驱动的产品客服 Agent：自动同步官方 X / Twitter 和产品文档知识库，自动回答 XXYY 产品问题，并在交易哈希、未来池子查询和链上分析等特定问题上自主规划调用工具。

当前第一片能力聚焦客服自动回答：

- 使用 LangGraph JS 作为客服 Agent runtime，按策略保护、规划、工具执行和回答合成组织流程。
- 产品问题调用 Product RAG，从 `docs/product-features` 和官方 X / Twitter 更新中检索并基于引用回答。
- 交易哈希或受支持 explorer 链接会路由到交易分析工具；默认未配置真实数据源时返回暂未启用，`mock` 仅用于 fixture 演示，`browser` 使用本机 Chrome 查询公开交易浏览器和 XXYY 原池子页。
- 支持 Solana，并已接入 Base、Ethereum、BSC 浏览器取证初版。
- 未来会继续在同一 Agent 工具体系中增加池子查询和链上分析工具。
- 不查询用户账户、订单、钱包余额或私有交易记录，不提供投资建议。

完整功能状态见 [docs/feature-status.md](docs/feature-status.md)，后续规划见 [docs/roadmap.md](docs/roadmap.md)。

## 项目结构

```text
apps/
  api/        HTTP API 和 Web UI 服务入口
  cli/        RAG ingest、X sync、migrate、stats、ask 命令
  web/        静态聊天页面
packages/
  shared/     共享类型和聊天契约
  knowledge/  产品文档加载、Markdown chunk、tokenize、embedding provider
  rag-core/   意图分类、检索、pgvector store、LLM 回答和交易分析
  agent-core/ LangGraph 客服 Agent runtime、planner、tool registry、产品/交易工具
  product-qa-mcp/   产品问答 MCP stdio server
  tx-analysis-mcp/  交易分析 MCP stdio server
docs/
  product-features/ 产品知识库种子文档和静态资产
```

## 环境准备

```bash
pnpm install
cp .env.example .env
```

`pnpm start`、`pnpm sync` 和 `pnpm rag:*` 会读取项目根目录 `.env`。如果同名变量已经在 shell 里导出，则 shell 环境变量优先。

核心配置示例：

```bash
POSTGRES_DB=xxyy_ask
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=xxyy
POSTGRES_PASSWORD=replace_me_with_a_strong_password

OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=...
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_REQUEST_TIMEOUT_MS=30000
OPENAI_MAX_RETRIES=1

RAG_TOP_K=6
RAG_ANSWER_PROVIDER=openai

TX_ANALYSIS_PROVIDER=none
TX_ANALYSIS_REVIEWER=none
TX_ANALYSIS_BROWSER_HEADLESS=false
TX_ANALYSIS_BROWSER_MAX_CONCURRENCY=1
TX_ANALYSIS_BROWSER_MAX_RETRIES=1
TX_ANALYSIS_BROWSER_TIMEOUT_MS=60000
TX_ANALYSIS_BROWSER_USER_DATA_DIR=
TX_ANALYSIS_CHROME_EXECUTABLE_PATH=
TX_ANALYSIS_DISCOVER_URL=
TX_ANALYSIS_REPORT_STORE=file
TX_ANALYSIS_SCREENSHOT_BASE_URL=/assets
TX_ANALYSIS_SCREENSHOT_DIR=

API_CORS_ORIGIN=
API_MAX_BODY_BYTES=65536
API_RATE_LIMIT_MAX=60
API_RATE_LIMIT_WINDOW_MS=60000
```

数据库默认从 `POSTGRES_*` 组装连接串；使用托管数据库时可以配置 `DATABASE_URL` 覆盖。OpenAI-compatible 请求默认 30 秒超时、重试 1 次。

交易分析 provider：

- `TX_ANALYSIS_PROVIDER=none`：不接真实数据源，交易哈希问题返回暂未启用。
- `TX_ANALYSIS_PROVIDER=mock`：只用于 fixture 演示和测试。
- `TX_ANALYSIS_PROVIDER=browser`：启动本机 Chrome 查询公开交易浏览器和 XXYY 原池子页。遇到公开站点安全验证时，建议保持 `TX_ANALYSIS_BROWSER_HEADLESS=false`，在弹出的 Chrome 中完成验证后重试。

`TX_ANALYSIS_REVIEWER=openai` 会在已抓取交易窗口和规则证据基础上做可选模型复核；复核不可用、超时或返回不可解析内容时，系统保留规则化分析结果。

## 启动

本地启动完整问答服务：

```bash
pnpm start
```

本地模式下，启动脚本会尝试启动本地 pgvector，检查知识库；空库或未迁移时会先执行 ingest，然后做增量 X / Twitter 抓取和 `rag:sync:x`，最后启动 API + Web。

线上常驻服务同样使用：

```bash
NODE_ENV=production pnpm start
```

生产模式不会启动本地 Docker，但仍会检查知识库并执行启动前增量同步。

启动后访问：

```text
http://localhost:3000
```

## 同步与命令

常用入口：

```bash
pnpm start           # 启动前检查/同步知识库，然后启动 API + Web
pnpm sync            # 增量抓取官方 X / Twitter 更新并同步知识库
pnpm sync -- --full  # 全量抓取 X / Twitter 并重建知识库
pnpm check           # lint + format check + typecheck + tests
```

RAG 和数据库命令：

```bash
pnpm rag:ingest
pnpm rag:sync:x
pnpm rag:migrate
pnpm rag:stats
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

- `pnpm rag:ingest` 执行数据库迁移、重新生成 embeddings、写入 pgvector，并记录 ingestion run。
- `pnpm rag:sync:x` 只同步官方 X / Twitter 更新中新增或变更的 chunks，不会 prune 旧知识块。
- `pnpm rag:migrate` 只执行数据库迁移，不调用 embedding 或 LLM。
- `pnpm rag:stats` 查看文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。
- `pnpm rag:ask` 从命令行调用客服 Agent。

服务验收：

```bash
pnpm agent:smoke
```

默认检查 `GET /health`、产品问题路由和边界问题路由。可用 `API_SMOKE_BASE_URL` 指向已启动服务，用 `API_SMOKE_TX_HASH` 额外检查交易分析路线。

MCP：

```bash
pnpm product:mcp
pnpm tx:mcp
TX_ANALYSIS_PROVIDER=mock pnpm tx:mcp:smoke
```

`product:mcp` 暴露 `search_product_docs` 和 `answer_product_question`。`tx:mcp` 暴露 `analyze_transaction`。`tx:mcp:smoke` 通过 stdio MCP client 跑交易分析 MCP 样本，默认使用 `docs/tx-analysis-mcp-smoke-samples.mock.json`，也可传 `-- --tx-samples <file>`。

## HTTP API

Web UI：

```http
GET /
```

健康检查：

```http
GET /health
GET /health/deep
```

`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM。全部可用时返回 `200`；任一项不可用时返回 `503`，并在 `checks` 中给出分项原因。

聊天：

```http
POST /api/chat
POST /api/chat/stream
```

请求示例：

```json
{
  "message": "XXYY Pro 有哪些权益？",
  "channel": "web"
}
```

交易分析：

```http
POST /api/tx-analysis
```

请求示例：

```json
{
  "txHash": "0x...",
  "chain": "base"
}
```

静态资产：

```http
GET /assets/*
```

用于返回产品文档中的视频附件、交易分析截图和本地报告文件等静态资源。

通过 `pnpm start` 启动的 API 会为 `/api/chat` 和 `/api/chat/stream` 输出 JSON line 结构化日志，包含 channel、intent、agentRoute、引用数、耗时、状态码和错误码。日志只记录 `sessionId/userId` 是否存在，不打印用户 ID 明文。

API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat`、`/api/chat/stream` 和 `/api/tx-analysis` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。

## 边界

当前 Agent 只回答 XXYY 产品支持问题和公开交易哈希分析问题。以下请求必须走边界回复：

- 用户账户、订单、钱包余额、私有交易记录等实时私有数据查询。
- 代开通、代取消、代修改等账户或订单操作。
- 投资建议、收益承诺、买卖建议。
- 未支持链、测试网或多笔交易混在同一问题中的交易分析请求。

对边界问题不要编造实时数据；产品问题缺少数据库、embedding 或 chat LLM 配置时应明确失败原因。
