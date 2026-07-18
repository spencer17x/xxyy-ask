# xxyy-ask

XXYY 客服 Agentic RAG 项目。当前阶段暂时收敛为知识库产品问答：使用 LangGraph JS 编排客服回答，从产品文档和官方 X / Twitter 更新中检索依据，并通过 OpenAI-compatible chat completion 生成带引用回答。

当前运行面只保留知识库问答：

- 产品功能、配置步骤、权益说明和官方更新相关问题会走 Product RAG。
- 交易哈希、公开 explorer 链接、池子查询、链上取证和泛 MEV 问题暂不分析，统一返回边界/澄清回复。
- 暂不暴露 MCP server，也不保留本地 project skills。
- 不查询用户账户、订单、钱包余额或私有交易记录，不提供投资建议。

完整功能状态见 [docs/feature-status.md](docs/feature-status.md)，受控知识演进流程见 [docs/knowledge-evolution.md](docs/knowledge-evolution.md)，生产运行说明见 [docs/production-readiness.md](docs/production-readiness.md)，后续规划见 [docs/roadmap.md](docs/roadmap.md)。

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
EMBEDDING_API_KEY=...
EMBEDDING_BASE_URL=https://api.openai.com/v1
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536
OPENAI_REQUEST_TIMEOUT_MS=30000
OPENAI_MAX_RETRIES=1

RAG_TOP_K=6

API_CORS_ORIGIN=
API_ENABLE_DEEP_HEALTH=
API_MAX_BODY_BYTES=65536
API_RATE_LIMIT_MAX=60
API_RATE_LIMIT_WINDOW_MS=60000
TRUST_PROXY=false

TELEGRAM_BOT_TOKEN=
```

数据库默认从 `POSTGRES_*` 组装连接串；使用托管数据库时可以配置 `DATABASE_URL` 覆盖。`OPENAI_*` 配置 Chat/Planner；`EMBEDDING_API_KEY` 和 `EMBEDDING_BASE_URL` 可把向量请求发送到独立的 OpenAI-compatible 服务，未配置时回退使用 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`。OpenAI-compatible 请求默认 30 秒超时、重试 1 次。默认 embedding 维度是 `1536`，匹配 `text-embedding-3-small`；更换 embedding 模型和维度时需要同步调整 `EMBEDDING_DIMENSION`，备份数据库后显式运行 `pnpm rag:ingest -- --rebuild-embedding-schema`。`.env.example` 会列出当前代码支持的环境变量。

例如 Chat/Planner 使用 Sub2API Grok、embedding 使用独立服务：

```bash
OPENAI_API_KEY=your_sub2api_key
OPENAI_BASE_URL=https://your-sub2api.example/v1
OPENAI_MODEL=grok-4.5

EMBEDDING_API_KEY=your_embedding_key
EMBEDDING_BASE_URL=https://your-embedding-provider.example/v1
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536
```

仅更换 Chat/Planner 模型不需要重建知识库。更换 embedding 供应商时，只有确认新服务实际提供与现有知识库相同的 embedding 模型和维度才能复用现有向量；否则必须执行 embedding schema 重建和全量 ingest。

## 启动

### 后台一键试运行（推荐）

安装 Docker Desktop，并在根目录 `.env` 填好数据库、OpenAI-compatible 模型和 Telegram 配置后运行：

```bash
pnpm run app:up
```

该命令会构建统一应用镜像，在后台启动 PostgreSQL + pgvector，等待数据库健康，执行迁移，只在知识库为空时执行首次 `rag:ingest`，然后启动 API/Web 和 Telegram long polling。容器使用 `restart: unless-stopped`，终端关闭后仍会运行，Docker 重启后也会恢复。

常用运维命令：

```bash
pnpm run app:status   # 查看容器和健康状态
pnpm run app:logs     # 跟随 API 与 Telegram 日志，Ctrl+C 只退出日志
pnpm run app:restart  # 重启 API 与 Telegram
pnpm run app:stop     # 停止 API 与 Telegram，保留数据库运行
pnpm run app:down     # 停止并移除容器，保留数据库 volume
```

