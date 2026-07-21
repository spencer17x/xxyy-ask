# Roadmap

本文档记录当前工程方向。当前功能状态见 [feature-status.md](feature-status.md)。

## Completed First Slice

- [x] LangGraph 客服 Runtime：`CustomerAgentRuntime` 已迁移到 LangGraph JS，统一处理产品问答、边界回复、工具降级和最终回答合成。
- [x] Product RAG：产品问题基于 Postgres + pgvector 检索产品文档和官方 X / Twitter 更新，再调用 OpenAI-compatible chat completion 生成带引用回答。
- [x] 官方 X / Twitter 同步：`pnpm run app:dev -- --sync` 做增量抓取和入库后启动服务，`pnpm run app:dev -- --full-sync` 做低频全量重建后启动服务。
- [x] 服务基础面：Web UI、health/deep health、chat/stream、static assets、请求体限制、基础限流和 CORS 配置已保留。
- [x] Telegram Bot：long polling 入口复用同一套客服 Agent runtime。
- [x] Knowledge Curator MVP：可信作者与角色有效期、Telegram 线程重建、确定性/可选 Agent 提取、脱敏、去重、冲突、质量评分、候选 revision/review/audit、管理 CLI 和发布门禁已具备。
- [x] Knowledge Governance Admin Console MVP：独立管理认证与 RBAC、候选上下文/冲突对比、可信作者、Telegram 导入、PublicationJob 状态/租约/安全重试和受控发布 Worker 已具备；公开客服接口保持无鉴权只读。
- [x] 基础可信度建设：deterministic guard、planner route、tool registry、stream schema 校验、golden QA、基础 reranker extension point 已具备。

## Paused / Out of Scope

- [ ] MCP 和 project skills：当前阶段先移除，不作为对外或本地调用入口。
- [ ] 交易分析、池子查询和链上取证：当前客服入口只做知识库产品回答，相关问题进入边界/澄清回复。
- [ ] 账户、订单、钱包余额、私有交易记录和投资建议：长期保持边界，不进入自动回答或自动操作链路。

## v0.2 RAG Trustworthiness

目标：让产品知识库回答更可信、可追溯，并能处理官方文档与 X / Twitter 更新之间的新旧冲突。

- [x] 知识新旧与冲突策略：official docs / X updates / admin verified 支持 freshness、effective time、current / historical / deprecated 和 `supersedes`；当前问题使用更新规则，历史问题保留旧版本回溯。
- [x] Citation grounding：模型回答返回前，本地逐条验证关键 claim 的数字、限制、支持状态和操作事实；无证据 claim 安全降级，引用只保留实际支撑回答的 chunk。
- [x] Chunk-aware context packing：按 chunk 公平分配预算，按问题相关度、完整句子、列表和限制条件选择内容，不再固定截取每个 chunk 的前缀。
- [x] Prompt injection 防护：知识正文和可展示元数据先脱敏并检测角色覆盖、忽略规则、提示词泄露和伪造工具调用；命中片段隔离后再以 JSON 字符串进入模型上下文。
- [x] Golden QA 扩充：48 个 deterministic 用例覆盖真实客服问法、当前/历史冲突、边界、限制条件和引用稳定性；另有注入、context packing、claim grounding 与流式泄漏单元测试。

成功标准：默认回答当前有效规则；显式日期问题使用对应时间窗口；冲突时不混合旧/新事实；关键事实有可验证引用；`pnpm check` 覆盖核心回归样本。

## v0.3 Bounded Agent Loop

目标：在保持客服边界的前提下，让 Agent 支持复杂产品问题的受控多步检索与证据观察。

- [x] 拆分工具职责：生产只注册 `search_product_docs`；检索证据由 state 累积，`answer_composer` 聚合去重 chunks 后调用 AnswerProvider，不再用“大工具”同时检索和回答。
- [x] 增加 observe 节点：`tool_executor` 后按问题维度覆盖、可验证引用、distinct evidence 和 latest new evidence 形成结构化 observation，决定继续规划、回答或安全停止。
- [x] 增加有界 loop：支持 `search -> observe -> planner -> search -> observe -> answer`；max steps、标准化后的重复工具输入和不同 query 无新增 chunk/引用都会停止。
- [x] Planner query rewrite policy：首次检索固定使用完整 original question；仅在 observation 报告缺失维度后允许 rewritten query，且必须保留产品范围与时间/版本限定并命中缺失维度。
- [x] Evidence sufficiency：普通问题有直接引用即可回答；比较/多模块问题要求各维度都有证据，不足时定向二次检索，停止后返回带引用的部分证据说明或澄清。

成功标准：普通问题仍保持单次检索且不调用 Planner；复杂比较 / 多模块问题可以针对缺失维度多步检索；loop 不会死循环、重复调用同一工具输入或因 query 不同而反复消费相同证据。

## v0.4 Evaluation & Feedback Loop

目标：把评测从基础 golden QA 扩展为持续回归、线上反馈沉淀和发布前验收体系。

- [x] 扩展 golden QA 到 30+ realistic support cases：当前 48 个用例覆盖产品 FAQ、how-to、套餐限制、链支持、历史更新、边界拒答和引用稳定性。
- [x] 加入 citation grounding eval、answer completeness 辅助 judge、Recall@K / Precision@K / MRR / nDCG / forbidden-hit 指标。
- [x] Provider-backed evaluation report：`pnpm rag:evaluate -- --provider` 输出分层报告，可显式启用独立 judge。
- [x] Feedback-to-eval backlog：负反馈和 failed eval 都能输出脱敏、待审核 JSONL。
- [x] Regression workflow：文档定义失败样本人工审核、去隐私、补来源后升级 golden QA 的流程。

成功标准：常规 CI 能跑便宜稳定的 deterministic eval；发布前可以跑 provider-backed eval；线上失败可以持续回流为测试资产。

## v0.5 Production Readiness, Safety & Observability

目标：让服务具备更强的生产安全、观测、配额、部署与运维能力。

- [x] Request tracing：通过 `requestId`、客服 runtime 传递和 API 结构化日志串联 route、intent、fallback/error、citation count 和耗时。
- [x] 可选 nested tracing：vendor-neutral tracer 覆盖 planner、tool、retrieval、rerank、grounding 和 answer，LangSmith adapter 默认关闭并强制脱敏与采样。
- [x] API abuse control：基础请求体限制、IP 限流、网关级配额要求和异常监控建议已落地。
- [x] Data privacy：日志、feedback、用户输入和 LLM prompt 的脱敏、保留和删除策略已记录。
- [x] Deployment docs：已补齐 production migration、backup、pgvector index tuning 和 multi-instance rate limit 方案。
- [x] Human handoff / ticketing readiness：未来工单或人工客服接入前的权限、审计和人工确认边界已定义。

成功标准：服务能安全暴露给真实用户；异常请求、错误回答和模型成本可观测；敏感数据有明确处理策略。

## GitHub Planning Convention

- Roadmap 记录长期方向和阶段目标。
- Epic issue 记录一个大方向的目标、范围和任务列表。
- 普通 issue 记录可以由一个 PR 完成的具体任务。
- 每个 PR 应尽量关联一个具体 issue；大功能通过 Epic issue 追踪整体进度。
