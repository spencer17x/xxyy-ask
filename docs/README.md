# xxyy-ask 文档

## 项目状态

- [业务架构](architecture.md)
- [功能状态](feature-status.md)
- [Roadmap](roadmap.md)
- [交易哈希夹子检测设计](tx-hash-sandwich-detection-design.md)

## 产品功能知识库

- [XXYY 产品功能知识库](product-features/README.md)
- [XXYY 产品功能整理文档](product-features/xxyy-product-functions.md)
- [XXYY X 历史推文产品更新汇总](product-features/xxyy-x-updates.md)
- [页面级清洗文档](product-features/pages/)
- [页面元数据 manifest](product-features/manifest.jsonl)

这些文档主要由 `https://docs.xxyy.io/` 的中文产品功能页面整理而来，并补充官方 X 账号历史更新内容，当前作为 RAG 客服系统的知识库种子。

## 产品客服 Agentic RAG

当前实现采用轻量 pnpm workspace monorepo：

- `packages/shared`：共享类型与聊天请求/响应契约。
- `packages/knowledge`：产品文档加载、Markdown chunk、tokenize、索引读写。
- `packages/knowledge-ops`：Telegram 授权采集、客服消息脱敏、候选知识挖掘、Raw Source 持久化和 Candidate 待审队列；未审核内容不会进入正式 RAG 知识库。
- `packages/rag-core`：意图分类、混合检索、LLM 回答生成、边界回复、反馈存储、评测。
- `packages/agent-core`：Tool Registry、客服 Agent Runtime、产品工具、交易分析工具和知识运营工具共享定义。
- `packages/product-qa-mcp`：产品问答 MCP stdio server，暴露 `search_product_docs` 和 `answer_product_question`。
- `packages/tx-analysis-mcp`：夹子查询 MCP stdio server，复用 Agent 工具定义。
- `packages/knowledge-ops-mcp`：知识运营内部 MCP stdio server，暴露候选查询/审核、approved-only 发布、发布后 gate 和 Telegram sync。
- `apps/cli`：本地 `ingest` / `sync:x` / `sync:telegram` / `publish:knowledge` / `gate:knowledge` / `migrate` / `stats` / `feedback` / `ask` / `evaluate`。
- `apps/api`：`GET /health`、`GET /health/deep`、`GET /ops`、`GET /api/ops/summary`、`POST /api/chat`、`POST /api/chat/stream`、`POST /api/tx-analysis`、`POST /api/feedback`，以及交易分析报告查询/复查和候选知识查询/审核接口。
- `apps/web`：静态聊天页和同源运维页，聊天页调用 `/api/chat/stream` 并提交 `/api/feedback`，运维页调用 ops summary 和交易分析报告接口。

LLM 配置：

```bash
cp .env.example .env
export OPENAI_API_KEY="你的 API Key"
export OPENAI_MODEL="你的模型名"
```

