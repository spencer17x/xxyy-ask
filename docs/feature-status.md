# Feature Status

本文档记录当前功能状态。项目当前定位是 XXYY 产品客服 Agent：用产品文档和官方 X / Twitter 更新回答产品支持问题。

## Current First Slice

- [x] LangGraph 客服 Runtime：`packages/agent-core` 使用 LangGraph JS 组织策略保护、planner、检索工具、证据观察和回答合成。当前只注册 `search_product_docs` 业务工具；账户、订单、钱包余额、私有交易记录、交易分析和投资建议请求会先进入边界或澄清回复。
- [x] Product RAG：产品问题会检索 Postgres + pgvector 中的知识库 chunks，并通过 OpenAI-compatible chat completion 生成带引用回答。正式来源限定为 `docs.xxyy.io` 官方文档、`x.com/useXXYYio` 官方更新，以及未来经过审核的客服群知识；客服群来源当前为空。
- [x] X / Twitter 增量同步：`pnpm run app:dev -- --sync` 执行增量抓取和 `rag:sync:x` 后启动服务；`pnpm run app:dev -- --full-sync` 用于低频全量抓取和重建后启动服务。
- [x] HTTP 服务面：保留 `GET /`、`GET /health`、`GET /health/deep`、`POST /api/chat`、`POST /api/chat/stream` 和 `GET /assets/*`。
- [x] Web UI：`GET /` 提供静态聊天界面，支持普通回答、流式回答、引用展示和产品知识库附件。
- [x] Telegram Bot：`pnpm run telegram:dev` 通过 Telegram Bot API long polling 接收文本消息，并以 `channel: "telegram"` 复用同一套 LangGraph 客服 Agent。
- [x] Knowledge Curator MVP：Telegram Desktop JSON 可按角色有效期验证作者、重建 reply 线程、脱敏、分类、标准化、去重、检查正式 chunk 冲突并生成质量/风险信息；默认确定性提取，`--agent` 可选处理多消息上下文。所有结果只进入 `pending`，必须人工批准并通过发布门禁才会写入 `admin_verified` 和 pgvector。
- [x] 知识治理管理面：`GET /admin` 提供独立 Bearer Token 认证和 `viewer/reviewer/publisher/admin` RBAC，支持候选上下文、重复/冲突对比、revision/history、批准、拒绝、可信作者和 Telegram 导入；公开客服 API 仍不暴露知识写入能力。
- [x] 可靠发布任务：后台只创建 `PublicationJob`；CLI Worker 使用租约领取任务并复用既有发布门禁，支持失败状态、审计、幂等申请和安全重试，最终候选状态与 pgvector ingest 在同一数据库事务完成。
- [x] 新旧规则策略：当前问题默认排除被 `supersedes` 替代的知识，历史追溯问题仍可检索旧版本。
- [x] RAG Trustworthiness v0.2：知识正文和标题/章节元数据先执行凭证脱敏与 prompt injection 隔离；回答上下文按 chunk、完整句子和限制条件打包；模型回答在返回前执行本地 claim grounding，未被安全证据支持的数字、限制、支持状态或操作事实会降级为确定性回答。流式路径先完成同一校验，避免无证据 token 已发送后无法撤回。
- [x] Bounded Agent Loop v0.3：普通产品问题用完整原问题执行一次检索后直接合成；比较/多模块问题由 observation 识别缺失维度并允许一次或多次受限 query rewrite。max steps、重复输入和无新增证据共同阻止死循环，ask/stream 使用同一充分性与 composer 契约。
- [x] Capability Plane v0.1：`packages/agent-core` 提供独立、未接线的 manifest/adapter/registry、默认拒绝授权、确认/幂等硬门禁、timeout/cancellation/output limit 和脱敏审计契约，为未来自建 MCP / Skill 做准备；当前客服工具列表和 Chat API 不变。
- [x] Read-only EVM Transaction Analysis Core v0.1：独立纯 TypeScript 包离线分析 normalized transaction snapshot，确定性输出 success/reverted/pending/unknown、原生/ERC-20 资产变化、精确 gas fee、timeline、统一 Evidence/SkillResult、warnings 和 diagnostics；没有网络/MCP/Agent 接线。
- [x] Allowlisted Read-only EVM Data Adapter v0.1：独立包用启动时 chain/provider allowlist 调用四个标准只读 JSON-RPC，验证 chain/hash/block/index，限制 endpoint、redirect、header、batch、timeout、retry 和 response bytes，将多 provider 结果无损归一化为 snapshot 并保留 diagnostics/conflicts；没有生产 endpoint 或运行面接线。
- [x] EVM Execution Enrichment Core v0.1：独立离线包校验最多 250 节点/32 层的扁平 call trace，只有成功 receipt 且调用及祖先均成功时才应用 internal native transfer；严格解码 Solidity Error/Panic/custom selector 和带显式 pool/token metadata 的 Uniswap V2/V3 swap，缺失或畸形输入显式降级；没有 trace provider、网络/MCP/Agent 接线。
- [x] Allowlisted EVM Execution Data Adapter v0.1：独立未接线包用启动时 chain/provider/factory allowlist 获取固定 Geth callTracer，在精确 block 验证 pool/factory code、token、V3 fee 和 factory `getPair/getPool` 反查；限制 endpoint、method、calldata、timeout、响应、trace 和 pool 资源，保留脱敏 diagnostics 与 semantic provider conflicts；没有生产 provider 或运行面接线。
- [x] EVM Price Impact / Sandwich Detection Core v0.1：独立离线包校验最多 256 笔同区块同 pool swap、pre/post state、actor token delta、coverage 和 conflicts；用 bigint 复刻 V2 exact-input 与 V3 单 active-range rounding，输出 price impact、counterfactual victim loss 和 `confirmed | likely | unlikely | insufficient_data` 四态 verdict；没有网络、LLM、MCP/Agent 接线。
- [x] 静态资产：`GET /assets/*` 返回产品文档视频、图片等静态资源。
- [x] 服务保护：API 对 JSON 请求体大小、聊天 POST 请求频率和跨域来源做基础限制，配置项为 `API_MAX_BODY_BYTES`、`API_RATE_LIMIT_MAX`、`API_RATE_LIMIT_WINDOW_MS` 和 `API_CORS_ORIGIN`。
- [x] 本地开发命令：启动入口统一为 `pnpm run app:dev`、`pnpm run api:dev`、`pnpm run web:dev` 和 `pnpm run telegram:dev`；知识库更新通过 `app:dev` 的 `--sync`、`--full-sync` 或 `--ingest` 参数显式触发。

