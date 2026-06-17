# xxyy-ask

XXYY 产品客服 Agentic RAG 项目。当前目标是做产品问答客服：基于 XXYY 产品文档和官方 X 更新内容检索知识库，再调用 OpenAI-compatible LLM 生成回答。

第一期不做用户账户查询、交易记录查询或投资建议。交易哈希会进入专用夹子检测路径；默认没有真实数据源时返回“暂未启用”，`TX_ANALYSIS_PROVIDER=mock` 只用于 fixture 演示，`TX_ANALYSIS_PROVIDER=browser` 会用本地 Chrome 查询公开交易浏览器和 XXYY 原池子页，当前支持 Solana，并已接入 Base、Ethereum、BSC 浏览器取证初版。

## Features

用户可感知功能摘要：

- [x] 产品功能、配置步骤、Pro 权益和官方 X 更新问答。
- [x] 来源引用、流式回答、视频附件和回答反馈。
- [x] 账户、订单、交易记录、泛 MEV/链上取证和投资建议等边界问题回复。
- [x] 单笔交易哈希识别、图片附件、fixture 演示、Solana 浏览器查询、Base/Ethereum/BSC 取证初版和交易分析报告复查。
- [x] 多链真实样本验收：Solana、Base、Ethereum、BSC，以及裸 EVM 自动识别 Base/Ethereum/BSC。
- [ ] 多轮对话、更完整的客服复查工作流、工单创建、人工接管和多渠道接入。

完整功能状态见 [docs/feature-status.md](docs/feature-status.md)，后续规划见 [docs/roadmap.md](docs/roadmap.md)。

## 项目结构

```text
apps/
  api/        HTTP API 和 Web UI 入口
  cli/        rag:ingest、rag:sync:x、rag:migrate、rag:ask、rag:evaluate、rag:feedback 命令
  web/        静态聊天页面
packages/
  shared/     共享类型
  knowledge/  文档加载、chunk、tokenize、embedding provider
  knowledge-ops/  Telegram/客服消息脱敏、候选知识挖掘和待审队列内核
  rag-core/   意图分类、检索、回答生成、pgvector store、评测
  agent-core/ Tool Registry、客服 Agent Runtime 和共享工具定义
  product-qa-mcp/  产品问答 MCP stdio server
  tx-analysis-mcp/  夹子查询 MCP stdio server
docs/
  product-features/  XXYY 产品知识库种子文档
```

## 环境准备

```bash
pnpm install
cp .env.example .env
```

`pnpm start`、`pnpm sync` 和 `pnpm rag:*` 会读取项目根目录 `.env`。如果同名变量已经在 shell 里导出，则 shell 里的值优先。

## 启动 Agent

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
TX_ANALYSIS_PROVIDER=none
TX_ANALYSIS_REVIEWER=none
TX_ANALYSIS_BROWSER_HEADLESS=false
TX_ANALYSIS_BROWSER_TIMEOUT_MS=60000
TX_ANALYSIS_BROWSER_USER_DATA_DIR=
TX_ANALYSIS_CHROME_EXECUTABLE_PATH=
TX_ANALYSIS_REPORT_STORE=file
TX_ANALYSIS_SCREENSHOT_BASE_URL=/assets
TX_ANALYSIS_SCREENSHOT_DIR=

