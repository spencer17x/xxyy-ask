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
- `packages/rag-core`：意图分类、检索接口、pgvector store、LLM answer provider、评测。
- `apps/cli`：`rag:ingest`、`rag:ask`、`rag:evaluate`。
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
```

`pnpm rag:*` 和 `pnpm start` 会通过 `dotenv` 读取项目根目录 `.env`。同名 shell 环境变量优先于 `.env`。
OpenAI-compatible 请求默认 30 秒超时、重试 1 次；需要调整时再配置 `OPENAI_REQUEST_TIMEOUT_MS` 和 `OPENAI_MAX_RETRIES`。

## 常用验证

修改代码后优先跑：

```bash
pnpm check
```

更新产品文档、X 推文或检索/回答逻辑后，优先跑完整质量门禁：

```bash
pnpm rag:ingest
pnpm rag:evaluate -- --fast
pnpm rag:evaluate
pnpm check
```

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
- API 服务端不负责迁移，迁移和写库由 `pnpm rag:ingest` 完成。
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
