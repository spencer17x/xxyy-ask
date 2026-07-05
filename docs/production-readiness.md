# Production Readiness

本文档记录 XXYY 客服 Agentic RAG 服务公开部署前的安全、观测、配额、迁移、备份和交接要求。当前运行面只暴露产品知识库问答，不接入账户、订单、钱包余额、链上取证、投资建议或自动工单操作。

## Request Tracing

每个 chat 请求都应带 `requestId`。如果调用方没有传入，API 会生成一个 request id；Telegram Bot 使用 `telegram:<chat_id>:<message_id>` 作为请求 id。`requestId` 会进入客服 runtime、planner 和结构化日志，用于把一次请求的 guard、planner route、tool route、最终 intent、引用数量和错误码串起来。

API 为 `/api/chat` 和 `/api/chat/stream` 输出 JSON line 日志。核心字段包括：

- `requestId`、`route`、`channel`、`statusCode`、`durationMs`、`outcome`。
- `agentRoute`、`intent`、`confidence`、`citationCount`、`attachmentCount`。
- `messageLength` 和脱敏截断后的 `messagePreview`。
- `sessionIdPresent`、`userIdPresent`，不记录 session id 或 user id 明文。
- 错误时记录 `error`，例如配置缺失、vector store 不可用或 LLM 配置缺失。

日志不打印 API key、私钥、助记词、密码、交易哈希、地址、邮箱和手机号等敏感片段。模型 prompt 侧也会对用户问题和检索片段执行同一类敏感文本脱敏，避免只在日志层脱敏。

## Auth And Key Rotation

生产模式默认要求 chat 鉴权。调用方可以使用：

```http
Authorization: Bearer <token>
```

或：

```http
x-api-key: <token>
```

配置项：

- `API_CHAT_AUTH_TOKEN`：兼容旧部署的单个 token。
- `API_CHAT_AUTH_TOKENS`：逗号分隔的 token 列表，用于 current / next key 并行轮换。
- `API_REQUIRE_CHAT_AUTH`：生产默认 `true`，本地开发默认 `false`。
- `API_DEEP_HEALTH_TOKEN`：只保护 `/health/deep`，不要和 chat token 复用。

轮换步骤：

1. 在密钥管理系统中生成 next token，不写入代码、README、issue 或日志。
2. 设置 `API_CHAT_AUTH_TOKENS=current-token,next-token`，保留 `API_CHAT_AUTH_TOKEN` 兼容旧客户端时也可以同时配置。
3. 部署服务，确认 current 和 next token 都能访问 `/api/chat`。
4. 更新调用方使用 next token，并观察 401、请求量和业务错误。
5. 等待旧客户端切换完成后，从环境变量移除 current token，再部署一次。

审计系统如果需要记录 token 使用情况，应在网关或调用方记录不可逆 token fingerprint，例如 HMAC 或 SHA-256 后的前缀。API 服务本身不记录 token 明文，也不在日志中输出 token fingerprint。

## Abuse Control

API 内置基础保护：

- `API_MAX_BODY_BYTES` 限制 JSON 请求体大小，默认 `65536` 字节。
- `API_RATE_LIMIT_MAX` 和 `API_RATE_LIMIT_WINDOW_MS` 对 `/api/chat` 和 `/api/chat/stream` 按客户端地址限流，默认 `60` 次 / `60000` 毫秒。
- `TRUST_PROXY=false` 时只使用 socket 地址；只有在可信反向代理后才设置 `TRUST_PROXY=true` 并读取 `x-forwarded-for` / `x-real-ip`。

公开部署时仍应在网关层增加共享配额，因为进程内限流不适合多实例全局控制：

- 按 API key、用户、session、channel 和 IP 组合限流。
- 对匿名 Web 流量设置更低 burst，对 Telegram 或可信服务端调用设置独立配额。
- 对 401、429、5xx、超大请求体和高成本模型调用做告警。
- 多实例部署时使用网关、Redis 或 API gateway 的共享限流，而不是依赖单个 Node 进程内存。

## Data Privacy And Retention

当前系统不主动查询私有账户、订单、钱包余额或私有交易记录。对用户主动贴入的敏感文本，处理原则如下：