API_CORS_ORIGIN=
API_MAX_BODY_BYTES=65536
API_OPS_TOKEN=
API_RATE_LIMIT_MAX=60
API_RATE_LIMIT_WINDOW_MS=60000
```

应用会从 `POSTGRES_*` 自动组装数据库连接串。使用外部托管数据库时，也可以只配置 `DATABASE_URL` 覆盖。
`OPENAI_REQUEST_TIMEOUT_MS` 和 `OPENAI_MAX_RETRIES` 是可选项；默认 30 秒超时、重试 1 次。
本地真实交易哈希分析可以设置 `TX_ANALYSIS_PROVIDER=browser`。该模式会启动本机 Chrome，访问公开交易浏览器和 XXYY 原池子页，不使用 RPC 或第三方 API key；Solscan、BaseScan、Base Blockscout、Etherscan、Ethereum Blockscout 或 BscScan 可能触发 Cloudflare、Verifying you are human、verify your browser、Just a moment、Attention Required、`cf-chl` challenge、连接安全检查、security check、not a robot、`security service to protect itself from online attacks`、`triggered the security solution` 等安全验证，保持 `TX_ANALYSIS_BROWSER_HEADLESS=false` 并在弹出的 Chrome 里完成验证后重试即可。浏览器取证会按配置重试 timeout、公开站点限流，以及 `Execution context was destroyed`、`frame detached`、`net::ERR_*`、`ERR_INTERNET_DISCONNECTED`、`ERR_CONNECTION_ABORTED`、`ERR_ADDRESS_UNREACHABLE`、`ERR_NETWORK_ACCESS_DENIED`、`ERR_NETWORK_IO_SUSPENDED`、`NS_ERROR_NET_TIMEOUT`、`Failed to fetch`、`NetworkError when attempting to fetch resource`、`The Internet connection appears to be offline`、`Load failed`、`ERR_SSL_PROTOCOL_ERROR`、`ERR_CERT_*`、`ECONNRESET`、`ECONNREFUSED`、`EAI_AGAIN`、`ENOTFOUND`、socket hang up 等常见临时浏览器/网络错误；Base 链如果 BaseScan 导航遇到临时网络故障或进入安全验证页，会继续尝试 Base Blockscout；Ethereum 链如果 Etherscan 导航遇到临时网络故障或进入安全验证页，会继续尝试 Ethereum Blockscout，并保留实际命中的 explorer URL；`net::ERR_TIMED_OUT`、`ERR_CONNECTION_TIMED_OUT`、`NS_ERROR_NET_TIMEOUT` 和 `ETIMEDOUT` 会按 timeout 归因；XXYY 直达池子页导航超时或网络错误也会进入同一套归因和重试链路，不会被静默当成池子不匹配；XXYY 成交窗口接口返回 HTTP 429/5xx 时会抛出可重试数据源错误，不会把空响应误报成“目标交易未找到”；HTTP 429、Too Many Requests、rate limit 这类限流文案、HTTP 502/503/504/520-526 这类公开站点短暂错误，以及 `SSL handshake failed` 或 `invalid SSL certificate` 这类 SSL 临时故障会进入同一套重试链路；如果公开交易浏览器显示交易执行失败，会直接返回“交易执行失败”，不会继续按成功 swap 查池子或判断是否被夹。裸 EVM 哈希会按 Base、Ethereum、BSC 探测；用户写 ETH、Ethereum、以太、以太链、以太坊会按 Ethereum 处理，写 BSC、BNB、BNBChain、BNBSmartChain、BNB SmartChain、BNB Smart Chain、Binance Chain、Binance-Chain、Binance SmartChain、Binance Smart Chain、BinanceSmartChain、Binance-Smart-Chain、BEP20、币安或币安链时会按 BSC 处理；如果把 `0x` EVM 哈希标成 Solana、`SOL 链` 或 `SOL chain`，会要求重新发送清晰的链和哈希；如果明确写 Base Sepolia、Ethereum Sepolia、BSC Testnet、ETH Goerli 等 EVM 测试网/开发网提示，或 Polygon/MATIC/Polygon PoS/Polygon zkEVM、Arbitrum/ARB/Arbitrum One、Optimism/OP/Optimistic Ethereum、Avalanche/AVAX/Avalanche C-Chain、Linea、Scroll、Sonic、Berachain、Abstract、Gnosis/Gnosis Chain、Fantom/Fantom Opera、Moonriver 等暂未支持链名，会直接返回暂不支持，不会继续拿裸哈希探测已支持主网。默认夹子判断只使用规则化 SandwichAnalyzer；规则化判断会排除复用目标交易哈希的候选腿，以及前腿/后腿哈希相同的重复行，EVM 交易哈希大小写无关，Solana 签名按原始字符串精确匹配；需要模型复核时可设置 `TX_ANALYSIS_REVIEWER=openai`，它会复用 OpenAI-compatible chat completion，只基于已抓取的交易窗口和规则证据做复核，模型返回裸 JSON、`result`/`review` 包裹的 JSON、fenced JSON、普通前后缀文本中的 JSON 对象或 OpenAI-compatible text content parts 时都可解析；模型把 `confidence`、`confidenceScore`、`confidence_score`、`score`、`probability` 或 `likelihood` 返回成 0-100 数字、数字字符串、分数式字符串或半角/全角百分比字符串，或把 verdict 返回成大写、空格或连字符枚举，也会把 evidence item 里的 `detail`/`message`/`description`、`label`/`title`/`name` 和 `severity`/`level`/`riskLevel` 归一化；模型不可用或没有返回可用 JSON 时保留规则结果，并在证据里记录“模型复核”警告；如果模型复核返回 `sandwiched`，但规则结果没有可复查的前置和后置交易，也会保留规则 verdict 并记录“模型复核”警告，避免生成无前后腿证据的被夹结论。聊天入口可以直接发送交易哈希或 explorer 链接；后台、测试工具或未来独立分析页也可以调用 `POST /api/tx-analysis`，提交 `{ "txHash": "...", "chain": "base" }` 这类 JSON，返回与聊天入口一致的 `ChatResponse`；`txHash` 可以是裸交易哈希或受支持的主网 explorer 链接，入口会把受支持链接标准化为具体链和裸哈希，`chain` 省略或传 `unknown` 时会使用链接推断出的链，不支持的 devnet/testnet 链接、EVM 测试网/开发网文本、未支持 EVM explorer 链接或显式暂未支持链名会保留并返回明确不支持，且 `txHash` 文本自身写了 EVM 测试网/开发网提示，或 Polygon/MATIC/Polygon PoS/Polygon zkEVM、Arbitrum/ARB、Optimism/OP、Avalanche/AVAX、Linea、Scroll、Sonic、Berachain、Abstract、Gnosis/Gnosis Chain、Fantom/Fantom Opera、Moonriver、X Layer 或 Plasma 等暂未支持链名，或粘贴了 Polygonscan、Arbiscan、Mantlescan、zkSync Era Explorer 等未支持 EVM explorer 链接时，不会被同时传入的 Base/Ethereum/BSC `chain` 覆盖成已支持主网；`chain` 可使用规范值，也兼容 `SOL`、`SOL chain`、`SOL mainnet`、`Base`、`ETH`、`以太链`、`BNBChain`、`BNBSmartChain`、`BNB SmartChain`、`BNB Smart Chain`、`Binance-Chain`、`Binance SmartChain`、`BinanceSmartChain`、`Binance-Smart-Chain`、`BEP20`、`币安` 等常见别名，以及 Polygon PoS、Polygon zkEVM、Arbitrum One、Optimistic Ethereum、Avalanche C-Chain、Gnosis Chain、Fantom Opera、Moonriver 等暂未支持链别名。截图默认写入 `docs/product-features/assets` 并通过 `/assets/...` 返回。截图生成前会优先在 XXYY 原页面按目标交易本地时间前后 30 秒和目标交易者地址过滤最新成交，筛选后先检查可见成交行并给目标行加黄色边框；过滤失败时再回退到滚动定位，截图内容仍是用户肉眼看到的 XXYY 原表格。成功回答会展示交易浏览器、目标交易地址、交易时间、池子、合约、EVM 路由合约、XXYY 池子页，以及交易窗口里的前后文交易复查链接；规则确认的前置/用户/后置腿会分别标为 `front_run`、`user`、`back_run`，其它窗口交易会标为 `related`，一起保留方向、交易者和时间。失败回答也会展示失败前已解析到的复查上下文。`TX_ANALYSIS_REPORT_STORE=file` 会把报告写成本地 JSON/JSONL，报告查询、详情读取和客服处理状态更新都直接使用本地文件；改成 `postgres` 后会写入 `tx_analysis_reports` 表，报告链接为 `/api/tx-analysis/reports/:id`，列表、摘要和 `/ops` 会从数据库读取；报告查询的 `chain`、`reviewStatus` 和 `assignee` 过滤可用于复查队列，摘要也会展示处理状态分布，`/ops` 同时展示 provider、reviewer、报告存储、浏览器并发、重试和超时等运行配置，受保护接口 `PATCH /api/tx-analysis/reports/:id/review` 和 `/ops` 报告列表可用 `API_OPS_TOKEN` 更新客服处理状态、备注和负责人等字段。
批量处理复查队列时，也可以调用受保护的 `PATCH /api/tx-analysis/reports/review`，按 `ids` 列表对多条报告执行同一 `claim`、`close` 或 `reopen` 动作，并查看 updated/notFound 结果；`/ops` 报告搜索结果也可以勾选多条报告批量处理。
BSC 链如果 BscScan 导航遇到临时网络故障或进入安全验证页，会继续尝试 BSCTrace；粘贴 `https://bsctrace.com/tx/<hash>` 主网链接时也会按 BSC 交易分析处理。同一条 EVM 链的主交易浏览器和备用浏览器都遇到临时网络故障时，会明确归因为公开数据源临时不可用并进入重试/报告链路，不会把底层浏览器异常原样抛给用户。
浏览器取证在生成成功结果前会校验可复查的 XXYY 池子页 URL 与已解析的 `poolAddress` 一致；如果公开浏览器只解析到合约，但 XXYY 池子 URL 里已经包含当前链的完整池子地址，会回填 `poolAddress` 并用于规则判断、回答和报告；如果 XXYY 直达 URL 的池子地址格式无效且浏览器没有解析出可信 `poolAddress`，会按 `pool_not_found` 失败，不会把坏 URL 回填成池子；失败报告写入前也会清洗格式无效的 XXYY 池子链接，避免复查队列出现坏链接；如果页面或 driver 返回非 XXYY 域名的池子 URL，但已经解析到 `poolAddress`，会按当前链回填官方 XXYY 池子页；如果返回同链但不同池子的直达 URL，或 Discover 池子 URL 中暴露了另一个完整池子地址，会按 `pool_not_found` 失败，不会返回外部域名或错池子截图/报告。
浏览器取证在生成成功结果前也会校验主交易浏览器链接必须指向用户提交的同链同一笔交易；如果 driver 返回的 explorer URL 指向另一笔交易或同 hash 的其它链，会按 `tx_not_found` 失败，并且不会把错链接写入失败复查信息；失败报告写入前也会清洗错链或错交易的主 explorer URL，避免复查队列出现错交易浏览器链接。失败 metadata 里的合约、池子、路由、截图、交易者、交易方向、交易时间、错误信息和未支持链提示等字段也会清洗或过滤非法值；裸 EVM 探测失败列表里的错误信息会在写入报告前 trim，空白错误信息不会写进复查报告。夹子证据里的前置/用户/后置交易链接也会做同链同 hash 校验，错链或错 hash 链接会被替换为当前链的可复查链接；相关交易摘要也会去掉首尾空白，空摘要会按角色兜底为“前置交易”“用户交易”“后置交易”或“相关交易”，相关交易方向只保留 `buy`、`sell` 或 `unknown`。adapter 直接抛出的失败 metadata 如果携带 relatedTransactions，也会在写入报告前逐条修复或过滤相关交易 explorer 链接、把 `frontRun`/`target`/`backRun` 等 role 别名归一化为合法角色、清洗摘要，并在窗口缺少用户交易时补入本次请求的用户交易；报告写入器也会在写入成功/失败报告前 trim evidence 的 label/detail，丢弃空白证据项，trim relatedTransactions 的 hash、summary、explorerUrl、timestamp 和 traderAddress，丢弃空白 hash，并按交易哈希去重。报告写入器返回的 report URL、写入 JSON/DB 的失败 message 和 probeAttempts message 也会去掉首尾空白，空白失败 message 会写成固定可读文案，空白 probe attempt 会被丢弃；如果清洗后 metadata 已没有任何字段，失败报告会省略 metadata 空对象；如果 report URL 返回空字符串或空白字符串，会按“报告保存失败”进入回答和证据，不会展示不可点击的空白报告链接；文件和 Postgres 报告列表读取历史失败记录时，也会 trim failure message 并过滤空白 message。最终聊天回答也会对置信度、分析摘要、分析时间、report URL、截图 URL、主交易浏览器链接、XXYY 池子页链接、证据标题和内容、相关交易 hash、相关交易摘要、浏览器链接、池子、合约、路由、目标交易者、目标交易方向、交易时间、规则版本、未支持链提示、报告保存错误和链探测摘要做同样的非空兜底，空白 probe attempt 不会出现在用户回答里，避免其它 provider 或历史路径把空白复查信息渲染给用户。
相关交易复查窗口还会按交易哈希去重；同一交易重复出现时只保留优先级更高的角色记录，EVM 交易哈希按大小写无关归并，避免回答、成功/失败报告或 ops 队列重复展示同一笔交易。
Mantle 暂未接入交易取证；聊天里写 `Mantle 0x...`、粘贴 `mantlescan.xyz` 链接，或在 `POST /api/tx-analysis` 里传 `chain: "Mantle"` / `"Mantle Mainnet"`，都会返回“其他链暂不支持”，不会继续探测已支持主网。
zkSync Era 暂未接入交易取证；聊天里写 `zkSync Era 0x...` / `ZK-Sync Era 0x...`、粘贴 `era.zksync.network` 链接，或在 `POST /api/tx-analysis` 里传 `chain: "zkSync Era"` / `"ZK-Sync Era"` / `"zkSync Era Mainnet"`，都会返回“其他链暂不支持”，不会继续探测已支持主网。

