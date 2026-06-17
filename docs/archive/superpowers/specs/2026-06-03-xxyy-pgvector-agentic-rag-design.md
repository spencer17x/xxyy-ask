# XXYY 正式 Agentic RAG pgvector 设计

## 背景

当前项目已经有 monorepo 结构、产品知识库文档、本地 `.rag/index.json` 索引、混合检索、LLM 回答生成、CLI、API 和 Web UI。这个版本适合验证产品客服链路，但正式 agent 智能问答系统需要持久化知识库、真实语义 embedding、可共享的检索存储和后续会话/反馈/工具调用扩展点。

本设计把下一阶段限定为“正式 RAG 基础设施”：用 Postgres + pgvector 替代本地 JSON 作为生产检索存储，用 OpenAI-compatible embedding provider 生成真实向量，并保持本地索引作为开发 fallback。

## 目标

- 支持 `Postgres + pgvector + OpenAI embeddings` 的生产知识库检索。
- 保留 `local` vector store，便于无数据库时开发和测试。
- ingest 能把产品文档切片、embedding、metadata 写入 pgvector。
- chat 能从 pgvector 检索 topK chunks，再交给现有 LLM answer provider 生成回答。
- API、CLI、Web 继续复用同一个 `ChatService`，不直接感知数据库细节。
- 为后续会话、反馈、Telegram 用户映射和 MEV 工具调用记录预留数据库边界。

## 非目标

- 本阶段不实现 Telegram bot。
- 本阶段不实现 MEV 检测工具。
- 本阶段不做后台管理 UI。
- 本阶段不迁移聊天历史或用户体系。
- 本阶段不引入 Qdrant、Pinecone、Weaviate 等独立向量数据库。
- 本阶段不让 agent 自动执行交易、监控配置或账户操作。

## 方案选择

推荐方案是 Postgres + pgvector。

它比继续使用 `.rag/index.json` 更适合正式系统，因为多个 API 实例可以共享同一份知识库，ingest 可以覆盖或增量更新数据，后续也能在同一个数据库里承载会话、反馈和工具调用记录。它也比独立向量数据库更适合当前阶段，因为项目还没有大规模多租户检索压力，过早拆分会增加部署和数据一致性成本。

本地 JSON 索引继续存在，但定位变成开发 fallback，不再作为正式路径。

## 配置

新增和保留配置：

```bash
RAG_VECTOR_STORE=local|pgvector
RAG_INDEX_PATH=.rag/index.json
RAG_TOP_K=6

DATABASE_URL=postgres://user:password@localhost:5432/xxyy_ask

OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

默认策略：

- `RAG_VECTOR_STORE` 默认 `local`，避免开发环境没有数据库就无法启动。
- 正式部署设置 `RAG_VECTOR_STORE=pgvector`。
- `OPENAI_EMBEDDING_MODEL` 默认 `text-embedding-3-small`。
- `pgvector` 模式下，ingest 必须有 `DATABASE_URL`、`OPENAI_API_KEY`、`OPENAI_EMBEDDING_MODEL`。
- 产品问答生成仍必须有 `OPENAI_API_KEY` 和 `OPENAI_MODEL`。

## 数据库 Schema

第一期只建知识库表，后续表不提前实现。

```sql
create extension if not exists vector;

create table if not exists knowledge_chunks (
  id text primary key,
  document_id text not null,
  title text not null,
  module text not null,
  source_type text not null check (source_type in ('official_docs', 'x_updates')),
  source_url text,
  file text not null,
  heading_path jsonb not null,
  order_index integer,
  retrieved_at timestamptz,
  content text not null,
  tokens text[] not null,
  embedding vector(1536) not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using ivfflat (embedding vector_cosine_ops);

create index if not exists knowledge_chunks_tokens_idx
  on knowledge_chunks using gin (tokens);

create index if not exists knowledge_chunks_source_type_idx
  on knowledge_chunks (source_type);
```

`embedding vector(1536)` 对应 `text-embedding-3-small`。如果后续换模型，需要新建迁移或增加 embedding model/version 字段，不在第一期混用不同维度。

## 包结构

新增一个存储抽象，避免 API 和 ChatService 直接依赖 pg 包。

```text
packages/
  knowledge/
    chunk-markdown.ts
    load-documents.ts
    index-store.ts
    embedding-provider.ts        # 新增：OpenAI-compatible embedding provider

  rag-core/
    retrieve.ts                  # 本地索引检索继续保留
    vector-store.ts              # 新增：VectorStore 接口
    pgvector-store.ts            # 新增：pgvector 实现
    chat-service.ts              # 通过 Retriever/VectorStore 获取 chunks

apps/
  cli/
    ingest                       # local 或 pgvector ingest
    ask                          # local 或 pgvector ask

  api/
    createRequestHandler         # 根据配置选择 local/pgvector ChatService
```

核心接口：

```ts
interface VectorStore {
  upsertChunks(chunks: EmbeddedChunk[]): Promise<void>;
  retrieve(question: string, options: RetrieveOptions): Promise<RetrievedChunk[]>;
}

interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}
```

`ChatService.ask()` 保持统一入口。`local` 模式下继续从 `RagIndex` 检索；`pgvector` 模式下通过 `VectorStore.retrieve()` 异步检索。

## Ingest 流程

```text
pnpm rag:ingest
  ↓
