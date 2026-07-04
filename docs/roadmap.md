# Roadmap

本文档记录当前工程方向。当前功能状态见 [feature-status.md](feature-status.md)。

## Completed First Slice

- [x] LangGraph 客服 Runtime：`CustomerAgentRuntime` 已迁移到 LangGraph JS，统一处理产品问答、边界回复、工具降级和最终回答合成。
- [x] Product RAG：产品问题基于 Postgres + pgvector 检索产品文档和官方 X / Twitter 更新，再调用 OpenAI-compatible chat completion 生成带引用回答。
- [x] 官方 X / Twitter 同步：`pnpm run app:dev -- --sync` 做增量抓取和入库后启动服务，`pnpm run app:dev -- --full-sync` 做低频全量重建后启动服务。
- [x] 服务基础面：Web UI、health/deep health、chat/stream、static assets、请求体限制、基础限流和 CORS 配置已保留。
- [x] Telegram Bot：long polling 入口复用同一套客服 Agent runtime。
- [x] 基础可信度建设：deterministic guard、planner route、tool registry、stream schema 校验、golden QA、基础 reranker extension point 已具备。

## Paused / Out of Scope

- [ ] MCP 和 project skills：当前阶段先移除，不作为对外或本地调用入口。
- [ ] 交易分析、池子查询和链上取证：当前客服入口只做知识库产品回答，相关问题进入边界/澄清回复。
- [ ] 账户、订单、钱包余额、私有交易记录和投资建议：长期保持边界，不进入自动回答或自动操作链路。

## v0.2 RAG Trustworthiness

目标：让产品知识库回答更可信、可追溯，并能处理官方文档与 X / Twitter 更新之间的新旧冲突。

- [ ] 知识新旧与冲突策略：为 official docs / X updates 增加 freshness、effective time、current / historical / deprecated 状态与冲突解决规则。
- [ ] Citation grounding：验证答案中的关键 claim 是否被引用片段支持，避免“有引用但引用不支撑答案”。
- [ ] Chunk-aware context packing：替代固定字符截断，按 chunk / 句子 / 限制条件保留关键上下文。
- [ ] Prompt injection 防护：把知识库内容当作资料而不是指令，检测并清洗外部来源中的指令注入文本。
- [ ] Golden QA 扩充：补充真实客服问题、历史失败样本、知识冲突样本、边界样本和引用稳定性样本。

成功标准：默认回答当前有效规则；冲突时不混合旧/新事实；关键事实有可验证引用；`pnpm check` 覆盖核心回归样本。

## v0.3 Bounded Agent Loop

目标：在保持客服边界的前提下，让 Agent 支持复杂产品问题的受控多步检索与证据观察。

- [ ] 拆分工具职责：将 `answer_product_question` 的“大工具”能力拆为 `search_product_docs` + evidence collection + `answer_composer`。
- [ ] 增加 observe 节点：`tool_executor` 后进入 observation，基于证据质量决定继续规划还是回答。
- [ ] 增加有界 loop：实现 `planner -> search -> observe -> planner -> answer`，并保留 max steps、重复工具调用检测和无新增证据停止。
- [ ] Planner query rewrite policy：明确 planner 是否允许改写检索 query；若允许，保留 original question 与 rewritten query 的职责边界。
- [ ] Evidence sufficiency：判断证据是否足够回答，证据不足时二次检索或澄清。

成功标准：普通问题仍保持单步低延迟；复杂比较 / 多模块问题可以多步检索；loop 不会死循环或重复调用同一工具输入。

## v0.4 Evaluation & Feedback Loop

目标：把评测从基础 golden QA 扩展为持续回归、线上反馈沉淀和发布前验收体系。

- [ ] 扩展 golden QA 到 30+ realistic support cases，覆盖产品 FAQ、how-to、套餐限制、链支持、历史更新、边界拒答。
- [ ] 加入 citation grounding eval、answer completeness eval、context recall / precision 指标。
- [ ] Provider-backed evaluation report：让 `pnpm rag:evaluate -- --provider` 输出更适合人工验收的报告。
- [ ] Feedback-to-eval backlog：将负反馈、低置信度、无引用、异常回答沉淀为待审核 eval case。
- [ ] Regression workflow：每次修复线上错误时必须新增或更新 golden QA。

成功标准：常规 CI 能跑便宜稳定的 deterministic eval；发布前可以跑 provider-backed eval；线上失败可以持续回流为测试资产。

## v0.5 Production Readiness, Safety & Observability

目标：让服务具备更强的生产安全、观测、配额、部署与运维能力。

- [ ] Request tracing：串联 guard、planner route、tool call、retrieval scores、LLM latency、token usage、fallback reason 和 final citations。
- [ ] API abuse control：增加 user / session / channel 级配额、API key rotation、异常请求监控和审计。
- [ ] ToolPolicy authorization：真正执行工具级权限，或移除未使用的 policy 字段，避免权限错觉。
- [ ] Data privacy：明确日志、feedback、用户输入、LLM 请求的数据保留、脱敏和删除策略。
- [ ] Deployment docs：补齐 production Docker / migration / backup / pgvector index tuning / multi-instance rate limit 方案。
- [ ] Human handoff / ticketing readiness：如果未来接入工单或人工客服，必须先有权限、审计和人工确认边界。

成功标准：服务能安全暴露给真实用户；异常请求、错误回答和模型成本可观测；敏感数据有明确处理策略。

## GitHub Planning Convention

- Roadmap 记录长期方向和阶段目标。
- Epic issue 记录一个大方向的目标、范围和任务列表。
- 普通 issue 记录可以由一个 PR 完成的具体任务。
- 每个 PR 应尽量关联一个具体 issue；大功能通过 Epic issue 追踪整体进度。