本地启动完整问答服务：

```bash
pnpm start
```

本地模式下，`pnpm start` 会尝试启动 `docker compose` 里的 pgvector，检查知识库 stats；如果知识库为空或还没迁移，会先跑一次 ingest。随后会执行增量 `x:scrape` 和 `rag:sync:x`，有新内容就更新，没有变化就跳过，最后启动 API 和 Web UI。使用外部数据库时配置 `DATABASE_URL`，启动脚本会跳过本地 Docker。

线上启动常驻服务：

```bash
NODE_ENV=production pnpm start
```

线上模式不会启动本地 Docker，但同样会在服务启动前检查知识库、必要时 ingest，并执行增量 `x:scrape` 和 `rag:sync:x`。需要显式强制线上启动模式时也可以用：

```bash
pnpm start -- --service
```

如果部署平台需要完全跳过启动前同步，只启动 API + Web，可以使用内部入口：

```bash
pnpm start:service
```

然后打开：

```text
http://localhost:3000
```

运维页面：

```text
http://localhost:3000/ops
```

`/ops` 页面不会内置 token，需要手动输入 `API_OPS_TOKEN` 后才会调用受保护的 `/api/ops/summary`；文件和 Postgres 报告列表里的处理状态、备注和负责人保存也使用同一个 token，并可在摘要和筛选面板按处理状态或负责人查看复查队列。交易分析面板还会展示当前 provider、reviewer、报告存储、浏览器并发、重试和超时设置，方便排查浏览器取证运行状态。

