# AGENTS.md

给 Codex 和其他代码代理使用的项目指令。

## 项目目标

这是 XXYY 客服 Agentic RAG 系统。当前阶段使用 LangGraph JS 作为 Agent Runtime，但运行面暂时收敛为知识库产品问答：产品问题调用 Product RAG，系统会自动根据官方 X / Twitter 和产品文档更新知识库。

当前边界：

- 可以回答 XXYY 产品功能、配置步骤、权益说明和官方更新相关问题。
- 交易哈希、公开 explorer 链接、池子查询、链上取证和泛 MEV 问题暂不分析，必须返回边界或澄清回复。
- 暂不暴露 MCP server，也不保留本地 project skills。
- 不直接查询用户账户、订单、钱包余额或私有交易记录。
- 不提供投资建议。
- 对边界问题必须返回边界回复，不要编造实时数据。

## 技术栈

- TypeScript ESM
- pnpm workspace
- Vitest
- LangGraph JS
- Node `fetch`
- Postgres + pgvector
- OpenAI-compatible `/embeddings` 和 `/chat/completions`

## 目录职责

- `packages/shared`：共享类型和聊天契约。
- `packages/knowledge`：产品文档加载、Markdown chunk、tokenize 和 OpenAI embedding provider。
- `packages/rag-core`：意图分类、检索接口、pgvector store、LLM answer provider、边界回复和配置错误类型。
- `packages/agent-core`：LangGraph 客服 Agent runtime、planner、tool registry 和产品问答工具定义。
- `apps/cli`：`rag:ingest`、`rag:sync:x`、`rag:migrate`、`rag:stats`、`rag:evaluate`、`rag:ask`。
- `apps/api`：HTTP API 和 Web UI 服务入口。
- `apps/telegram-bot`：Telegram Bot long polling 入口。
- `apps/web`：静态聊天 UI。
- `docs/product-features`：知识库种子文档和静态资产。

## 运行模式

当前项目保留正式 Agentic RAG 路径：Postgres + pgvector + OpenAI-compatible embeddings/chat。

```bash
POSTGRES_DB=xxyy_ask
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=xxyy
POSTGRES_PASSWORD=replace_me_with_a_strong_password
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=...
EMBEDDING_API_KEY=
EMBEDDING_BASE_URL=
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
```

`pnpm run app:dev`、`pnpm run *:dev` 和 `pnpm rag:*` 会读取项目根目录 `.env`。同名 shell 环境变量优先于 `.env`。

`OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 配置 Chat/Planner。可用 `EMBEDDING_API_KEY` 和 `EMBEDDING_BASE_URL` 将 embedding 请求发送到独立的 OpenAI-compatible 服务；未配置时回退使用对应的 `OPENAI_*` 配置。

主入口：

- `pnpm run app:dev`：本地会尝试启动 pgvector，然后启动 API + Web；默认不刷新知识库。
- `pnpm run app:dev -- --sync`：启动前检查知识库，空库时 ingest，然后执行增量 X / Twitter 抓取和 `rag:sync:x`。
- `pnpm run app:dev -- --full-sync`：启动前全量抓取 X / Twitter 并重建知识库。
- `pnpm run app:dev -- --ingest`：启动前只执行知识库 ingest。
- `NODE_ENV=production pnpm run app:dev`：生产模式跳过本地 Docker，默认不刷新知识库；可加 `--sync` 或 `--full-sync` 显式更新。
- `pnpm run telegram:dev`：启动 Telegram Bot long polling。
- `pnpm check`：lint、format check、typecheck、tests 和 deterministic golden QA。

API 保留的公开服务面：

- `GET /`：Web UI。
- `GET /health`：轻量存活检查。
- `GET /health/deep`：模型连通性检查，检查必填配置、pgvector 知识库、embedding 模型和 chat LLM；Web 的“模型测试”直接调用，不要求鉴权。
- `POST /api/chat`：非流式客服问答。
- `POST /api/chat/stream`：流式客服问答。
- `GET /assets/*`：产品视频、图片等静态资产。

API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat` 和 `/api/chat/stream` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。默认不信任 `x-forwarded-for` / `x-real-ip`；仅在可信反向代理后设置 `TRUST_PROXY=true`。客服问答接口不要求鉴权。跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。

## 常用验证

修改代码后优先跑：

```bash
pnpm check
```

更新产品文档、X / Twitter 数据或检索/回答逻辑后，优先跑：

```bash
pnpm run app:dev -- --sync
pnpm check
```

如果改了正式文档结构、需要重建全部知识库，或要做发布前全量确认，再跑：

```bash
pnpm run app:dev -- --full-sync
```

命令说明：

- `pnpm rag:ingest`：执行数据库迁移、重新生成全部 embeddings、写入 pgvector，并记录 ingestion run。
- `pnpm rag:sync:x`：同步官方 X / Twitter 更新，只 embedding 新增或变更的 X chunks，不会 prune 旧 chunk。
- `pnpm rag:migrate`：只执行数据库迁移，不调用 embedding 或 LLM。
- `pnpm rag:stats`：查看当前知识库文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。
- `pnpm rag:evaluate`：运行便宜的 deterministic golden QA 子集；`pnpm rag:evaluate -- --provider` 使用正式 Agent/pgvector/OpenAI-compatible provider 做人工全链路评估。
- `pnpm rag:ask -- "问题"`：命令行临时调用客服 Agent。
- `pnpm agent:smoke`：检查已启动服务的 health、产品问题路线和边界路线。

关键行为验证：

```bash
env -u DATABASE_URL -u POSTGRES_DB -u POSTGRES_USER -u POSTGRES_PASSWORD -u OPENAI_API_KEY -u OPENAI_MODEL pnpm rag:ask -- "帮我查一下钱包余额"
env -u DATABASE_URL -u POSTGRES_DB -u POSTGRES_USER -u POSTGRES_PASSWORD OPENAI_API_KEY=test-key OPENAI_MODEL=test-model OPENAI_EMBEDDING_MODEL=text-embedding-3-small pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

期望：

- 边界问题不需要 DB/API key，应该返回 `realtime_account_query` 或其它边界/澄清结果。
- 产品问题缺 `DATABASE_URL` 或 `POSTGRES_*` 应明确失败。

## 开发约束

- 优先遵循现有模块边界，不要随意重构 monorepo 结构。
- 不要提交 `.rag/`、`.env`、数据库数据或密钥。
- 不要在 `docker-compose.yml` 写死数据库密码；使用 `.env` 注入。
- 不要把真实 API key 写入测试、README 或日志。
- 生产 API 服务端不负责迁移；迁移和写库由 `pnpm run app:dev -- --sync`、`pnpm run app:dev -- --full-sync`、`pnpm rag:ingest` 或 `pnpm rag:sync:x` 完成。本地 `pnpm run app:dev -- --sync` 可以为空知识库做首次 bootstrap。
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