默认使用 OpenAI 兼容的 Chat Completions 接口，`OPENAI_BASE_URL` 默认是 `https://api.openai.com/v1`。如果使用兼容服务，可以把 `OPENAI_BASE_URL` 改成对应地址。
完整配置项以仓库根目录 `.env.example` 为准；`README.md` 里的启动配置块也保留了当前常用变量。
API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat` 和 `/api/chat/stream` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。
配置 `API_OPS_TOKEN` 后会启用受保护的 `GET /api/ops/summary` 运维摘要接口，请求需带 `Authorization: Bearer <token>` 或 `x-ops-token`。该接口聚合 deep health、知识库 stats、反馈 stats、候选知识队列、最近 eval 失败和最近自动回答质量缺口摘要，适合接生产监控、后台页或告警系统。
启动 API 后可以打开 `/ops` 查看同源运维页面；页面不会内置 token，需要手动输入 `API_OPS_TOKEN` 后加载 summary。

常用命令：

```bash
pnpm start           # 启动前检查/增量更新知识库，然后启动 API + Web
pnpm sync            # 增量同步知识库，适合线上定时任务
pnpm sync -- --full  # 全量重建知识库，适合发布前或文档结构大改
pnpm rag:sync:telegram # 增量采集授权 Telegram 客服消息到候选知识队列
pnpm rag:publish:knowledge -- --id <candidate-id> # 发布 approved 候选到正式 reviewed support knowledge
pnpm rag:gate:knowledge -- --id <candidate-id> --fast # 发布后入库并运行候选定向评测 gate
pnpm rag:gate:knowledge -- --approved-eval --fast # 批量运行已审核 eval-only 候选质量 gate
pnpm check           # lint + format check + typecheck + tests
```

`pnpm rag:ingest` 会执行数据库迁移、重新生成全部 embeddings、写入 pgvector，并记录一次 ingestion run，包含 run id、文档数、chunk 数、来源分布和内容指纹。`pnpm rag:sync:x` 用于 X 更新日志增量入库：按 DB 中已有 chunk content hash 只 embedding 新增或变更的 X chunks，并且不会 prune 旧知识块。`pnpm rag:sync:telegram` 用于授权 Telegram 人工客服消息增量采集：读取 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOWED_CHAT_IDS`、可选 `TELEGRAM_SUPPORT_USER_IDS` 和 `TELEGRAM_UPDATES_LIMIT`，写入 Raw Source Store，生成 `needs_review` 候选知识，并推进 getUpdates offset；该命令不会发布候选知识，也不会把未审核内容写入正式 RAG 知识库。`pnpm rag:publish:knowledge -- --id <candidate-id>` 只发布 `approved` 候选，默认写入 `docs/product-features/pages/65-reviewed-support-knowledge.md`，也可用 `--target pages/<file>.md` 指定正式页面；发布后候选会变成 `published`。`pnpm rag:gate:knowledge -- --id <candidate-id> --fast` 会对已发布候选执行正式 ingest/embedding，运行候选生成的 targeted eval gate，并把候选推进为 `eval_passed` 或 `eval_failed`；`pnpm rag:gate:knowledge -- --approved-eval --fast` 会批量运行已 `approved` 的 eval-only 候选，不会发布或 embedding 未审核内容。未发布候选不能进入正式知识 gate。`pnpm rag:migrate` 只执行数据库迁移，不调用 embedding 或 LLM。`pnpm rag:stats` 可以查看当前知识库文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。

Web UI 会在每条回答后提供正负反馈入口，写入 Postgres `rag_feedback` 表，不记录明文 `userId`。`pnpm rag:feedback` 可以查看用户反馈总数、正负反馈数量和最近反馈明细，用于补知识库或扩展评测集；生产 triage 可以用 `pnpm rag:feedback -- --rating negative --limit 25 --json` 导出负反馈队列。

`pnpm sync` 是对底层刷新流程的主入口：默认会增量抓取 X 更新、执行 `rag:sync:x`、跑 RAG 生产检查、批量 gate 已审核 eval-only 候选，并导出负反馈 JSON 队列。只刷新本地/已更新文档时可以用 `pnpm sync -- --skip-scrape`，应急刷新可用 `pnpm sync -- --skip-approved-eval-gate` 暂时跳过已审核 eval-only 批量 gate，发布前可用 `pnpm sync -- --full` 执行全量 scrape、全量 ingest 和完整 LLM eval。