## 定时同步

线上定时任务只需要跑增量同步：

```bash
pnpm sync
```

`pnpm sync` 默认执行增量 `x:scrape`、`rag:sync:x`、RAG 生产检查，并导出负反馈队列。它适合放进 cron、GitHub Actions、云函数定时器或部署平台 scheduler。按天、周、月执行都可以，取决于你希望知识库更新多快。

低频全量重建：

```bash
pnpm sync -- --full
```

全量模式会全量抓取 X、执行完整 `rag:ingest` 和完整 LLM eval，更适合发布前或文档结构大改后人工触发。

命令行临时提问：

```bash
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

## API

轻量存活检查：

```http
GET /health
```

深度依赖自检：

```http
GET /health/deep
```

`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM。全部可用时返回 `200`；任一项不可用时返回 `503`，并在 `checks` 里给出具体原因，不返回 API key 或数据库密码。

通过 `pnpm start` 启动的 API 会为 `/api/chat` 和 `/api/chat/stream` 输出 JSON line 结构化日志，包含 channel、intent、引用数、耗时、状态码和错误码。日志只记录 `sessionId/userId` 是否存在，不打印用户 ID 明文。

API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat` 和 `/api/chat/stream` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。需要跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。

运维摘要接口默认关闭。配置 `API_OPS_TOKEN` 后可以访问：

```http
GET /api/ops/summary
```

请求需要带 `Authorization: Bearer <API_OPS_TOKEN>` 或 `x-ops-token: <API_OPS_TOKEN>`。响应会聚合 `/health/deep`、知识库 stats 和反馈 stats，用于生产监控、后台页或告警系统；不要把 token 暴露到公开前端。

同源 Web 运维页：

```http
GET /ops
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