loadKnowledgeDocuments()
  ↓
chunkMarkdownDocuments()
  ↓
create searchable text
  ↓
embedding provider
  ↓
local: save .rag/index.json
pgvector: migrate schema + upsert knowledge_chunks
```

pgvector ingest 行为：

- 每个 chunk 用稳定 `id` upsert。
- 用 `content_hash` 判断内容是否变化。
- 同一次 ingest 可以覆盖已存在 chunk。
- 删除源文档后遗留 chunk 的清理先不做自动删除；后续可加 `ingest_run_id` 做精确清理。
- embedding 请求分 batch，避免一次请求过大。

## 检索流程

```text
用户问题
  ↓
classifyQuestion()
  ↓
product_qa/how_to
  ↓
embedding(question)
  ↓
pgvector cosine topK + lexical token overlap score
  ↓
source priority rerank
  ↓
LLM answer provider
```

pgvector 检索排序：

- 先用 `embedding <=> query_embedding` 做语义候选。
- 同时计算 token overlap 或用 `tokens && query_tokens` 提升专有词命中。
- 最终分数保留现有思路：语义分 + 词法分 + source preference。
- 官方文档优先于 X updates。
- 返回结构仍是 `RetrievedChunk[]`，保证 answer provider 无需改动。

## API 和前端交互

HTTP 合同不变：

```http
POST /api/chat
```

请求：

```json
{
  "message": "XXYY Pro 有哪些权益？",
  "channel": "web",
  "sessionId": "web-session-1"
}
```

响应仍包含：

- `answer`
- `intent`
- `citations`
- `confidence`

缺少 pgvector 配置时，API 返回可读错误：

```json
{
  "error": "vector_store_configuration_missing",
  "message": "DATABASE_URL is required when RAG_VECTOR_STORE=pgvector."
}
```

## 错误处理

- `local` 模式索引不存在：继续返回 `knowledge_index_missing`。
- `pgvector` 模式缺少 `DATABASE_URL`：返回 `vector_store_configuration_missing`。
- embedding 配置缺失：返回 `embedding_configuration_missing`。
- 数据库连接失败：API 返回 503，CLI 打印错误并退出。
- LLM answer 配置缺失：沿用 `llm_configuration_missing`。
- 非产品问题和边界问题不触发检索，也不触发 embedding。

## 测试策略

单元测试：

- config 正确解析 `RAG_VECTOR_STORE`、`DATABASE_URL`、`OPENAI_EMBEDDING_MODEL`。
- OpenAI embedding provider 正确调用 `/embeddings`，并校验缺失配置。
- VectorStore 接口消费者可以用 fake store 测试 `ChatService`。
- `pgvector` 模式的产品问题会异步检索并调用 answer provider。
- 边界问题不调用 pgvector、embedding 或 LLM。

集成测试：

- 使用可注入 pg client 或测试容器验证 schema/upsert/retrieve。
- 不强制本地开发必须启动 Docker；没有数据库时仍可跑大部分测试。

运行验证：

- `pnpm check`
- `pnpm rag:ingest` 在 local 模式可用。
- `RAG_VECTOR_STORE=pgvector pnpm rag:ingest` 在配置数据库和 embedding 后可用。
- `pnpm rag:ask -- "帮我查一下钱包余额"` 不需要 LLM/embedding，仍返回边界回复。

## 后续扩展

后续可以在同一个 Postgres 中加入：

- `chat_sessions`
- `chat_messages`
- `chat_feedback`
- `telegram_users`
- `tool_runs`
- `mev_detection_jobs`

这些表不在本阶段实现，但 schema 设计应避免把知识库表和用户/会话逻辑耦合在一起。

## 实施顺序

1. 配置层：新增 vector store、database、embedding 配置。
2. Embedding provider：实现 OpenAI-compatible `/embeddings` 调用。
3. 存储接口：新增 `VectorStore` 和 fake store 测试。
4. pgvector schema/upsert：实现数据库写入。
5. pgvector retrieve：实现向量候选与简单 rerank。
6. CLI ingest/ask：根据 `RAG_VECTOR_STORE` 选择 local 或 pgvector。
7. API loader：根据配置选择 local 或 pgvector ChatService。
8. 文档：补 Docker Postgres + pgvector 运行方式。

## 验收标准

- local 模式保持可用。
- pgvector 模式能把当前产品知识库写入数据库。
- pgvector 模式能回答产品客服问题，并返回 citations。
- 缺少数据库、embedding 或 LLM 配置时，CLI/API 都给出明确错误。
- 边界问题不触发数据库检索和 LLM。
- 全量 `pnpm check` 通过。
