# AGENTS.md

给 Codex 和其他代码代理使用的项目指令。

## 项目目标

这是 XXYY 产品客服 Agentic RAG 系统。当前阶段只做产品问答客服：

- 可以回答 XXYY 产品功能、配置步骤、权益说明、文档更新等问题。
- 不直接查询用户账户、订单、钱包余额、交易记录。
- 不查询用户账户、余额、订单或私有交易记录。交易哈希夹子检测已有 MVP 路由：默认未接数据源时返回“暂未启用”，`TX_ANALYSIS_PROVIDER=mock` 只用于 fixture 演示，`TX_ANALYSIS_PROVIDER=browser` 使用本机 Chrome 查询公开交易浏览器和 XXYY 原池子页，当前支持 Solana，并已接入 Base、Ethereum、BSC 浏览器取证初版。
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
- `packages/knowledge-ops`：Telegram 授权采集、客服消息脱敏、候选知识挖掘、Raw Source 持久化、Candidate 待审队列和增量 cursor。
- `packages/rag-core`：意图分类、检索接口、pgvector store、反馈 store、LLM answer provider、评测。
- `packages/knowledge-ops-mcp`：知识运营内部 MCP stdio server，复用 agent-core 工具定义，暴露候选查询/审核、approved-only 发布、发布后 gate 和 Telegram sync。
- `apps/cli`：`rag:ingest`、`rag:sync:x`、`rag:sync:telegram`、`rag:publish:knowledge`、`rag:gate:knowledge`、`rag:migrate`、`rag:stats`、`rag:feedback`、`rag:ask`、`rag:evaluate`。
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
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=
TELEGRAM_SUPPORT_USER_IDS=
TELEGRAM_UPDATES_LIMIT=100
TX_ANALYSIS_PROVIDER=none
TX_ANALYSIS_REVIEWER=none
TX_ANALYSIS_BROWSER_HEADLESS=false
TX_ANALYSIS_BROWSER_MAX_CONCURRENCY=1
TX_ANALYSIS_BROWSER_MAX_RETRIES=1
TX_ANALYSIS_BROWSER_TIMEOUT_MS=60000
TX_ANALYSIS_BROWSER_USER_DATA_DIR=
TX_ANALYSIS_CHROME_EXECUTABLE_PATH=
TX_ANALYSIS_DISCOVER_URL=
TX_ANALYSIS_REPORT_STORE=file
TX_ANALYSIS_SCREENSHOT_BASE_URL=/assets
TX_ANALYSIS_SCREENSHOT_DIR=
API_CORS_ORIGIN=
API_MAX_BODY_BYTES=65536
API_OPS_TOKEN=
API_RATE_LIMIT_MAX=60
API_RATE_LIMIT_WINDOW_MS=60000
```

`pnpm start`、`pnpm sync` 和 `pnpm rag:*` 会读取项目根目录 `.env`。同名 shell 环境变量优先于 `.env`。
主入口是 `pnpm start`、`pnpm sync` 和 `pnpm check`：本地 `pnpm start` 会尝试启动本地 pgvector、检查知识库并在空库时 ingest，然后执行增量 `x:scrape` 和 `rag:sync:x`，最后启动 API + Web；线上用 `NODE_ENV=production pnpm start` 会跳过本地 Docker，但同样会做知识库检查和增量同步；完全跳过启动前同步的内部入口是 `pnpm start:service`。线上定时增量更新用 `pnpm sync`，低频全量重建用 `pnpm sync -- --full`。
OpenAI-compatible 请求默认 30 秒超时、重试 1 次；需要调整时再配置 `OPENAI_REQUEST_TIMEOUT_MS` 和 `OPENAI_MAX_RETRIES`。
交易分析默认只使用规则化 SandwichAnalyzer；规则化判断会排除复用目标交易哈希的候选腿，也会排除前腿和后腿哈希相同的重复行，EVM 交易哈希大小写无关，Solana 签名按原始字符串精确匹配；配置 `TX_ANALYSIS_REVIEWER=openai` 后，会复用 OpenAI-compatible chat completion 对已抓取的交易窗口和规则证据做模型复核，并兼容 `confidence`、`confidenceScore`、`confidence_score`、`score`、`probability` 和 `likelihood` 等常见置信度字段。模型复核不可用、超时或返回不可解析内容时，交易分析会保留规则结果，不应让可选复核影响基础取证链路；如果模型复核返回 `sandwiched`，但规则结果没有可复查的前置和后置交易，系统也会保留规则 verdict 并写入模型复核 warning，避免生成无前后腿证据的被夹结论。
交易分析的 success evidence 写入成功报告前会 trim label/detail 并丢弃空白项。relatedTransactions 写入成功/失败报告前会清洗 hash、summary、explorerUrl、timestamp 和 traderAddress，丢弃空白 hash，并和最终客服回答、文件/Postgres 报告列表读取历史 JSON/DB 行一样按交易哈希去重；同一哈希重复出现时保留角色优先级更高的记录，完整 EVM 交易哈希按大小写无关归并，Solana 等非 EVM 哈希保持原始精确匹配。浏览器取证成功结果会保留交易窗口前后文，规则命中的前置/用户/后置腿标为 `front_run`、`user`、`back_run`，其它窗口交易标为 `related`。最终客服回答会展示相关交易可用的方向、交易者、时间和 explorer 复查链接，空白字段不会渲染给用户。失败回答的链探测摘要、失败报告写入 JSON/Postgres、文件/Postgres 报告列表读取历史行时都会 trim probeAttempts 错误信息并丢弃空白 attempt；如果清洗后 metadata 已没有任何字段，会省略 metadata 空对象，避免裸 EVM 自动探测失败队列出现空白复查证据。
API 的 `GET /health` 是轻量存活检查；`GET /health/deep` 是生产依赖自检，会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM，失败时返回 503 和分项原因。
通过 `pnpm start` 启动的 API 会为 `/api/chat` 和 `/api/chat/stream` 输出 JSON line 结构化日志，包含 channel、intent、引用数、耗时、状态码和错误码；只记录 `sessionId/userId` 是否存在，不打印用户 ID 明文。
API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat` 和 `/api/chat/stream` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。
`GET /api/ops/summary` 是受保护的运维摘要接口，默认关闭；配置 `API_OPS_TOKEN` 后才可用。请求必须带 `Authorization: Bearer <token>` 或 `x-ops-token`，响应聚合 deep health、知识库 stats 和反馈 stats。`GET /ops` 提供同源运维页，但页面不内置 token，需要手动输入。不要把 `API_OPS_TOKEN` 暴露到公开前端。
Web UI 会把每条回答后的正负反馈提交到 `POST /api/feedback`，API 写入 Postgres `rag_feedback` 表，不记录明文 `userId`。反馈表迁移由 `pnpm rag:ingest` 完成，`pnpm rag:feedback` 可查看反馈数量和最近反馈明细。
交易分析报告默认使用 `TX_ANALYSIS_REPORT_STORE=file` 写入静态资产目录的 JSON/JSONL；文件模式和 Postgres 模式都支持通过受保护接口保存处理状态、备注和负责人。需要数据库化复查时配置 `TX_ANALYSIS_REPORT_STORE=postgres`，成功/失败报告会写入 `tx_analysis_reports` 表，`/api/tx-analysis/reports`、`/api/tx-analysis/reports/summary`、`/api/tx-analysis/reports/:id` 和 `/ops` 会从同一个报告 store 读取。表迁移由 `pnpm rag:migrate`、`pnpm rag:ingest` 或 `pnpm sync` 完成。

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