回答质量反馈接口：

```http
POST /api/feedback
```

Web UI 会在每条回答后提供反馈按钮，提交 rating、问题、回答、intent 和引用数量到 Postgres 的 `rag_feedback` 表，不记录明文 `userId`。反馈表由 `pnpm rag:ingest` 的迁移创建，最近反馈和正负反馈数量可以用 `pnpm rag:feedback` 查看；生产 triage 可以用 `pnpm rag:feedback -- --rating negative --limit 25 --json` 导出负反馈队列。

## 常用命令

```bash
pnpm start           # 启动前检查/增量更新知识库，然后启动 API + Web
pnpm sync            # 增量同步知识库，适合线上定时任务
pnpm sync -- --full  # 全量重建知识库，适合发布前或文档结构大改
pnpm check           # lint + format check + typecheck + tests
```

高级调试和排障命令仍然保留：

```bash
pnpm rag:ingest
pnpm rag:sync:x
pnpm rag:migrate
pnpm rag:stats
pnpm rag:feedback
pnpm rag:ask -- "问题"
pnpm rag:evaluate -- --fast
pnpm rag:evaluate
pnpm ops:smoke
```

`pnpm rag:ingest` 会执行数据库迁移、重新生成全部 embeddings、写入 pgvector，并记录一次 ingestion run，包括 run id、文档数、chunk 数、来源分布和内容指纹。`pnpm rag:sync:x` 用来增量同步 X 更新日志：只 embedding 新增或内容变化的 X chunks，不会 prune 旧知识块。`pnpm rag:migrate` 只执行数据库迁移，不调用 embedding 或 LLM。`pnpm rag:stats` 用来查看当前知识库文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。

