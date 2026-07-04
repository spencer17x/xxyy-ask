# xxyy-ask

XXYY 客服 Agentic RAG 项目。当前阶段暂时收敛为知识库产品问答：使用 LangGraph JS 编排客服回答，从产品文档和官方 X / Twitter 更新中检索依据，并通过 OpenAI-compatible chat completion 生成带引用回答。

当前运行面只保留知识库问答：

- 产品功能、配置步骤、权益说明和官方更新相关问题会走 Product RAG。
- 交易哈希、公开 explorer 链接、池子查询、链上取证和泛 MEV 问题暂不分析，统一返回边界/澄清回复。
- 暂不暴露 MCP server，也不保留本地 project skills。
- 不查询用户账户、订单、钱包余额或私有交易记录，不提供投资建议。

完整功能状态见 [docs/feature-status.md](docs/feature-status.md)，后续规划见 [docs/roadmap.md](docs/roadmap.md)。

## 项目结构

```text
apps/
  api/          HTTP API 和 Web UI 服务入口
  cli/          RAG ingest、X sync、migrate、stats、ask 命令
  telegram-bot/ Telegram Bot long polling 入口
  web/          静态聊天页面
packages/
  shared/       共享类型和聊天契约
  knowledge/    产品文档加载、Markdown chunk、tokenize、embedding provider
  rag-core/     意图分类、检索、pgvector store、LLM 回答和边界回复
  agent-core/   LangGraph 客服 Agent runtime、planner、tool registry、产品问答工具
docs/
  product-features/ 产品知识库种子文档和静态资产
```

## 环境准备

```bash
pnpm install
cp .env.example .env
```

`pnpm run app:dev`、`pnpm run *:dev` 和 `pnpm rag:*` 会读取项目根目录 `.env`。如果同名变量已经在 shell 里导出，则 shell 环境变量优先。

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
EMBEDDING_DIMENSION=1536
OPENAI_REQUEST_TIMEOUT_MS=30000
OPENAI_MAX_RETRIES=1

RAG_TOP_K=6
RAG_ANSWER_PROVIDER=openai

API_CORS_ORIGIN=
API_CHAT_AUTH_TOKEN=
API_REQUIRE_CHAT_AUTH=
API_DEEP_HEALTH_TOKEN=
API_ENABLE_DEEP_HEALTH=
API_MAX_BODY_BYTES=65536
API_RATE_LIMIT_MAX=60
API_RATE_LIMIT_WINDOW_MS=60000
TRUST_PROXY=false

TELEGRAM_BOT_TOKEN=
```

数据库默认从 `POSTGRES_*` 组装连接串；使用托管数据库时可以配置 `DATABASE_URL` 覆盖。OpenAI-compatible 请求默认 30 秒超时、重试 1 次。默认 embedding 维度是 `1536`，匹配 `text-embedding-3-small`；更换 embedding 模型时需要同步调整 `EMBEDDING_DIMENSION`，并对 pgvector schema 做迁移后重新 ingest。`.env.example` 会列出当前代码支持的环境变量。

## 启动

本地启动完整问答服务：

```bash
pnpm run app:dev
```

本地模式下，启动脚本会尝试启动本地 pgvector，然后启动 API + Web。默认不刷新知识库，避免每次开发启动都触发抓取或写库。

需要在启动前更新知识库时显式传参：

```bash
pnpm run app:dev -- --sync       # 增量抓取 X / Twitter 并同步知识库后启动
pnpm run app:dev -- --full-sync  # 全量抓取 X / Twitter 并重建知识库后启动
pnpm run app:dev -- --ingest     # 只重建知识库后启动
```

生产模式不会启动本地 Docker：

```bash
NODE_ENV=production pnpm run app:dev
NODE_ENV=production pnpm run app:dev -- --sync
```

启动后访问：

```text
http://localhost:3000
```

## 同步与命令

常用入口：

```bash
pnpm run app:dev                 # 启动 API + Web，默认不刷新知识库
pnpm run app:dev -- --sync       # 启动前增量更新知识库
pnpm run app:dev -- --full-sync  # 启动前全量抓取并重建知识库
pnpm run api:dev                 # 只启动 API + Web 服务入口
pnpm run web:dev                 # 只启动 Vite Web
pnpm run telegram:dev            # 启动 Telegram Bot
pnpm check                       # lint + format check + typecheck + tests
```

RAG 和数据库命令：

```bash
pnpm rag:ingest
pnpm rag:sync:x
pnpm rag:migrate
pnpm rag:stats
pnpm rag:evaluate
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

- `pnpm rag:ingest` 执行数据库迁移、重新生成 embeddings、写入 pgvector，并记录 ingestion run。
- `pnpm rag:sync:x` 只同步官方 X / Twitter 更新中新增或变更的 chunks，不会 prune 旧知识块。
- `pnpm rag:migrate` 只执行数据库迁移，不调用 embedding 或 LLM。
- `pnpm rag:stats` 查看文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。
- `pnpm rag:evaluate` 运行便宜的 deterministic golden QA 子集；`pnpm rag:evaluate -- --provider` 使用正式 Agent/pgvector/OpenAI-compatible provider 做人工全链路评估。
- `pnpm rag:ask` 从命令行调用客服 Agent。

服务验收：

```bash
pnpm agent:smoke
```

默认检查 `GET /health`、产品问题路由和边界问题路由。

## Telegram Bot

```bash
pnpm run telegram:dev
```

配置 `TELEGRAM_BOT_TOKEN` 后，Bot 会通过 long polling 接收文本消息，并以 `channel: "telegram"` 调用同一套 LangGraph 客服 Agent。图片附件公网 URL、轮询超时和重试间隔都有默认处理，只有特殊部署才需要额外覆盖。

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

`/health` 是轻量存活检查，不会调用外部模型。`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM。开发模式默认开放；生产模式默认禁用，配置 `API_DEEP_HEALTH_TOKEN` 后需要用 `Authorization: Bearer <token>` 访问。部署平台的 liveness probe 应使用 `/health`，不要使用 `/health/deep`。

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

静态资产：

```http
GET /assets/*
```

用于返回产品文档中的视频、图片等静态资源。

通过 `pnpm run app:dev` 或 `pnpm run api:dev` 启动的 API 会为 `/api/chat` 和 `/api/chat/stream` 输出 JSON line 结构化日志，包含 channel、intent、agentRoute、引用数、耗时、状态码、错误码、消息长度和脱敏截断后的消息预览等字段。日志只记录 `sessionId/userId` 是否存在，不打印用户 ID 明文，并会脱敏密钥、交易哈希、地址、邮箱和手机号等敏感片段。

API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat` 和 `/api/chat/stream` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。默认不信任 `x-forwarded-for` / `x-real-ip`；只有服务确实位于可信反向代理后，才设置 `TRUST_PROXY=true`。生产模式默认要求 chat 鉴权，配置 `API_CHAT_AUTH_TOKEN` 后用 `Authorization: Bearer <token>` 或 `x-api-key` 调用；本地开发默认不要求。跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。

## 边界

当前 Agent 只回答 XXYY 产品支持知识库问题。以下请求必须走边界或澄清回复：

- 用户账户、订单、钱包余额、私有交易记录等实时私有数据查询。
- 代开通、代取消、代修改等账户或订单操作。
- 投资建议、收益承诺、买卖建议。
- 交易哈希、交易链接、池子查询、链上取证和泛 MEV 分析请求。

对边界问题不要编造实时数据；产品问题缺少数据库、embedding 或 chat LLM 配置时应明确失败原因。
