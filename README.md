# xxyy-ask

XXYY 产品客服 Agentic RAG 项目。当前目标是做产品问答客服：基于 XXYY 产品文档和官方 X 更新内容检索知识库，再调用 OpenAI-compatible LLM 生成回答。

第一期不做用户账户查询、交易查询、MEV/夹子检测或投资建议。遇到这类问题时，系统会返回边界回复，不会假装查询实时数据。

## Features

用户可感知功能摘要：

- [x] 产品功能、配置步骤、Pro 权益和官方 X 更新问答。
- [x] 来源引用、流式回答、视频附件和回答反馈。
- [x] 账户、订单、交易记录、MEV/夹子检测和投资建议等边界问题回复。
- [ ] 多轮对话、交易哈希夹子检测、检测截图、工单创建、人工接管和多渠道接入。

完整功能状态见 [docs/feature-status.md](docs/feature-status.md)，后续规划见 [docs/roadmap.md](docs/roadmap.md)。

## 项目结构

```text
apps/
  api/        HTTP API 和 Web UI 入口
  cli/        rag:ingest、rag:sync:x、rag:migrate、rag:ask、rag:evaluate、rag:feedback 命令
  web/        静态聊天页面
packages/
  shared/     共享类型
  knowledge/  文档加载、chunk、tokenize、embedding provider
  rag-core/   意图分类、检索、回答生成、pgvector store、评测
docs/
  product-features/  XXYY 产品知识库种子文档
```

## 环境准备

```bash
pnpm install
cp .env.example .env
```

`pnpm start`、`pnpm sync` 和 `pnpm rag:*` 会读取项目根目录 `.env`。如果同名变量已经在 shell 里导出，则 shell 里的值优先。

## 启动 Agent

`.env` 示例：

```bash
POSTGRES_DB=xxyy_ask
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=xxyy
POSTGRES_PASSWORD=换成强密码

OPENAI_API_KEY=你的_API_Key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=你的回答模型
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_REQUEST_TIMEOUT_MS=30000
OPENAI_MAX_RETRIES=1
RAG_TOP_K=6
RAG_ANSWER_PROVIDER=openai

API_CORS_ORIGIN=
API_MAX_BODY_BYTES=65536
API_OPS_TOKEN=
API_RATE_LIMIT_MAX=60
API_RATE_LIMIT_WINDOW_MS=60000
```

应用会从 `POSTGRES_*` 自动组装数据库连接串。使用外部托管数据库时，也可以只配置 `DATABASE_URL` 覆盖。
`OPENAI_REQUEST_TIMEOUT_MS` 和 `OPENAI_MAX_RETRIES` 是可选项；默认 30 秒超时、重试 1 次。

本地启动完整问答服务：

```bash
pnpm start
```

本地模式下，`pnpm start` 会尝试启动 `docker compose` 里的 pgvector，检查知识库 stats；如果知识库为空或还没迁移，会先跑一次 ingest。随后会执行增量 `x:scrape` 和 `rag:sync:x`，有新内容就更新，没有变化就跳过，最后启动 API 和 Web UI。使用外部数据库时配置 `DATABASE_URL`，启动脚本会跳过本地 Docker。

线上启动常驻服务：

```bash
NODE_ENV=production pnpm start
```

线上模式不会启动本地 Docker，但同样会在服务启动前检查知识库、必要时 ingest，并执行增量 `x:scrape` 和 `rag:sync:x`。需要显式强制线上启动模式时也可以用：

```bash
pnpm start -- --service
```

如果部署平台需要完全跳过启动前同步，只启动 API + Web，可以使用内部入口：

```bash
pnpm start:service
```

然后打开：

```text
http://localhost:3000
```

运维页面：

```text
http://localhost:3000/ops
```

`/ops` 页面不会内置 token，需要手动输入 `API_OPS_TOKEN` 后才会调用受保护的 `/api/ops/summary`。

## 定时同步

线上定时任务只需要跑增量同步：

```bash
pnpm sync
```

`pnpm sync` 默认执行增量 `x:scrape`、`rag:sync:x`、RAG 生产检查，并导出负反馈队列。它适合放进 cron、GitHub Actions、云函数定时器或部署平台 scheduler。按天、周、月执行都可以，取决于你希望知识库更新多快。

低频全量重建：

```bash
pnpm sync -- --full
```

全量模式会全量抓取 X、执行完整 `rag:ingest` 和完整 LLM eval，更适合发布前或文档结构大改后人工触发。

命令行临时提问：

