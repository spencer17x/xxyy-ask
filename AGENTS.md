# AGENTS.md

给 Codex 和其他代码代理使用的项目指令。

## 项目目标

这是 XXYY 产品客服 Agentic RAG 系统。当前阶段只做产品问答客服：

- 可以回答 XXYY 产品功能、配置步骤、权益说明、文档更新等问题。
- 不直接查询用户账户、订单、钱包余额、交易记录。
- 不做 MEV/夹子检测。
- 不提供投资建议。
- 对边界问题必须返回边界回复，不要编造实时数据。

## 技术栈

- TypeScript ESM
- pnpm workspace
- Vitest
- Node `fetch`
- Postgres + pgvector
- OpenAI-compatible `/embeddings` 和 `/chat/completions`

## 目录职责

- `packages/shared`：共享类型和聊天契约。
- `packages/knowledge`：产品文档加载、Markdown chunk、tokenize、本地索引、OpenAI embedding provider。
- `packages/rag-core`：意图分类、检索接口、pgvector store、反馈 store、LLM answer provider、评测。
- `apps/cli`：`rag:ingest`、`rag:sync:x`、`rag:migrate`、`rag:stats`、`rag:feedback`、`rag:ask`、`rag:evaluate`。
- `apps/api`：HTTP API 和 Web UI 服务入口。
- `apps/web`：静态聊天 UI。
- `docs/product-features`：知识库种子文档。

## 运行模式

当前项目只保留正式 Agentic RAG 路径：Postgres + pgvector + OpenAI-compatible embeddings。

```bash
POSTGRES_DB=xxyy_ask
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=xxyy
POSTGRES_PASSWORD=replace_me_with_a_strong_password
OPENAI_API_KEY=...
OPENAI_MODEL=...
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

`pnpm start`、`pnpm sync` 和 `pnpm rag:*` 会读取项目根目录 `.env`。同名 shell 环境变量优先于 `.env`。
主入口是 `pnpm start`、`pnpm sync` 和 `pnpm check`：本地 `pnpm start` 会尝试启动本地 pgvector、检查知识库并在空库时 ingest，然后执行增量 `x:scrape` 和 `rag:sync:x`，最后启动 API + Web；线上用 `NODE_ENV=production pnpm start` 会跳过本地 Docker，但同样会做知识库检查和增量同步；完全跳过启动前同步的内部入口是 `pnpm start:service`。线上定时增量更新用 `pnpm sync`，低频全量重建用 `pnpm sync -- --full`。
OpenAI-compatible 请求默认 30 秒超时、重试 1 次；需要调整时再配置 `OPENAI_REQUEST_TIMEOUT_MS` 和 `OPENAI_MAX_RETRIES`。
API 的 `GET /health` 是轻量存活检查；`GET /health/deep` 是生产依赖自检，会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM，失败时返回 503 和分项原因。
通过 `pnpm start` 启动的 API 会为 `/api/chat` 和 `/api/chat/stream` 输出 JSON line 结构化日志，包含 channel、intent、引用数、耗时、状态码和错误码；只记录 `sessionId/userId` 是否存在，不打印用户 ID 明文。
API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat` 和 `/api/chat/stream` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。
`GET /api/ops/summary` 是受保护的运维摘要接口，默认关闭；配置 `API_OPS_TOKEN` 后才可用。请求必须带 `Authorization: Bearer <token>` 或 `x-ops-token`，响应聚合 deep health、知识库 stats 和反馈 stats。`GET /ops` 提供同源运维页，但页面不内置 token，需要手动输入。不要把 `API_OPS_TOKEN` 暴露到公开前端。
Web UI 会把每条回答后的正负反馈提交到 `POST /api/feedback`，API 写入 Postgres `rag_feedback` 表，不记录明文 `userId`。反馈表迁移由 `pnpm rag:ingest` 完成，`pnpm rag:feedback` 可查看反馈数量和最近反馈明细。

## 常用验证

修改代码后优先跑：

```bash
pnpm check
```

更新产品文档、X 推文或检索/回答逻辑后，优先跑：

```bash
pnpm sync
pnpm check
```