`pnpm rag:feedback` 用来查看用户反馈总数、正负反馈数量和最近反馈明细，便于把低质量回答补进知识库或评测集。支持 `--rating positive|negative`、`--limit <数量>` 和 `--json`，例如 `pnpm rag:feedback -- --rating negative --limit 25 --json` 可输出可被脚本消费的负反馈队列。

`pnpm sync` 是对底层刷新流程的主入口：默认顺序是增量 `x:scrape`、`rag:sync:x`、RAG 生产检查、导出负反馈 JSON 队列。只刷新本地/已更新文档时可以用 `pnpm sync -- --skip-scrape`，发布前可用 `pnpm sync -- --full` 执行全量 scrape、全量 ingest 和完整 LLM eval。

`pnpm ops:smoke` 用于检查已经启动的 API 服务，默认检查 `http://localhost:3000/health` 和 `/health/deep`。线上可用 `pnpm ops:smoke -- --base-url https://你的域名 --ops-token "$API_OPS_TOKEN"` 检查受保护的 ops summary，并校验 `txAnalysisRuntime` 里 provider、reviewer、报告 store、浏览器并发、重试、超时、headless 模式和截图 URL 前缀完整可读；加 `--chat` 会额外请求一次 `/api/chat` 并校验回答和 citations；加 `--tx-analysis --tx-hash <hash-or-explorer-url> --tx-chain base|ethereum|bsc|solana|unknown` 会请求 `/api/tx-analysis` 并校验返回 `tx_sandwich_detection` intent，`--tx-chain` 和 `TX_ANALYSIS_SMOKE_CHAIN` 在校验报告链名时也会兼容 `ETH`、`SOL`、`BNBChain`、`BNB Smart Chain`、`Binance SmartChain` 和 `BEP20` 等常见别名。真实 browser provider 验收时可再加 `--tx-require-screenshot --tx-require-report`，要求返回图片附件和报告链接；加 `--tx-verify-assets` 会先要求响应包含图片附件和报告链接，再进一步 GET 截图和报告链接，并要求截图响应是 `image/*` 且正文是非空的 PNG/JPEG/WebP/GIF/SVG 图片内容，校验报告 JSON 至少包含 `version: 1`、`status`、`reference` 和成功/失败正文，同时确认报告 reference 与 success result 都匹配本次请求的交易哈希和显式链，success result 包含 verdict、confidence、summary、evidence、relatedTransactions、analyzedAt、交易浏览器 URL 和 XXYY 池子页 URL，且 summary、analyzedAt 和 evidence 文本都不能是空白或带首尾空白，targetTradeSide 和 relatedTransactions 的可选 side 只能是 `buy`、`sell` 或 `unknown`，relatedTransactions 里有用户交易、不能包含重复交易哈希（EVM 大小写无关），且每条相关交易都有合法角色、非空 hash/summary、可选 timestamp/traderAddress 非空且无首尾空白，以及有效且匹配显式链的 explorer URL，XXYY 池子页 URL 也必须匹配显式链，`sandwiched` 结论还必须同时包含前置和后置交易，failure report 包含受支持的 reason 和非空且无首尾空白的 message，failure metadata 的普通复查字符串和 probeAttempts 错误信息不能是空白或带首尾空白，`target_trade_not_found` / `screenshot_unavailable` 失败报告还必须在 metadata 中包含交易浏览器 URL 和 XXYY 池子页 URL，且这些复查链接也必须匹配显式链；如果 failure metadata 已包含 relatedTransactions，也会先确认没有重复交易哈希（EVM 大小写无关），再逐条确认相关交易有合法角色、非空 hash/summary、可选 timestamp/traderAddress 非空且无首尾空白，且 explorer 链接匹配显式链；success result 或 failure metadata 的截图 URL 必须与返回图片附件一致，确认静态资产或报告详情可打开且不是空响应；也可以用 `TX_ANALYSIS_SMOKE_TX_HASH`、`TX_ANALYSIS_SMOKE_CHAIN`、`TX_ANALYSIS_SMOKE_REQUIRE_SCREENSHOT=true`、`TX_ANALYSIS_SMOKE_REQUIRE_REPORT=true` 和 `TX_ANALYSIS_SMOKE_VERIFY_ASSETS=true` 提供交易分析 smoke 参数。
成功交易分析报告还会写入 `screenshotTargetRowMarked: true`，表示返回的 XXYY 原页面截图已经把用户提交的目标交易行框选出来；报告列表和 `/ops` 页面会展示该状态，`--tx-verify-assets` 会把缺少该标记的成功报告视为失败。