默认只监听本机 `127.0.0.1:3000`，访问 `http://localhost:3000` 后可以直接使用 XXYY Agent 问答。不要运行 `docker compose down -v`，该命令会删除本地数据库 volume。

以后迁移到普通 Linux 服务器时可以使用相同的 `pnpm run app:up`。推荐让 Caddy/Nginx 代理本机 `127.0.0.1:3000` 并负责 HTTPS；只有明确配置防火墙或反向代理时才把 `APP_BIND_HOST` 改为 `0.0.0.0`。使用外部托管数据库时设置容器可访问的 `COMPOSE_DATABASE_URL`。

`rag:knowledge:publish` 应在保存 Git 工作区的主机上执行；发布生成的 `docs/product-features/admin-verified/*.md` 需要提交到 Git，不能只留在一次性容器中。

### 前台开发运行

本地启动完整问答服务：

```bash
pnpm run app:dev
```

本地模式下，启动脚本会尝试启动本地 pgvector，构建最新 Web 静态资源，然后启动 API + Web。默认不刷新知识库，避免每次开发启动都触发抓取或写库。

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
pnpm run app:up                  # Docker Compose 后台启动 API + Web + Telegram + pgvector
pnpm run app:status              # 查看后台服务状态
pnpm run app:logs                # 查看后台服务日志
pnpm run app:dev -- --sync       # 启动前增量更新知识库
pnpm run app:dev -- --full-sync  # 启动前全量抓取并重建知识库
pnpm run api:dev                 # 只启动 API + Web 服务入口
pnpm run web:dev                 # 只启动 Vite Web
pnpm run telegram:dev            # 启动 Telegram Bot
pnpm check                       # lint + format check + typecheck + tests + deterministic golden QA
```

RAG 和数据库命令：

```bash
pnpm rag:ingest
pnpm rag:ingest -- --rebuild-embedding-schema # 仅用于有意更换 embedding 维度
pnpm rag:sync:x
pnpm rag:migrate
pnpm rag:stats
pnpm rag:evaluate
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
pnpm rag:knowledge:import:telegram -- export.json --admin-id 123456789
pnpm rag:knowledge:list -- --status pending
```

- `pnpm rag:ingest` 执行数据库迁移、重新生成 embeddings，并在同一事务内替换 pgvector chunks 和记录 ingestion run。
- `pnpm rag:ingest -- --rebuild-embedding-schema` 会事务性清空知识 chunks、按当前 `EMBEDDING_DIMENSION` 重建 embedding 列和向量索引，再写入完整知识库；只在有意更换维度且已备份时使用。
- `pnpm rag:sync:x` 只同步官方 X / Twitter 更新中新增或变更的 chunks，不会 prune 旧知识块。
- `pnpm rag:migrate` 只执行非破坏性数据库迁移，不调用 embedding 或 LLM；若检测到现有向量维度不匹配会明确失败，不会自动删列。
- `pnpm rag:stats` 查看文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。
- `pnpm rag:evaluate` 运行便宜的 deterministic golden QA 子集；`pnpm rag:evaluate -- --provider` 使用正式 Agent/pgvector/OpenAI-compatible provider 做人工全链路评估。
- `pnpm rag:evaluate -- --provider --judge` 在人工验收时额外使用 `EVAL_JUDGE_MODEL` 评分；judge 不进入默认 CI，也不会回退复用 `OPENAI_MODEL`。
- `pnpm rag:evaluate -- --failures-out .rag/eval-failures.jsonl` 把失败项写成已脱敏、必须人工审核的 JSONL，不会直接修改 golden QA。
- `pnpm rag:ask` 从命令行调用客服 Agent。
- `pnpm rag:knowledge:import:telegram` 从 Telegram Desktop JSON 导出中提取“管理员直接回复用户”的产品问答，只写入待审核候选区，不会自动影响线上回答。
- `pnpm rag:knowledge:list/approve/reject/publish` 完成候选知识的人工审核与受控发布；发布会经过边界、检索命中和 deterministic golden QA 门禁。

检索质量：

- 正式产品问答使用 pgvector 向量、Postgres 全文关键词和支持实体候选，并通过 RRF 合并不同分数尺度的 rank；候选阶段保留 source/debug scores 便于评测和排障。
- 内置 `createMetadataReranker()` 是本地 deterministic reranker，使用问题覆盖率、标题/模块/heading、直接来源、列表/步骤证据和当前有效状态做通用二阶段排序，不调用外部模型，也不按具体产品 case 写规则。
- 明确分类为 `product_qa` / `how_to` 的问题直接使用原问题进入产品 RAG；Planner 仅处理模糊路由和 Agent 自述，避免额外改写影响召回。
- LLM relevance judge 或外部 reranker provider 可以按同一接口接入，但应默认关闭，并在有评估用例证明收益后再启用，以避免额外成本和延迟。

## 回答质量闭环

默认 `pnpm rag:evaluate` 同时输出答案断言和已标注样本的 Recall@K、Precision@K、MRR、nDCG@K、forbidden hit；没有 retrieval 标注的案例不会被当作零分。发布或模型/检索变更时再显式运行 provider-backed 路径：

```bash
pnpm rag:evaluate -- --provider
EVAL_JUDGE_MODEL=your-judge-model pnpm rag:evaluate -- --provider --judge
pnpm rag:evaluate -- --provider --failures-out .rag/provider-failures.jsonl
```

LLM judge 只是辅助信号，不能替代 deterministic gate 和人工核验。失败 JSONL 与 `pnpm rag:feedback:backlog` 一样属于 review queue；审核者应核对官方来源、补齐精确 facts/chunk IDs/引用要求，再把去隐私后的稳定案例加入 `docs/eval/golden-qa.jsonl`。完整规则见 [docs/eval/README.md](docs/eval/README.md)。

可选 LangSmith tracing 默认关闭。启用时需要：

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=...
LANGSMITH_PROJECT=xxyy-ask
QUALITY_TRACE_SAMPLE_RATE=0.1
APP_REVISION=$(git rev-parse --short HEAD)
```