如果改了正式文档结构、需要重建全部知识库，或要做发布前全量确认，再跑 `pnpm sync -- --full`。

`pnpm rag:ingest` 会执行数据库迁移、重新生成全部 embeddings、写入 pgvector，并记录 ingestion run，包括 run id、文档数、chunk 数、来源分布和内容指纹。`pnpm rag:sync:x` 用于 X 更新日志增量入库：读取当前 X 文档和 JSONL，按 DB 里的 chunk content hash 只 embedding 新增或变更的 X chunks，并且不会 prune 旧 chunk。`pnpm rag:migrate` 只执行数据库迁移，不调用 embedding 或 LLM。`pnpm rag:stats` 用于查看当前知识库文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。

`pnpm rag:feedback -- --rating negative --limit 25 --json` 用于导出负反馈 triage 队列，方便把低质量回答补进知识库或评测集。不要在反馈记录里写入明文用户身份或密钥。

`pnpm x:scrape` 默认是增量抓取：读取 `docs/product-features/sources/usexxyyio-x-posts.jsonl` 的最新推文时间，只获取该时间之后的 @useXXYYio 公开主页更新并合并写回；`pnpm x:scrape -- --full` 才会全量重抓。

`pnpm sync` 是知识库更新流水线，默认执行增量 `x:scrape`、`rag:sync:x`、RAG 生产检查，最后导出负反馈 JSON 队列。用 `pnpm sync -- --skip-scrape` 跳过 X 抓取，用 `pnpm sync -- --full` 才会执行全量 `x:scrape -- --full`、`rag:ingest` 和完整 LLM eval。

`pnpm ops:smoke` 用于检查已经启动的 API 服务，默认检查 `/health` 和 `/health/deep`。线上检查可传 `--base-url` 和 `--ops-token`，加 `--chat` 会额外调用一次 `/api/chat` 并校验回答和 citations。

`pnpm rag:evaluate -- --fast` 使用 embedding + pgvector 检索，但回答阶段走本地 grounded answer，不调用 chat LLM；用来快速定位检索、引用和边界分类问题。`pnpm rag:evaluate` 会调用配置的大模型，用于发布前验证最终回答质量。

聚焦测试可以按文件运行：

```bash
pnpm test apps/cli/src/index.test.ts
pnpm test apps/api/src/index.test.ts
pnpm test packages/rag-core/src/pgvector-store.test.ts
```

关键行为验证：

```bash
env -u DATABASE_URL -u POSTGRES_DB -u POSTGRES_USER -u POSTGRES_PASSWORD -u OPENAI_API_KEY -u OPENAI_MODEL pnpm rag:ask -- "帮我查一下钱包余额"
env -u DATABASE_URL -u POSTGRES_DB -u POSTGRES_USER -u POSTGRES_PASSWORD OPENAI_API_KEY=test-key OPENAI_MODEL=test-model OPENAI_EMBEDDING_MODEL=text-embedding-3-small pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

期望：

- 边界问题不需要 DB/API key，应该返回 `realtime_account_query`。
- 产品问题缺 `DATABASE_URL` 或 `POSTGRES_*` 应明确失败。

## 开发约束

- 优先遵循现有模块边界，不要随意重构 monorepo 结构。
- 不要提交 `.rag/`、`.env`、数据库数据或密钥。
- 不要在 `docker-compose.yml` 写死数据库密码；使用 `.env` 注入。
- 不要把真实 API key 写入测试、README 或日志。
- 生产 API 服务端不负责迁移，迁移和写库由 `pnpm sync`、`pnpm rag:ingest` 或 `pnpm rag:sync:x` 完成；本地 `pnpm start` 的启动脚本可以为空知识库做首次 bootstrap。
- 新增行为需要加测试；风险较高的改动跑 `pnpm check`。
- 对外错误信息应清晰区分：
  - LLM 配置缺失
  - embedding 配置缺失
  - vector store 配置缺失
  - vector store 运行时不可用

## Git 状态提示

当前本地 `main` 可能领先 `origin/main`。提交前先看：

```bash
git status --short --branch
```