多链真实样本验收可以把样本写入 JSON 文件并用 `--tx-samples` 一次执行；文件可以是数组或 `{ "samples": [...] }`，每条样本支持 `label`、`chain`、`txHash`，以及可选的 `verifyAssets`、`requireScreenshot`、`requireReport`、`expectedStatus`、`expectedChain`、`expectedDataSource`、`expectedVerdict`、`expectedConfidence`、`expectedAnalysisRuleVersion`、`expectedFailureReason`、`expectedFailureMessage`、`expectedProbeAttempts`、`expectedExplorerUrl`、`expectedXxyyPoolUrl`、`expectedPoolAddress`、`expectedContractAddress`、`expectedRouterAddress`、`expectedScreenshotTargetRowMarked`、`expectedTargetTradeSide`、`expectedTargetTraderAddress`、`expectedTransactionTime`、`expectedRelatedTransactionCount`、`expectedRelatedTransactionRoles`、`expectedRelatedTransactions` 覆盖项；写了任一预期字段会自动启用截图和报告资产校验。

批量跑真实样本时可加 `--continue-on-error` 或设置 `API_SMOKE_CONTINUE_ON_ERROR=true`，让 smoke 在单条样本失败后继续执行后续样本，并在最后汇总失败数量。`expectedChain` 可固定报告最终归档链，适合 `chain: "unknown"` 的裸 EVM 自动识别样本；`expectedDataSource` 可写 `browser` 来确认真实样本没有误走 fixture 演示路径，`expectedConfidence` 用来固定报告里的 0-1 置信度，`expectedAnalysisRuleVersion` 用来固定 sandwich 判断规则版本，`expectedFailureReason` 和 `expectedFailureMessage` 用来固定失败根因和失败报告文案，`expectedProbeAttempts` 用来固定裸 EVM 自动探测各链的失败原因和可选 message，`expectedExplorerUrl` 和 `expectedXxyyPoolUrl` 用来固定实际复查入口，`expectedRouterAddress` 用来固定 EVM 路由合约解析结果，`expectedScreenshotTargetRowMarked` 用来固定目标交易行是否已在截图中标记，`expectedTargetTradeSide` 用来固定目标交易方向，`expectedTransactionTime` 用来固定报告解析出的交易时间。

`expectedRelatedTransactionCount` 和 `expectedRelatedTransactionRoles` 可固定窗口内相关交易数量和角色顺序，例如 `5 related + user + 5 related`；其中 `expectedRelatedTransactionCount` 必须是非负整数，`expectedRelatedTransactionRoles` 必须是非空数组且每项只能是 `front_run`、`user`、`back_run` 或 `related`。`expectedRelatedTransactions` 用来声明报告里的 relatedTransactions 必须包含的 `front_run`、`user`、`back_run` 或 `related` 交易 hash 和 role，并可进一步固定该条相关交易的 `explorerUrl`、`side`、`traderAddress` 和 `timestamp`；如果 probe chain/reason/message 不匹配、related transaction 数量或角色顺序不匹配，或 related transaction 的同一 hash 和 role 已命中但细节字段不匹配，smoke 会返回字段级错误；相关交易复查链接也兼容 `explorer_url`、`explorerLink`、`explorer_link`、`txUrl`、`tx_url`、`txLink`、`tx_link`、`transactionUrl`、`transaction_url`、`transactionLink`、`transaction_link`、`url`、`link` 和 `href`；显式写入的可选预期文本字段、probe message、related transaction 的复查链接 / `traderAddress` / `timestamp` 都不能是空白，复查链接还必须是 HTTP(S) URL，方向字段只能写 `buy`、`sell` 或 `unknown`。示例：

