# Feature Status

本文档记录当前功能状态。项目当前定位是 XXYY 产品客服 Agent：用产品文档和官方 X / Twitter 更新回答产品支持问题。

## Current First Slice

- [x] LangGraph 客服 Runtime：`packages/agent-core` 使用 LangGraph JS 组织策略保护、planner、工具执行和回答合成。当前允许的业务工具只有产品问答，账户、订单、钱包余额、私有交易记录、交易分析和投资建议请求会先进入边界或澄清回复。
- [x] Product RAG：产品问题会检索 Postgres + pgvector 中的知识库 chunks，并通过 OpenAI-compatible chat completion 生成带引用回答。正式来源限定为 `docs.xxyy.io` 官方文档、`x.com/useXXYYio` 官方更新，以及未来经过审核的客服群知识；客服群来源当前为空。
- [x] X / Twitter 增量同步：`pnpm run app:dev -- --sync` 执行增量抓取和 `rag:sync:x` 后启动服务；`pnpm run app:dev -- --full-sync` 用于低频全量抓取和重建后启动服务。
- [x] HTTP 服务面：保留 `GET /`、`GET /health`、`GET /health/deep`、`POST /api/chat`、`POST /api/chat/stream` 和 `GET /assets/*`。
- [x] Web UI：`GET /` 提供静态聊天界面，支持普通回答、流式回答、引用展示和产品知识库附件。
- [x] Telegram Bot：`pnpm run telegram:dev` 通过 Telegram Bot API long polling 接收文本消息，并以 `channel: "telegram"` 复用同一套 LangGraph 客服 Agent。
- [x] Knowledge Curator MVP：Telegram Desktop JSON 可按角色有效期验证作者、重建 reply 线程、脱敏、分类、标准化、去重、检查正式 chunk 冲突并生成质量/风险信息；默认确定性提取，`--agent` 可选处理多消息上下文。所有结果只进入 `pending`，必须人工批准并通过发布门禁才会写入 `admin_verified` 和 pgvector。
- [x] 知识治理管理面：框架无关的 `KnowledgeGovernanceService` 与 CLI 支持可信作者、候选列表、修订、版本历史、批准和拒绝；公开客服 API 不暴露知识写入能力。
- [x] 新旧规则策略：当前问题默认排除被 `supersedes` 替代的知识，历史追溯问题仍可检索旧版本。
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

- [ ] MCP server 暂停：不再提供 `product:mcp:dev`、`tx:mcp:dev` 或 MCP smoke 脚本。
- [ ] Project skills 暂停：不再保留仓库内 `skills/` 目录。
- [ ] 交易分析代码和入口已移除，聊天中交易相关问题进入边界/澄清回复。

## Planned Or Not Yet Complete

- [ ] 产品知识质量增强：继续补官方文档、X / Twitter 更新和回归样本，让 Product RAG 对新功能更新更稳。
- [ ] 更多渠道接入：在不改变客服 Agent 核心边界的前提下，继续接入更多入口。
- [ ] Telegram Guest Mode 教学入口：在候选知识与审核权限模型之上接入 `/teach`、`/approve`、`/reject`，不直接自动发布群聊内容。
- [ ] 认证管理后台：在 RBAC、CSRF、审计和独立管理边界完成后，为当前治理服务增加候选对比、审核、发布状态和角色维护 UI。
- [ ] 安全与隐私增强：完善 prompt injection 防护、敏感信息脱敏、数据保留和删除策略。