## Explicit Boundaries

- [x] 不查询用户账户、订单、钱包余额或私有交易记录。
- [x] 不执行代开通、代取消、代修改等账户或订单动作。
- [x] 不提供投资建议、收益承诺或买卖建议。
- [x] 交易哈希、交易链接、池子查询、链上取证和泛 MEV 分析请求当前不处理。
- [x] 产品知识库、embedding、chat LLM 或 vector store 配置缺失时，对外错误应清晰区分配置缺失和运行时不可用。

## Paused

- [ ] 实际 MCP server / adapter 暂停：不再提供 `product:mcp:dev`、`tx:mcp:dev` 或 MCP smoke 脚本；Capability Plane 基础库不启动 server，也不连接远端 MCP。
- [ ] Project skills 暂停：不再保留仓库内 `skills/` 目录，Capability Plane 当前没有注册本地 Skill。
- [ ] 公开交易分析入口仍暂停：EVM transaction/execution/MEV cores 与两个 RPC adapter 都没有 app 配置、Capability 注册或 Agent bridge；聊天中交易、Explorer、链上取证和 MEV 问题继续进入边界/澄清回复。

## Planned Or Not Yet Complete

- [ ] 产品知识质量增强：继续补官方文档、X / Twitter 更新和回归样本，让 Product RAG 对新功能更新更稳。
- [ ] 更多渠道接入：在不改变客服 Agent 核心边界的前提下，继续接入更多入口。
- [ ] Telegram Guest Mode 教学入口：在候选知识与审核权限模型之上接入 `/teach`、`/approve`、`/reject`，不直接自动发布群聊内容。
- [ ] 安全与隐私增强：继续完善数据保留、删除策略和生产告警；Product RAG 的 prompt injection 隔离与敏感信息脱敏已落地。
- [ ] 链上能力下一阶段：实现 allowlisted MEV observation adapter，受控获取完整 block 相关交易、transaction-boundary pool state、V3 tick/liquidity 和 actor token delta；在生产 QPS/熔断/缓存/metrics、内部授权和端到端评测完成前不接入运行面。