未设置采样率时，显式启用 tracing 默认采样 100%；显式设置 `0` 可作为停发开关。trace 只包含脱敏后的问题摘要、route/tool、chunk ID/分数、模型与 prompt 版本、耗时和 token usage，不上传完整 prompt、chunk、答案 delta、session ID、user ID 或密钥。

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

`/health` 是轻量存活检查，不会调用外部模型。`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM，供 Web 的“模型测试”直接调用，不要求鉴权。部署平台的 liveness probe 应使用 `/health`，不要使用 `/health/deep`。

聊天：

```http
POST /api/chat
POST /api/chat/stream
POST /api/feedback
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

API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat`、`/api/chat/stream` 和 `/api/feedback` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。默认不信任 `x-forwarded-for` / `x-real-ip`；只有服务确实位于可信反向代理后，才设置 `TRUST_PROXY=true`。客服问答和反馈接口不要求鉴权。Web 的 👍/👎 会写入 `rag_feedback`；Web/Telegram 中无引用的产品问答也会自动记录为 `automatic_low_evidence`，仅进入人工审核队列，不会直接修改线上知识。跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。公开部署前请先阅读 [production readiness](docs/production-readiness.md)。

## 边界

当前 Agent 只回答 XXYY 产品支持知识库问题。以下请求必须走边界或澄清回复：

- 用户账户、订单、钱包余额、私有交易记录等实时私有数据查询。
- 代开通、代取消、代修改等账户或订单操作。
- 投资建议、收益承诺、买卖建议。
- 交易哈希、交易链接、池子查询、链上取证和泛 MEV 分析请求。

对边界问题不要编造实时数据；产品问题缺少数据库、embedding 或 chat LLM 配置时应明确失败原因。