`pnpm ops:smoke` 用于检查已经启动的 API 服务，默认检查 `http://localhost:3000/health` 和 `/health/deep`。线上可用 `pnpm ops:smoke -- --base-url https://你的域名 --ops-token "$API_OPS_TOKEN"` 检查受保护的 ops summary，并校验候选知识队列计数、最近自动回答质量缺口摘要、质量原因聚合计数存在且合计匹配质量缺口数量，以及 `txAnalysisRuntime` 里 provider、reviewer、报告 store、浏览器并发、重试、超时、headless 模式和截图 URL 前缀完整可读；加 `--chat` 会额外请求一次 `/api/chat` 并校验回答和 citations；加 `--chat-follow-up` 会使用同一个 `sessionId` 连续请求产品问题和省略追问，校验第二轮仍自动回答、有引用且没有人工接管措辞，可用 `--follow-up-question` 和 `--chat-session-id` 覆盖默认追问和会话；加 `--tx-analysis --tx-hash <hash-or-explorer-url> --tx-chain base|ethereum|bsc|solana|unknown` 会额外请求 `/api/tx-analysis` 并校验返回交易分析 intent。真实 browser provider 验收时可再加 `--tx-require-screenshot --tx-require-report`，要求返回图片附件和报告链接；加 `--tx-verify-assets` 会先要求响应包含图片附件和报告链接，再进一步 GET 截图和报告链接，并要求截图响应是 `image/*` 且正文是非空的 PNG/JPEG/WebP/GIF/SVG 图片内容，校验报告 JSON 至少包含 `version: 1`、`status`、`reference` 和成功/失败正文，同时确认报告 reference 与 success result 都匹配本次请求的交易哈希和显式链，success result 包含 verdict、confidence、summary、evidence、relatedTransactions、analyzedAt、交易浏览器 URL 和 XXYY 池子页 URL，relatedTransactions 里有用户交易、不能包含重复交易哈希（EVM 大小写无关），且每条记录都有合法角色、非空 hash/summary，failure report 包含受支持的 reason 和非空 message，failure metadata 的普通复查字符串和 probeAttempts 错误信息不能是空白或带首尾空白，且 failure metadata 里的 relatedTransactions 也不能包含重复交易哈希；success result 或 failure metadata 的截图 URL 与返回图片附件一致，确认静态资产或报告详情可打开且不是空响应；也可用 `TX_ANALYSIS_SMOKE_TX_HASH`、`TX_ANALYSIS_SMOKE_CHAIN`、`TX_ANALYSIS_SMOKE_REQUIRE_SCREENSHOT=true`、`TX_ANALYSIS_SMOKE_REQUIRE_REPORT=true` 和 `TX_ANALYSIS_SMOKE_VERIFY_ASSETS=true` 提供参数。
成功交易分析报告还会写入 `screenshotTargetRowMarked: true`，表示返回的 XXYY 原页面截图已经把用户提交的目标交易行框选出来；报告列表和 `/ops` 页面会展示该状态，`--tx-verify-assets` 会把缺少该标记的成功报告视为失败。
夹子判断会排除复用目标交易哈希的候选腿，也会排除前腿和后腿哈希相同的重复行；EVM 交易哈希大小写无关，Solana 签名按原始字符串精确匹配。
多链真实样本验收可用 `pnpm ops:smoke -- --tx-samples ./tx-smoke-samples.json --tx-verify-assets` 一次跑完整样本集；样本文件可以是数组或 `{ "samples": [...] }`，每条样本支持 `label`、`chain`、`txHash`，以及可选的 `verifyAssets`、`requireScreenshot`、`requireReport`、`expectedStatus`、`expectedChain`、`expectedDataSource`、`expectedVerdict`、`expectedConfidence`、`expectedAnalysisRuleVersion`、`expectedFailureReason`、`expectedFailureMessage`、`expectedProbeAttempts`、`expectedExplorerUrl`、`expectedXxyyPoolUrl`、`expectedPoolAddress`、`expectedContractAddress`、`expectedRouterAddress`、`expectedScreenshotTargetRowMarked`、`expectedTargetTradeSide`、`expectedTargetTraderAddress`、`expectedTransactionTime`、`expectedRelatedTransactionCount`、`expectedRelatedTransactionRoles`、`expectedRelatedTransactions` 覆盖项；写了任一预期字段会自动启用截图和报告资产校验。