```bash
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

## API

轻量存活检查：

```http
GET /health
```

深度依赖自检：

```http
GET /health/deep
```

`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM。全部可用时返回 `200`；任一项不可用时返回 `503`，并在 `checks` 里给出具体原因，不返回 API key 或数据库密码。

通过 `pnpm start` 启动的 API 会为 `/api/chat` 和 `/api/chat/stream` 输出 JSON line 结构化日志，包含 channel、intent、引用数、耗时、状态码和错误码。日志只记录 `sessionId/userId` 是否存在，不打印用户 ID 明文。

API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat` 和 `/api/chat/stream` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。需要跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。

运维摘要接口默认关闭。配置 `API_OPS_TOKEN` 后可以访问：

```http
GET /api/ops/summary
```

请求需要带 `Authorization: Bearer <API_OPS_TOKEN>` 或 `x-ops-token: <API_OPS_TOKEN>`。响应会聚合 `/health/deep`、知识库 stats 和反馈 stats，用于生产监控、后台页或告警系统；不要把 token 暴露到公开前端。

同源 Web 运维页：

```http
GET /ops
```

聊天接口：

```http
POST /api/chat
```

请求示例：

```json
{
  "message": "如何设置 Telegram 钱包监控？",
  "channel": "web"
}
```

回答质量反馈接口：

```http
POST /api/feedback
```

Web UI 会在每条回答后提供反馈按钮，提交 rating、问题、回答、intent 和引用数量到 Postgres 的 `rag_feedback` 表，不记录明文 `userId`。反馈表由 `pnpm rag:ingest` 的迁移创建，最近反馈和正负反馈数量可以用 `pnpm rag:feedback` 查看；生产 triage 可以用 `pnpm rag:feedback -- --rating negative --limit 25 --json` 导出负反馈队列。

## 常用命令

```bash
pnpm start           # 启动前检查/增量更新知识库，然后启动 API + Web
pnpm sync            # 增量同步知识库，适合线上定时任务
pnpm sync -- --full  # 全量重建知识库，适合发布前或文档结构大改
pnpm check           # lint + format check + typecheck + tests
```

高级调试和排障命令仍然保留：

```bash
pnpm rag:ingest
pnpm rag:sync:x
pnpm rag:migrate
pnpm rag:stats
pnpm rag:feedback
pnpm rag:ask -- "问题"
pnpm rag:evaluate -- --fast
pnpm rag:evaluate
pnpm ops:smoke
```

`pnpm rag:ingest` 会执行数据库迁移、重新生成全部 embeddings、写入 pgvector，并记录一次 ingestion run，包括 run id、文档数、chunk 数、来源分布和内容指纹。`pnpm rag:sync:x` 用来增量同步 X 更新日志：只 embedding 新增或内容变化的 X chunks，不会 prune 旧知识块。`pnpm rag:migrate` 只执行数据库迁移，不调用 embedding 或 LLM。`pnpm rag:stats` 用来查看当前知识库文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。

`pnpm rag:feedback` 用来查看用户反馈总数、正负反馈数量和最近反馈明细，便于把低质量回答补进知识库或评测集。支持 `--rating positive|negative`、`--limit <数量>` 和 `--json`，例如 `pnpm rag:feedback -- --rating negative --limit 25 --json` 可输出可被脚本消费的负反馈队列。

`pnpm sync` 是对底层刷新流程的主入口：默认顺序是增量 `x:scrape`、`rag:sync:x`、RAG 生产检查、导出负反馈 JSON 队列。只刷新本地/已更新文档时可以用 `pnpm sync -- --skip-scrape`，发布前可用 `pnpm sync -- --full` 执行全量 scrape、全量 ingest 和完整 LLM eval。

`pnpm ops:smoke` 用于检查已经启动的 API 服务，默认检查 `http://localhost:3000/health` 和 `/health/deep`。线上可用 `pnpm ops:smoke -- --base-url https://你的域名 --ops-token "$API_OPS_TOKEN"` 检查受保护的 ops summary；加 `--chat` 会额外请求一次 `/api/chat` 并校验回答和 citations。

`pnpm rag:evaluate -- --fast` 仍会使用 embedding + pgvector 检索，但回答阶段使用本地 grounded answer，不调用 chat LLM；适合快速检查检索、引用和边界分类。`pnpm rag:evaluate` 会调用配置的大模型，适合发布前确认最终客服回答质量。

更多产品知识库和运行说明见 [docs/README.md](docs/README.md)。
