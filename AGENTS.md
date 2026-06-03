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

正式模式：

```bash
RAG_VECTOR_STORE=pgvector
DATABASE_URL=postgres://xxyy:password@localhost:5432/xxyy_ask
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

开发 fallback：

```bash
RAG_VECTOR_STORE=local
```

注意：项目当前不会自动加载 `.env`。需要先运行：

```bash
set -a
source .env
set +a
```

## 常用验证

修改代码后优先跑：

```bash
pnpm check
```

聚焦测试可以按文件运行：

```bash
pnpm test apps/cli/src/index.test.ts
pnpm test apps/api/src/index.test.ts
pnpm test packages/rag-core/src/pgvector-store.test.ts
```

关键行为验证：

```bash
RAG_VECTOR_STORE=local pnpm rag:ingest
env -u DATABASE_URL -u OPENAI_API_KEY -u OPENAI_MODEL RAG_VECTOR_STORE=pgvector pnpm rag:ask -- "帮我查一下钱包余额"
env -u DATABASE_URL RAG_VECTOR_STORE=pgvector OPENAI_API_KEY=test-key OPENAI_MODEL=test-model OPENAI_EMBEDDING_MODEL=text-embedding-3-small pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

期望：

- local ingest 成功生成 `.rag/index.json`。
- 边界问题在 pgvector 模式下也不需要 DB/API key，应该返回 `realtime_account_query`。
- 产品问题在 pgvector 模式下缺 `DATABASE_URL` 应明确失败。

## 开发约束

- 优先遵循现有模块边界，不要随意重构 monorepo 结构。
- 不要提交 `.rag/`、`.env`、数据库数据或密钥。
- 不要把真实 API key 写入测试、README 或日志。
- pgvector API 服务端不负责迁移，迁移和写库由 `pnpm rag:ingest` 完成。
- 本地 fallback 必须保持可用。
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