`expectedChain` 可固定报告最终归档链，适合 `chain: "unknown"` 的裸 EVM 自动识别样本；`expectedDataSource` 可写 `browser` 来确认真实样本没有误走 fixture 演示路径，`expectedConfidence` 可固定报告里的 0-1 置信度，`expectedAnalysisRuleVersion` 可固定 sandwich 判断规则版本，`expectedFailureReason` 和 `expectedFailureMessage` 可固定失败根因与报告文案，`expectedProbeAttempts` 可固定裸 EVM 自动探测过程，`expectedExplorerUrl` 和 `expectedXxyyPoolUrl` 可固定实际复查入口，`expectedRouterAddress` 可固定 EVM 路由合约解析结果，`expectedScreenshotTargetRowMarked` 可固定目标交易行是否已在截图中标记，`expectedTargetTradeSide` 可固定目标交易方向，`expectedTransactionTime` 可固定报告解析出的交易时间。

`expectedRelatedTransactionCount` 和 `expectedRelatedTransactionRoles` 可固定窗口内相关交易数量和角色顺序，其中 `expectedRelatedTransactionCount` 必须是非负整数，`expectedRelatedTransactionRoles` 必须是非空数组且每项只能是 `front_run`、`user`、`back_run` 或 `related`。`expectedRelatedTransactions` 可锁定报告里必须出现的 `front_run`、`user`、`back_run` 或 `related` 交易 hash 和 role，并可进一步固定该条相关交易的 `explorerUrl`、`side`、`traderAddress` 和 `timestamp`；相关交易复查链接也兼容 `explorer_url`、`explorerLink`、`explorer_link`、`txUrl`、`tx_url`、`txLink`、`tx_link`、`transactionUrl`、`transaction_url`、`transactionLink`、`transaction_link`、`url`、`link` 和 `href`；如果 probe chain/reason/message 不匹配、related transaction 数量或角色顺序不匹配，或 related transaction 的 hash 和 role 已命中但细节字段不匹配，smoke 会返回字段级错误；显式写入的可选预期文本字段、probe message、related transaction 的复查链接 / `traderAddress` / `timestamp` 都不能是空白，复查链接还必须是 HTTP(S) URL，方向字段只能写 `buy`、`sell` 或 `unknown`。也可用 `TX_ANALYSIS_SMOKE_SAMPLES_FILE` 指向样本文件。批量样本验收可加 `--continue-on-error` 或设置 `API_SMOKE_CONTINUE_ON_ERROR=true`，单条样本失败后继续跑后续样本，最后汇总失败数量。
仓库内置了 `docs/tx-analysis-smoke-samples.example.json` 作为真实 Solana、Base、Ethereum、BSC，以及裸 EVM 自动识别 Base/Ethereum/BSC 样本，可用 `pnpm ops:smoke -- --tx-samples docs/tx-analysis-smoke-samples.example.json --tx-verify-assets` 检查本地 browser provider 的截图、报告、规则版本、交易时间和交易窗口。
浏览器取证生成成功结果和失败 metadata，以及文件/Postgres 报告写入器落盘 relatedTransactions 时，会清洗相关交易摘要；空摘要会按角色兜底为“前置交易”“用户交易”“后置交易”或“相关交易”；同一交易哈希重复出现时会只保留一条复查记录，EVM 交易哈希按大小写无关归并，避免报告、ops 队列和 smoke 验收出现空白或重复复查行。

MCP stdio 服务可用仓库内置 mock 样本验证真实协议路径：

```bash
TX_ANALYSIS_PROVIDER=mock pnpm tx:mcp:smoke
```

产品客服 MCP 可以用 `pnpm product:mcp` 作为 stdio MCP server 启动命令，暴露 `search_product_docs` 和 `answer_product_question`，并复用 `@xxyy/agent-core` 的产品工具定义。Agent 接入时配套使用 `skills/xxyy-product-support`，只回答 XXYY 产品功能、配置步骤、权益说明和公开更新，不用于账户、订单、余额、私有交易记录或投资建议。

知识运营 MCP 可以用 `pnpm knowledge-ops:mcp` 作为内部 stdio MCP server 启动命令，并配套使用 `skills/xxyy-knowledge-ops`。它暴露 `list_knowledge_candidates`、`review_knowledge_candidate`、`publish_knowledge_candidate`、`run_knowledge_gate` 和 `sync_telegram_support`。该 server 只用于受信任的内部 Agent：第一版必须人工审核后才能发布，未审核 Telegram 内容只能停留在候选知识队列，不能进入正式 RAG 知识库。

