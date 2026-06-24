# Feature Status

本文档记录 LangGraph Agentic RAG 迁移后的当前功能状态。项目当前定位是 XXYY 客服 Agent：用产品文档和官方 X / Twitter 更新回答产品支持问题，并在交易哈希问题上规划调用交易分析工具。

## Current First Slice

- [x] LangGraph 客服 Runtime：`packages/agent-core` 使用 LangGraph JS 组织策略保护、planner、工具执行和回答合成。第一片允许的工具是产品问答和交易分析，账户、订单、钱包余额、私有交易记录和投资建议请求会先进入边界回复。
- [x] Product RAG：产品问题会检索 Postgres + pgvector 中的知识库 chunks，并通过 OpenAI-compatible chat completion 生成带引用回答。知识来源包含 `docs/product-features` 产品文档和官方 X / Twitter 更新。
- [x] X / Twitter 增量同步：`pnpm sync` 默认执行增量抓取和 `rag:sync:x`；`pnpm sync -- --full` 用于低频全量抓取和重建。
- [x] 交易哈希分析路线：聊天入口和 `POST /api/tx-analysis` 都可以接收公开交易哈希或受支持 explorer 链接。默认使用本机 Chrome 查询公开交易浏览器和 XXYY 原池子页；显式 `TX_ANALYSIS_PROVIDER=none` 时才返回暂未启用。
- [x] 多链交易分析初版：浏览器取证当前支持 Solana，并已接入 Base、Ethereum、BSC 初版。规则化 SandwichAnalyzer 会保留可复查的交易窗口、证据、截图和相关交易上下文。
- [x] 可选模型复核：`TX_ANALYSIS_REVIEWER=openai` 会在已抓取窗口和规则证据基础上做复核；复核不可用或不可解析时保留规则结果。
- [x] HTTP 服务面：保留 `GET /`、`GET /health`、`GET /health/deep`、`POST /api/chat`、`POST /api/chat/stream`、`POST /api/tx-analysis` 和 `GET /assets/*`。
- [x] Web UI：`GET /` 提供静态聊天界面，支持普通回答、流式回答、引用展示、视频附件和交易分析图片附件。
- [x] 静态资产：`GET /assets/*` 返回产品文档视频、交易分析截图和本地报告文件等静态资源。
- [x] 服务保护：API 对 JSON 请求体大小、聊天/交易分析 POST 请求频率和跨域来源做基础限制，配置项为 `API_MAX_BODY_BYTES`、`API_RATE_LIMIT_MAX`、`API_RATE_LIMIT_WINDOW_MS` 和 `API_CORS_ORIGIN`。
- [x] MCP 工具：`pnpm product:mcp` 暴露 `search_product_docs` 和 `answer_product_question`；`pnpm tx:mcp` 暴露 `analyze_transaction`；`pnpm tx:mcp:smoke` 可跑交易分析 MCP 样本。
- [x] 保留命令：保留 `pnpm start`、`pnpm sync`、`pnpm sync -- --full`、`pnpm check`、`pnpm rag:ingest`、`pnpm rag:sync:x`、`pnpm rag:migrate`、`pnpm rag:stats`、`pnpm rag:ask` 和 `pnpm agent:smoke`。

## Explicit Boundaries

- [x] 不查询用户账户、订单、钱包余额或私有交易记录。
- [x] 不执行代开通、代取消、代修改等账户或订单动作。
- [x] 不提供投资建议、收益承诺或买卖建议。
- [x] 未支持链、测试网、多笔交易混合请求和缺少明确交易引用的问题会返回澄清或暂不支持。
- [x] 产品知识库、embedding、chat LLM 或 vector store 配置缺失时，对外错误应清晰区分配置缺失和运行时不可用。

## Planned Or Not Yet Complete

- [ ] 池子查询工具：把公开池子信息查询纳入 LangGraph planner 可调用工具。
- [ ] 链上分析工具：在交易哈希分析之外，扩展更多公开链上取证能力。
- [ ] 交易分析多链稳定性：继续补 Base、Ethereum、BSC 的真实页面结构、备用浏览器和 XXYY 池子窗口样本。
- [ ] 产品知识质量增强：继续补官方文档、X / Twitter 更新和回归样本，让 Product RAG 对新功能更新更稳。
- [ ] 多渠道接入：在不改变客服 Agent 核心边界的前提下，接入更多入口。
- [ ] 工具权限策略：为未来池子查询、链上分析和其它公开工具补更细粒度的权限与安全策略。
