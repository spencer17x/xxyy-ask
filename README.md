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

`pnpm rag:*` 和 `pnpm start` 会通过 `dotenv` 读取项目根目录 `.env`。如果同名变量已经在 shell 里导出，则 shell 里的值优先。

## 正式运行：Postgres + pgvector

启动本地 pgvector 数据库：

```bash
docker compose up -d postgres
```

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
```

应用会从 `POSTGRES_*` 自动组装数据库连接串。使用外部托管数据库时，也可以只配置 `DATABASE_URL` 覆盖。
`OPENAI_REQUEST_TIMEOUT_MS` 和 `OPENAI_MAX_RETRIES` 是可选项；默认 30 秒超时、重试 1 次。

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

更新产品文档或 X 推文后，建议按这个顺序做质量门禁：

```bash
pnpm rag:ingest
pnpm rag:evaluate
pnpm check
```

更多产品知识库和运行说明见 [docs/README.md](docs/README.md)。