Agent 接入时可以把 `pnpm tx:mcp` 作为 stdio MCP server 启动命令，并配套使用仓库内的 Skill 源文件 `skills/xxyy-transaction-analysis`。该 Skill 会提醒 agent 只对公开交易哈希/浏览器链接做 交易夹子检测，`unknown` 只表示裸 EVM 哈希在 Base、Ethereum、BSC 间自动探测，不能用于账户、订单、余额、私有交易记录或投资建议。

默认读取 `docs/tx-analysis-mcp-smoke-samples.mock.json`，也可以用 `pnpm tx:mcp:smoke -- --tx-samples ./your-samples.json` 指定样本文件。MCP smoke 校验 MCP `analyze_transaction` 返回的 `structuredContent`，不下载截图或报告资产；需要 GET 截图、报告 JSON 和静态资产内容时继续使用 `pnpm ops:smoke -- --tx-verify-assets`。

MCP 样本文件可以是数组或 `{ "samples": [...] }`，每条样本支持 `label`、`chain`、`txHash`，以及顶层 `expectedStatus`、`expectedChain`、`expectedDataSource`、`expectedVerdict`、`expectedConfidence`、`expectedAnalysisRuleVersion`、`expectedFailureReason`、`expectedFailureMessage`、`expectedProbeAttempts`、`expectedExplorerUrl`、`expectedXxyyPoolUrl`、`expectedPoolAddress`、`expectedContractAddress`、`expectedRouterAddress`、`expectedScreenshotTargetRowMarked`、`expectedTargetTradeSide`、`expectedTargetTraderAddress`、`expectedTransactionTime`、`expectedRelatedTransactionCount`、`expectedRelatedTransactionRoles`、`expectedRelatedTransactions`；也可以写在嵌套 `expected` 对象里并去掉 `expected` 前缀，例如 `expected.status`、`expected.analysisRuleVersion`、`expected.relatedTransactions`。样本中出现未支持的顶层 `expected*` 字段或 `expected` 对象字段会直接失败为 unsupported expected field，避免预期漂移被静默忽略。

MCP smoke 的 enum 预期字段必须是字符串，`expectedConfidence` 必须是 0-1 数字，`expectedScreenshotTargetRowMarked` 必须是 boolean，`expectedRelatedTransactionCount` 必须是非负整数，`expectedRelatedTransactionRoles` 必须是非空角色数组，`expectedRelatedTransactions` 必须是非空数组且每项包含 `hash` 和 `role`。`expectedRelatedTransactions` 可额外固定 `explorerUrl`、`side`、`traderAddress` 和 `timestamp`，交易链接字段同样兼容 `explorer_url`、`explorerLink`、`explorer_link`、`txUrl`、`tx_url`、`txLink`、`tx_link`、`transactionUrl`、`transaction_url`、`transactionLink`、`transaction_link`、`url`、`link` 和 `href`。

`pnpm rag:evaluate -- --fast` 只跳过 chat LLM 回答生成，仍会调用 embedding 模型并查询 pgvector；它用于快速检查检索、引用和边界分类。`pnpm rag:evaluate` 会调用配置的大模型，用于检查最终客服回答质量。

正式知识库写入 Postgres + pgvector。本地体验直接运行 `pnpm start`：启动脚本会尝试启动本地 pgvector、检查知识库，在知识库为空时先跑 ingest，然后执行增量 `x:scrape` 和 `rag:sync:x`，最后启动 API + Web。生产环境使用 `NODE_ENV=production pnpm start` 会跳过本地 Docker，但同样会做知识库检查和增量同步。完全跳过启动前同步的内部入口是 `pnpm start:service`。

HTTP 交互：

```http
GET /health
GET /health/deep
GET /ops
GET /api/ops/summary
```

