# xxyy-ask

XXYY 产品客服 Agentic RAG 项目。当前目标是做产品问答客服：基于 XXYY 产品文档和官方 X 更新内容检索知识库，再调用 OpenAI-compatible LLM 生成回答。

第一期不做用户账户查询、交易查询、MEV/夹子检测或投资建议。遇到这类问题时，系统会返回边界回复，不会假装查询实时数据。

## 项目结构

```text
apps/
  api/        HTTP API 和 Web UI 入口
  cli/        rag:ingest、rag:ask、rag:evaluate 命令
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

当前项目不会自动加载 `.env`。运行命令前需要在 shell 里加载：

```bash
set -a
source .env
set +a
```

## 正式运行：Postgres + pgvector

启动本地 pgvector 数据库：

```bash
docker compose up -d postgres
```

`.env` 示例：

```bash
RAG_VECTOR_STORE=pgvector
DATABASE_URL=postgres://xxyy:password@localhost:5432/xxyy_ask

OPENAI_API_KEY=你的_API_Key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=你的回答模型
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

写入知识库：

```bash
pnpm rag:ingest
```

命令行提问：

```bash
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

启动 API 和 Web UI：

```bash
pnpm start
```

然后打开：

```text
http://localhost:3000
```

## 本地 fallback

不用数据库临时开发时，可以使用本地索引模式：

```bash
export RAG_VECTOR_STORE=local
pnpm rag:ingest
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
pnpm start
```

本地索引写入 `.rag/index.json`，该目录不提交。

## API

健康检查：

```http
GET /health
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

## 常用命令

```bash
pnpm check          # lint + format check + typecheck + tests
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm rag:ingest
pnpm rag:ask -- "问题"
pnpm rag:evaluate
pnpm start
```

更多产品知识库和运行说明见 [docs/README.md](docs/README.md)。