```json
{
  "samples": [
    {
      "label": "Solana pool sample",
      "chain": "solana",
      "txHash": "<solana-signature>",
      "expectedVerdict": "not_sandwiched"
    },
    {
      "label": "Base pool sample",
      "chain": "base",
      "txHash": "<base-tx-hash>",
      "expectedChain": "base",
      "expectedDataSource": "browser",
      "expectedConfidence": 0.6,
      "expectedAnalysisRuleVersion": "sandwich-window-rules-v1",
      "expectedExplorerUrl": "https://basescan.org/tx/<base-tx-hash>",
      "expectedXxyyPoolUrl": "https://www.xxyy.io/base/<base-pool-address>",
      "expectedPoolAddress": "<base-pool-address>",
      "expectedContractAddress": "<base-token-address>",
      "expectedRouterAddress": "<base-router-address>",
      "expectedScreenshotTargetRowMarked": true,
      "expectedTargetTradeSide": "buy",
      "expectedTargetTraderAddress": "<base-trader-address>",
      "expectedTransactionTime": "2026-06-13T00:00:00.000Z",
      "expectedRelatedTransactionCount": 4,
      "expectedRelatedTransactionRoles": ["related", "front_run", "user", "back_run"],
      "expectedRelatedTransactions": [
        {
          "role": "related",
          "hash": "<nearby-context-tx-hash>"
        },
        {
          "role": "front_run",
          "hash": "<front-run-tx-hash>",
          "explorerUrl": "https://basescan.org/tx/<front-run-tx-hash>",
          "side": "buy",
          "traderAddress": "<front-run-trader>",
          "timestamp": "2026-06-13T00:00:00.000Z"
        },
        {
          "role": "user",
          "hash": "<base-tx-hash>",
          "explorerUrl": "https://basescan.org/tx/<base-tx-hash>",
          "side": "buy",
          "traderAddress": "<base-trader-address>",
          "timestamp": "2026-06-13T00:00:01.000Z"
        },
        {
          "role": "back_run",
          "hash": "<back-run-tx-hash>",
          "explorerUrl": "https://basescan.org/tx/<back-run-tx-hash>",
          "side": "sell",
          "traderAddress": "<back-run-trader>",
          "timestamp": "2026-06-13T00:00:02.000Z"
        }
      ],
      "expectedVerdict": "sandwiched"
    },
    {
      "label": "Ethereum pool sample",
      "chain": "ethereum",
      "txHash": "<ethereum-tx-hash>",
      "expectedStatus": "success"
    },
    {
      "label": "BSC screenshot failure sample",
      "chain": "bsc",
      "txHash": "<bsc-tx-hash>",
      "expectedStatus": "failure",
      "expectedFailureReason": "screenshot_unavailable",
      "expectedFailureMessage": "已定位交易窗口，但无法生成带目标行标记的 XXYY 原页面截图。",
      "expectedProbeAttempts": [
        {
          "chain": "base",
          "reason": "tx_not_found"
        },
        {
          "chain": "ethereum",
          "reason": "browser_verification_required",
          "message": "Etherscan requires browser verification"
        }
      ]
    }
  ]
}
```

运行 `pnpm ops:smoke -- --tx-samples ./tx-smoke-samples.json --tx-verify-assets` 会对所有样本复用同一套截图、报告、链名、交易哈希、XXYY 池子页和 relatedTransactions 校验；也可以用 `TX_ANALYSIS_SMOKE_SAMPLES_FILE=./tx-smoke-samples.json` 配置样本文件。仓库内置的 `docs/tx-analysis-smoke-samples.example.json` 包含真实 Solana、Base、Ethereum、BSC，以及裸 EVM 自动识别 Base/Ethereum/BSC 样本，可用 `pnpm ops:smoke -- --tx-samples docs/tx-analysis-smoke-samples.example.json --tx-verify-assets` 作为本地 browser provider 规则版本、交易时间、截图和交易窗口回归验收起点。

如果 failure metadata 已包含 relatedTransactions，smoke verifier 还会要求其中包含本次请求的用户交易，并逐条确认相关交易 explorer 链接匹配显式链。
success result 或 failure metadata 的主 explorer URL 必须指向本次请求的交易哈希；如果报告里已经解析出 poolAddress，XXYY 池子页 URL 也必须指向同一个池子；relatedTransactions 还会校验每条 explorer URL 指向的交易哈希与该条记录的 hash 一致，避免同链但错交易或错池子的复查链接混进报告。

`pnpm rag:evaluate -- --fast` 仍会使用 embedding + pgvector 检索，但回答阶段使用本地 grounded answer，不调用 chat LLM；适合快速检查检索、引用和边界分类。`pnpm rag:evaluate` 会调用配置的大模型，适合发布前确认最终客服回答质量。

更多产品知识库和运行说明见 [docs/README.md](docs/README.md)。