`/health` 是轻量存活检查。`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM；全部可用返回 `200`，任一项不可用返回 `503` 和分项原因。

```http
POST /api/chat
POST /api/chat/stream
POST /api/tx-analysis
POST /api/feedback
```

```json
{
  "message": "如何设置 Telegram 钱包监控？",
  "channel": "web"
}
```

第一期仍以产品客服为主。涉及个人账户、订单、钱包余额、交易记录、泛 MEV/链上取证和投资建议的问题会走边界回复，不会假装查询实时数据。交易哈希夹子检测已有专用路由；默认未接真实数据源时会提示暂未启用，`TX_ANALYSIS_PROVIDER=mock` 只返回 fixture 演示结果和截图，`TX_ANALYSIS_PROVIDER=browser` 会用本机 Chrome 查询公开交易浏览器页面和 XXYY 原池子页。当前 Solana 已能定位目标交易前后窗口，返回带目标行标记的 XXYY 原表格截图；截图前会先在 XXYY 原页面按目标交易本地时间前后 30 秒和目标交易者地址过滤最新成交，再检查可见成交行并框选目标交易；成功结果会保留前后窗口复查交易，规则确认的前置/用户/后置腿标为 `front_run` / `user` / `back_run`，其它上下文交易标为 `related`；标记目标行时会优先按可见交易哈希或交易链接匹配，再用滚动坐标兜底，并为成功或失败结果保存 JSON 分析报告；Base、Ethereum、BSC 已接入初版 browser adapter，带链名或 explorer 链接时会直连对应交易浏览器，裸 EVM 交易哈希会按 Base、Ethereum、BSC 顺序自动探测；如果用户把 `0x` EVM 哈希标成 Solana、`SOL 链` 或 `SOL chain`，会要求重新发送清晰的单笔交易引用。EVM 取证会优先按解析到的池子地址直达 XXYY 原池子页，目标交易匹配失败时再通过 XXYY 合约搜索复用交易窗口和截图链路。

## 正式 RAG：Postgres + pgvector

配置：

```bash
export POSTGRES_DB="xxyy_ask"
export POSTGRES_HOST="localhost"
export POSTGRES_PORT="5432"
export POSTGRES_USER="xxyy"
export POSTGRES_PASSWORD="换成强密码"
export OPENAI_API_KEY="你的 API Key"
export OPENAI_MODEL="你的回答模型"
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
export RAG_TOP_K=6
export RAG_ANSWER_PROVIDER=openai
export TX_ANALYSIS_PROVIDER=none
export TX_ANALYSIS_BROWSER_HEADLESS=false
export TX_ANALYSIS_BROWSER_MAX_CONCURRENCY=1
export TX_ANALYSIS_BROWSER_MAX_RETRIES=1
export TX_ANALYSIS_BROWSER_TIMEOUT_MS=60000
export TX_ANALYSIS_DISCOVER_URL=
export TX_ANALYSIS_REPORT_STORE=file
export TX_ANALYSIS_SCREENSHOT_BASE_URL=/assets
export TX_ANALYSIS_SCREENSHOT_DIR=
```

Browser 交易分析默认访问 `https://www.xxyy.io/discover`；需要指向 staging、镜像或本地代理页面时配置 `TX_ANALYSIS_DISCOVER_URL`。截图、成功 JSON 报告和失败 JSON 报告默认写入 `docs/product-features/assets`，并通过 `/assets/*` 暴露；需要换目录时配置 `TX_ANALYSIS_SCREENSHOT_DIR` 和 `TX_ANALYSIS_SCREENSHOT_BASE_URL`。受保护的 `/api/ops/summary` 和 `/ops` 会展示当前交易分析 provider、reviewer、报告存储、浏览器并发、重试、超时和 Discover 配置，方便排查浏览器取证运行状态。
后台、测试工具或未来独立分析页可以调用 `POST /api/tx-analysis`，提交 `txHash` 和可选 `chain`，返回与聊天入口一致的 `ChatResponse`；`chain` 支持规范值，也兼容 `SOL`、`SOL chain`、`SOL mainnet`、`Base`、`ETH`、`以太链`、`BNBChain`、`BNBSmartChain`、`BNB SmartChain`、`BNB Smart Chain`、`Binance SmartChain`、`BinanceSmartChain`、`BEP20`、`币安` 等常见别名。
`TX_ANALYSIS_REPORT_STORE=file` 是默认模式：每次报告写入会追加到同目录的 `tx-analysis-report-index.jsonl`。API 可通过 `GET /api/tx-analysis/reports?limit=20` 查看最近报告，通过 `txHash=<hash>` 查询指定交易，也可以用 `chain=<chain>`、`status=success|failure`、`reviewStatus=open|in_review|closed`、`assignee=<name>`、`reason=pool_not_found` 和 `limit=<n>` 组合筛选；`chain` 过滤支持规范值和 `SOL`、`SOL chain`、`SOL mainnet`、`Base`、`ETH`、`以太链`、`BNBChain`、`BNBSmartChain`、`BNB SmartChain`、`BNB Smart Chain`、`Binance SmartChain`、`BinanceSmartChain`、`BEP20`、`币安` 等常见别名。完整 EVM 交易哈希查询大小写无关，Solana 交易签名保持精确匹配。索引会保留结论、置信度、截图、explorer、目标交易地址、交易时间、池子、合约、路由合约、XXYY 池子页、前置/用户/后置交易 explorer 链接、相关交易方向、交易者、时间和失败原因等复查字段；失败报告也会保留失败前已经解析到的这些上下文，方便客服先看列表再打开完整 JSON 报告。文件报告可通过受保护接口保存 `open`、`in_review`、`closed` 处理状态、负责人和备注，并会同步更新 JSONL 索引和完整 JSON 报告；没有可更新处理记录时默认按 `open` 参与处理状态筛选。
`TX_ANALYSIS_REPORT_STORE=postgres` 会把成功/失败报告写入 `tx_analysis_reports` 表，`pnpm rag:migrate`、`pnpm rag:ingest` 和 `pnpm sync` 的迁移阶段会创建表和索引。报告链接为 `GET /api/tx-analysis/reports/:id`，列表、摘要、受保护的 `/api/ops/summary` 和 `/ops` 运维页都会从同一个报告 store 读取；摘要包含总数、成功/失败数量、链分布、失败原因分布、处理状态分布和最近报告列表。常用复查字段会同步写入结构化列，包括 explorer、截图、XXYY 池子页、池子、合约、EVM 路由合约、目标交易地址和交易时间；查询列表和摘要时会优先读取结构化列，并回退到 `report_document` 里的旧 JSON 字段。完整 JSON 报告仍保存在 `report_document`。Postgres store 支持 `review_status`、备注、负责人、更新人和更新时间字段；受保护接口 `PATCH /api/tx-analysis/reports/:id/review` 可更新单条处理记录，`PATCH /api/tx-analysis/reports/review` 可按 id 列表批量执行同一 review 动作，请求必须带 `Authorization: Bearer <API_OPS_TOKEN>` 或 `x-ops-token`。`/ops` 也提供报告筛选面板，可按交易哈希、链、报告状态、处理状态、负责人、失败原因和数量上限查询历史报告；链筛选输入框可直接输入规范链名或 `BNBChain`、`BNBSmartChain`、`BNB SmartChain`、`Binance SmartChain` 等常见别名。文件和 Postgres 报告列表都可在页面上保存 `open`、`in_review`、`closed` 处理状态、备注和负责人，并在摘要和筛选面板按处理状态或负责人查看复查队列；报告搜索结果还可以勾选多条报告批量 Claim / Close / Reopen；交易分析面板也会展示运行配置；完整分派/关闭工作流仍待建设。

应用会从 `POSTGRES_*` 自动组装数据库连接串。使用外部托管数据库时，也可以只配置 `DATABASE_URL` 覆盖。

本地启动：

```bash
pnpm start
```

线上启动：

```bash
NODE_ENV=production pnpm start
```

线上增量同步：

```bash
pnpm sync
```