`pnpm rag:ingest` 会执行数据库迁移、重新生成全部 embeddings、写入 pgvector，并记录 ingestion run，包括 run id、文档数、chunk 数、来源分布和内容指纹。`pnpm rag:sync:x` 用于 X 更新日志增量入库：读取当前 X 文档和 JSONL，按 DB 里的 chunk content hash 只 embedding 新增或变更的 X chunks，并且不会 prune 旧 chunk。`pnpm rag:sync:telegram` 用于授权 Telegram 人工客服消息增量采集：读取 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOWED_CHAT_IDS`、可选 `TELEGRAM_SUPPORT_USER_IDS` 和 `TELEGRAM_UPDATES_LIMIT`，写入 Raw Source Store，生成 `needs_review` 候选知识，并推进 getUpdates offset；该命令不会发布候选知识，也不会把未审核内容写入正式 RAG 知识库。`pnpm rag:publish:knowledge -- --id <candidate-id>` 只发布已人工审核为 `approved` 的候选，默认追加到 `docs/product-features/pages/65-reviewed-support-knowledge.md`，并把候选状态标记为 `published`。`pnpm rag:gate:knowledge -- --id <candidate-id> --fast` 只接受已 `published` 候选，执行正式 ingest/embedding，运行候选生成的 targeted eval gate，并把候选推进到 `ingested` 后标记为 `eval_passed` 或 `eval_failed`；未审核或未发布内容不得进入正式 RAG 知识库。`pnpm rag:migrate` 只执行数据库迁移，不调用 embedding 或 LLM。`pnpm rag:stats` 用于查看当前知识库文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。

`pnpm rag:feedback -- --rating negative --limit 25 --json` 用于导出负反馈 triage 队列，方便把低质量回答补进知识库或评测集。不要在反馈记录里写入明文用户身份或密钥。

`pnpm x:scrape` 默认是增量抓取：读取 `docs/product-features/sources/usexxyyio-x-posts.jsonl` 的最新推文时间，只获取该时间之后的 @useXXYYio 公开主页更新并合并写回；`pnpm x:scrape -- --full` 才会全量重抓。

`pnpm sync` 是知识库更新流水线，默认执行增量 `x:scrape`、`rag:sync:x`、RAG 生产检查，最后导出负反馈 JSON 队列。用 `pnpm sync -- --skip-scrape` 跳过 X 抓取，用 `pnpm sync -- --full` 才会执行全量 `x:scrape -- --full`、`rag:ingest` 和完整 LLM eval。

`pnpm ops:smoke` 用于检查已经启动的 API 服务，默认检查 `/health` 和 `/health/deep`。线上检查可传 `--base-url` 和 `--ops-token`，带 `--ops-token` 时会校验 ops summary 的 `txAnalysisRuntime` 包含 provider、reviewer、报告 store、浏览器并发、重试、超时、headless 模式和截图 URL 前缀；加 `--chat` 会额外调用一次 `/api/chat` 并校验回答和 citations；加 `--tx-analysis --tx-hash <hash-or-explorer-url> --tx-chain base|ethereum|bsc|solana|unknown` 会额外调用 `/api/tx-analysis` 并校验返回交易分析 intent。真实 browser provider 验收时可再加 `--tx-require-screenshot --tx-require-report`，要求返回图片附件和报告链接；加 `--tx-verify-assets` 会进一步 GET 截图和报告链接，并要求截图响应是 `image/*` 且正文是非空的 PNG/JPEG/WebP/GIF/SVG 图片内容，校验报告 JSON 至少包含 `version: 1`、`status`、`reference` 和成功/失败正文，同时确认报告 reference 与 success result 都匹配本次请求的交易哈希和显式链，success result 包含 verdict、confidence、summary、evidence、relatedTransactions、analyzedAt、交易浏览器 URL 和 XXYY 池子页 URL，relatedTransactions 里有用户交易、没有重复交易哈希（EVM 大小写无关），且每条相关交易都有有效 explorer URL，`sandwiched` 结论还必须同时包含前置和后置交易，failure report 包含受支持的 reason 和非空 message，`target_trade_not_found` / `screenshot_unavailable` 失败报告还必须在 metadata 中包含交易浏览器 URL 和 XXYY 池子页 URL，failure metadata 的 relatedTransactions 也不能出现重复交易哈希，且 success result 或 failure metadata 的截图 URL 与返回图片附件一致，确认静态资产或报告详情可打开且不是空响应；多链真实样本验收可用 `--tx-samples <file.json>` 或 `TX_ANALYSIS_SMOKE_SAMPLES_FILE` 批量跑 Solana/Base/Ethereum/BSC 和裸 EVM 自动识别 Base/Ethereum/BSC 样本，并可配合 `--tx-verify-assets` 复用严格资产和报告校验；批量验收可加 `--continue-on-error` 或 `API_SMOKE_CONTINUE_ON_ERROR=true`，单条样本失败后继续执行后续样本并汇总失败数量；样本可声明 `expectedStatus`、`expectedChain`、`expectedDataSource`、`expectedVerdict`、`expectedConfidence`、`expectedAnalysisRuleVersion`、`expectedFailureReason`、`expectedFailureMessage`、`expectedProbeAttempts`、`expectedExplorerUrl`、`expectedXxyyPoolUrl`、`expectedPoolAddress`、`expectedContractAddress`、`expectedRouterAddress`、`expectedScreenshotTargetRowMarked`、`expectedTargetTradeSide`、`expectedTargetTraderAddress`、`expectedTransactionTime`、`expectedRelatedTransactionCount`、`expectedRelatedTransactionRoles` 或 `expectedRelatedTransactions` 固定预期结果、最终归档链、数据源、判断结论、0-1 置信度、判断规则版本、失败根因、失败报告文案、裸 EVM 自动探测过程、实际复查入口、关键解析字段、路由合约、截图目标行标记状态、目标交易方向、交易时间和前置/用户/后置/上下文交易窗口，`expectedChain` 可配合 `chain: "unknown"` 验证裸 EVM 哈希最终自动识别到 Base/Ethereum/BSC 哪条链，`expectedDataSource: "browser"` 可防止真实样本误走 fixture 演示路径，`expectedProbeAttempts` 每项可声明 chain、reason 和可选 message，`expectedRelatedTransactionCount` 可固定窗口交易条数，`expectedRelatedTransactionRoles` 可固定 `front_run`、`user`、`back_run`、`related` 的顺序，`expectedRelatedTransactions` 每项还可声明 `explorerUrl`、`side`、`traderAddress` 与 `timestamp` 固定相关交易细节，交易复查链接字段也兼容 `explorer_url`、`explorerLink`、`explorer_link`、`txUrl`、`tx_url`、`txLink`、`tx_link`、`transactionUrl`、`transaction_url`、`transactionLink`、`transaction_link`、`url`、`link` 和 `href`，且必须是 HTTP(S) URL，role 支持 `front_run`、`user`、`back_run` 和 `related`；如果 probe chain/reason/message 不匹配、expectedChain 不匹配、related transaction 数量或角色顺序不匹配，或同一 related transaction hash 和 role 已命中但细节字段不匹配，smoke 会返回字段级错误；也可用 `TX_ANALYSIS_SMOKE_TX_HASH`、`TX_ANALYSIS_SMOKE_CHAIN`、`TX_ANALYSIS_SMOKE_REQUIRE_SCREENSHOT=true`、`TX_ANALYSIS_SMOKE_REQUIRE_REPORT=true` 和 `TX_ANALYSIS_SMOKE_VERIFY_ASSETS=true` 提供参数。

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
- 生产 API 服务端不负责迁移，迁移和写库由 `pnpm sync`、`pnpm rag:ingest`、`pnpm rag:sync:x`、`pnpm rag:sync:telegram`、`pnpm rag:publish:knowledge` 或 `pnpm rag:gate:knowledge` 完成；本地 `pnpm start` 的启动脚本可以为空知识库做首次 bootstrap。
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