- 日志只保留脱敏后的 `messagePreview` 和长度，不保留完整明文问题。
- `rag_feedback` 会写入反馈问题、答案、intent、引用数和评论；写入前会脱敏凭证类文本。
- LLM prompt 会脱敏用户问题和检索片段中的凭证类文本。
- `requestId` 可以用于排查单次请求，但不要把它设计成长期用户标识。

建议保留策略：

- API 请求日志：默认 30 天，安全事件可按事件号延长。
- 负反馈和 eval backlog：默认 90 到 180 天，进入 golden QA 的案例应由人工改写，去掉用户私有信息。
- `rag_ingestion_runs`：作为知识库版本和发布审计记录长期保留。
- 原始 `.env`、临时导出、模型请求样本和手工排障文件不应进入仓库。

删除流程：

1. 根据 `requestId`、`sessionId`、时间窗口或外部工单号定位日志和反馈记录。
2. 删除或匿名化 `rag_feedback` 中对应记录。
3. 删除对象存储、日志平台和本地排障文件中的相同样本。
4. 记录删除动作的操作者、时间和范围，不记录被删除的敏感正文。

## Deployment And Operations

生产模式不会启动本地 Docker，也不会由 API 服务自动迁移或写库。迁移和知识库写入必须走显式命令。

Docker / container 要求：

- 镜像只包含构建产物和依赖，不包含 `.env`、`.rag/`、数据库数据或密钥。
- 运行时通过平台 secret 注入 `OPENAI_API_KEY`、数据库凭据、chat token 和 deep health token。
- 容器启动命令只启动 API / Web 服务；迁移、ingest 和 sync 使用独立 release job 或一次性任务执行。
- liveness probe 使用 `/health`，readiness 或发布自检可以使用带 token 的 `/health/deep`。

推荐发布流程：

1. 准备生产环境变量，使用密钥管理系统注入，不把 `.env` 打包进镜像。
2. 运行 `pnpm rag:migrate`，只执行数据库迁移，不调用 embedding 或 LLM。
3. 首次部署或全量重建时运行 `pnpm rag:ingest`。
4. 日常同步官方 X / Twitter 更新时运行 `pnpm rag:sync:x`。
5. 启动服务后用 `/health` 做 liveness，用带 Bearer token 的 `/health/deep` 做发布或值班自检。
6. 运行 `pnpm agent:smoke` 验证 health、产品问题路线和边界路线。

备份要求：

- 对 Postgres 做定期 `pg_dump` 或托管快照，并覆盖 `knowledge_chunks`、`rag_ingestion_runs` 和 `rag_feedback`。
- 每次 embedding 模型、`EMBEDDING_DIMENSION` 或正式文档结构变化前先备份。
- 定期在临时库恢复备份，并运行 `pnpm rag:stats` 和 `pnpm rag:evaluate` 验证可用性。

pgvector 注意事项：

- 当前迁移会创建 `vector` extension、`knowledge_chunks_embedding_idx` cosine `ivfflat` 索引和 `knowledge_chunks_tokens_idx` GIN 索引。
- 更换 embedding 模型或维度时，必须同步调整 `EMBEDDING_DIMENSION`，迁移 schema，并重新 `pnpm rag:ingest`。
- 调整 `RAG_TOP_K`、索引参数或重建索引后，先跑 `pnpm check` 和 provider-backed eval 抽样，确认引用质量没有下降。

## Human Handoff And Tickets

当前服务不创建工单、不承诺人工接管，也不执行账户、订单或钱包操作。未来如果接入 ticketing / CRM，必须先满足这些边界：

- 工单工具必须有独立权限和审计，不能复用普通 chat token。
- 自动创建工单前需要用户确认要提交哪些字段。
- 工单正文不得包含私钥、助记词、API key、密码或完整钱包敏感信息。
- 工单记录至少包含 `requestId`、channel、用户确认时间、提交字段摘要和操作者来源。
- 工单保留、删除和导出策略必须和 `rag_feedback`、日志平台一致。

在这些条件完成前，客服 Agent 只能给出自助下一步或边界说明，不能暗示已经有人接管。
