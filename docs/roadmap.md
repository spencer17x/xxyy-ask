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

- [ ] 实际 MCP adapter、MCP server 和 project skills：当前阶段仍不作为对外或本地调用入口；v0.6 只交付未接线的安全能力平面契约。
- [ ] 公开交易分析、池子查询和链上取证入口：当前客服入口只做知识库产品回答，相关问题进入边界/澄清回复；离线 EVM transaction/enrichment cores 和未接线 RPC data adapter 不扩大运行面。
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

## v0.6 MCP / Skill Capability Plane Foundation

目标：在不扩大当前客服能力边界的前提下，为未来自行实现的 MCP / Skill 建立与 LangGraph 解耦、默认拒绝、可审计的执行契约。

- [x] Transport-neutral manifest：能力显式声明 namespace id、精确 semver、source、risk、side effect、data scopes、确认/幂等要求和单次资源限制。
- [x] 独立 CapabilityRegistry：目录只暴露冻结后的 manifest，不暴露 adapter；注册校验来源一致性和重复 id，不会自动加入 Planner 工具列表。
- [x] Deny-by-default policy：grant 必须精确覆盖 capability/version/source、channel/principal、风险、副作用和全部数据范围；无 grant 时在业务输入解析前拒绝。
- [x] Bounded executor：使用 manifest 与全局限制中的更小值执行 timeout、上游 cancellation、input/output schema、JSON 边界和最大输出字节检查。
- [x] 副作用硬门禁：外部写入和金融交易必须声明并提供确认与 idempotency key，即使替换自定义 policy 也不能绕过；持久化去重和 exactly-once 留给未来 adapter / coordinator。
- [x] 脱敏审计：`agent.capability` 只记录固定 manifest/policy 元数据、值类型、字段/元素数量和输出大小，不记录字段名、payload 或 idempotency key 原文。
- [x] 运行面隔离：当前 LangGraph、Web/API、Telegram、CLI 和 `ToolRegistry` 不创建或调用 CapabilityRegistry，生产业务工具仍只有 `search_product_docs`。
- [ ] 实现第一个只读 Capability / Skill adapter，并通过显式 bridge 暴露给 Agent；底层 RPC data adapter 不会自动完成注册，仍需单独授权、运行面审查和评测后再开启。

成功标准：未授权、版本漂移、来源/通道/数据范围不匹配和缺少确认/幂等的调用全部失败；超时、取消、超限与非 JSON 输出有稳定错误；当前客服行为和 Chat API 契约保持不变。详细设计见 [capability-plane.md](capability-plane.md)。

## v0.7 Read-only EVM Transaction Analysis Core

目标：先把交易事实计算实现为可测试、可重放、与 Agent/MCP/provider 解耦的领域包，为后续只读 adapter 和 Sandwich Skill 提供可信输入与证据。

- [x] 统一领域契约：`packages/shared` 提供 Zod `EvidenceItem`、`SkillFinding`、`SkillDiagnostic` 和 `SkillResult`，校验 id 唯一性和 finding/evidence/diagnostic 引用完整性。
- [x] Normalized EVM snapshot：校验 chain id、transaction/receipt/block、来源、source conflicts、address/hash/topics/bytes、canonical decimal 与 uint256 上限；金额和区块号不经过 JS number。
- [x] 确定性交易事实：区分 success/reverted/pending/unknown；只有成功 receipt 才应用原生 value，回滚仍精确计算 fee。
- [x] ERC-20 Transfer：按标准 topic 解码 from/to/raw amount 和 log index，识别 transfer/mint/burn，并聚合 signed raw asset delta。
- [x] Evidence 与 timeline：transaction、receipt、log、block 和 fee calculation 都映射到稳定 evidence ids 与 findings；输出结构化 timeline 和资产变化。
- [x] 不完整/冲突处理：缺 transaction 返回 `insufficient_data`；缺 receipt、hash/block/source 不一致、来源冲突及 removed/重复/畸形日志返回 `partial`、warnings 和 diagnostics，不静默补全事实。
- [x] 可重放 fixtures：覆盖成功原生+ERC-20、回滚、缺 receipt、双来源冲突+畸形日志和缺 transaction；fixtures 全部使用合成公开数据。
- [x] 运行面隔离：领域包不包含网络、LLM、LangGraph 或 MCP 依赖，未被 Agent/API/Telegram/CLI/CapabilityRegistry 引用，当前交易问题仍走边界回复。
- [x] 实现 allowlisted 只读 EVM data adapter 和 provider contract tests，将标准 RPC 数据转换为 normalized snapshot；adapter 没有真实 endpoint 配置且不注册 capability。
- [x] 增加有界 trace/internal transfer、Solidity revert 和 Uniswap V2/V3 pool swap decoder；LLM 不参与事实计算。
- [ ] 增加价格影响、邻近交易关联和 Sandwich 四态 verdict；缺关键池状态或 block 交易集合时不能输出 confirmed。

成功标准：相同 snapshot 重放得到相同 lossless 结果；成功/回滚的 value、ERC-20 和 fee 计算正确；缺失、冲突和畸形数据安全降级；完整 `pnpm check` 与现有客服边界回归通过。详细范围见 [transaction-analysis-core.md](transaction-analysis-core.md)。

## v0.8 Allowlisted Read-only EVM Data Adapter

目标：用独立、未接线的数据边界把受控标准 JSON-RPC 转换为 v0.7 normalized snapshot，同时不让 URL、密钥、任意 RPC 方法或网络失败进入 Agent/LLM 边界。

- [x] 启动时 allowlist：chain/provider 配置限制唯一 id、HTTPS endpoint、header 数量与保留 header；运行时只接受配置内的 chain/provider id，不接受 URL。
- [x] SSRF 与密钥边界：默认拒绝 HTTP，仅显式允许 loopback 开发节点；拒绝 URL credentials/fragment 和 redirect；provenance 只输出 origin，错误不暴露底层 cause。
- [x] 只读 RPC contract：只允许 transaction、receipt、chain id 和 block 四个方法；先验证 `eth_chainId`，配错链 fail closed。
- [x] 有界 transport：限制 batch、timeout、retry/backoff、provider 数量和 chunked response bytes；区分 abort、timeout、transport、HTTP、size、JSON 和 JSON-RPC 错误。
- [x] 无损归一化：canonical hex quantity 通过 `bigint` 转十进制，index 有界后才转 number；校验 uint256、receipt fee product、hash/block/index 关联。
- [x] 多 provider 协调：按配置顺序确定 canonical 数据，保留 missing/invalid/present 状态、关键字段 conflicts、来源观测时间和响应 SHA-256。
- [x] Adapter 状态：独立输出 `success | partial | insufficient_data` 和稳定 diagnostics；下游 core 仍独立生成领域 SkillResult。
- [x] 可重放 provider contract tests：使用注入 fetch 和合成 JSON-RPC fixtures 覆盖成功、缺失、冲突、错误链、非法 payload、重试、timeout、abort、响应超限和公开边界隔离。
- [ ] 配置生产 provider、共享 QPS/熔断/缓存/metrics，并实现内部 Capability bridge；需单独安全目标和授权后才能启用。

成功标准：运行时不能注入 endpoint 或写 RPC；错误 chain fail closed，hash/block/index 关联不一致显式降级；相同 fixtures 生成字节一致、无精度损失且带 provenance 的 snapshot；provider 局部失败和冲突安全降级；现有 Agent/API/Telegram/CLI 行为不变。详细设计见 [evm-data-adapter.md](evm-data-adapter.md)。

## v0.9 EVM Execution Enrichment Core

目标：在不接入网络和客服运行面的前提下，为 normalized snapshot 增加可重放的执行 trace、revert 和首批 DEX 事件语义，作为后续价格影响与 Sandwich 检测的可信离线输入。

- [x] 有界扁平 trace：最多 250 节点、32 层，每个 input/output 最多 8 KiB；要求唯一 path、单 root、完整 parent 和统一 source，并校验 root 与 transaction 的 chain/hash/from/to/value/input。
- [x] Internal native transfer：排除已由 transaction core 处理的 root value；只有 receipt success、当前调用成功且全部祖先成功时，才对 call/create/create2/selfdestruct 应用转账；结果资产变化必须净和为零。
- [x] Revert 语义：严格解码 canonical `Error(string)` 和 `Panic(uint256)`；未知 custom error 只保留 selector，不猜 ABI 名称；empty/畸形数据分别建模，Evidence 不保存原始 trace output。
- [x] Allowlisted swap decoder：仅识别 Uniswap V2/V3 官方 `Swap` ABI；token0/token1 必须由显式、带来源的 pool metadata 提供，不从地址或模型推测。
- [x] Lossless pool delta：V2 保留四个 in/out uint256 并计算 pool delta；V3 解码 signed int256 delta、uint160 price、uint128 liquidity 和 int24 tick；只有一正一负时才给出 token direction。
- [x] Coverage 与降级：缺失/无效/不匹配 trace、receipt、metadata，removed/重复/畸形 log、来源缺口和超过 250 个 swap 时返回 `partial` 与稳定 diagnostics；缺 transaction 或 hash 不匹配返回 `insufficient_data`。
- [x] 可重放测试：四组 JSON fixtures 和 30 个包级测试覆盖成功、整体回滚、被捕获子调用回滚、祖先回滚、V2/V3、ABI 边界、资源上限、元数据缺失和 Evidence/结果不变量。
- [x] 运行面隔离：包不依赖网络、LLM、LangGraph、Capability、MCP 或 data adapter；没有 app/CLI/API/Telegram 导入。
- [x] 独立的受控 trace/pool metadata adapter 与交叉 provider replay 已在后续 v0.10 完成；本 core 仍只消费 normalized 输入。

成功标准：相同输入重放得到字节一致结果；回滚路径不产生已提交转账；Error/Panic/unknown selector 不混淆；swap 只有显式 token metadata 才产生 token 语义；所有引用和资产守恒由 schema 二次校验；完整 `pnpm check` 与公开客服边界回归通过。详细设计见 [evm-execution-enrichment.md](evm-execution-enrichment.md)。

## v0.10 Allowlisted EVM Execution Data Adapter

目标：在不扩大基础 snapshot RPC client 权限、也不接入客服运行面的前提下，从启动时 allowlisted provider 获取 normalized call trace，并在精确 block 验证 Uniswap V2/V3 pool metadata。

- [x] 专用 RPC contract：只允许 `eth_chainId`、固定 Geth `debug_traceTransaction/callTracer`、精确 block 的 `eth_getCode`，以及六个固定 pool/factory ABI selector；运行时不能注入 endpoint、tracer、method 或任意 calldata。
- [x] Endpoint 与资源边界：复用受控 provider header schema，强制 HTTPS 或显式 loopback HTTP、禁止 redirect，限制 timeout、retry、response bytes、batch、provider 和 pool 数量。
- [x] Trace 归一化：递归 call frame 用显式 stack 转成扁平 path；限制 250 节点、32 层和单 bytes 8 KiB，quantity 无损转十进制，provider error 只保留稳定脱敏 code。
- [x] Pool/factory 验证：读取非空 code、factory/token0/token1/V3 fee；要求非零排序 token、protocol-specific factory allowlist，并用 factory `getPair/getPool` 反查候选地址。
- [x] Provenance 与协调：结果保留观测时间、payload/code SHA-256、verified pool fact；最多四 provider 按配置顺序选 canonical 数据，semantic fingerprint 区分等价与真实 trace/metadata 冲突。
- [x] 状态与降级：独立输出 `success | partial | insufficient_data`、稳定 diagnostics 和 conflicts；先验证 chain 再调用高成本 trace/metadata，provider 局部失败不丢弃健康来源。
- [x] 可重放测试：两组 provider fixtures 和 31 个包级测试覆盖成功、冲突、错误链、transport、timeout、abort、响应超限、trace 资源、factory spoof、fee/protocol/pool 配额和 enrichment core 直连。
- [x] 运行面隔离：没有真实 endpoint、环境变量 loader、生产 composition root、Capability/MCP/Agent/API/CLI/Telegram 引用。
- [ ] 生产数据面：共享 QPS/并发预算、熔断、缓存、成本计量、metrics、告警、持久化审计和真实 provider 配置；需要后续独立安全目标。

成功标准：任意 RPC/debug/eth_call 无法越过专用 schema；错误链不触发 trace 或 metadata 请求；伪造 getter 不能绕过 factory 反查；等价 provider 不产生伪冲突、差异来源显式降级；输出无需转换即可进入 enrichment core；完整 `pnpm check` 与公开客服边界回归通过。详细设计见 [evm-execution-data-adapter.md](evm-execution-data-adapter.md)。

## v0.11 Price Impact / Sandwich Detection Core（计划）

目标：先用离线、可重放的 block 邻近交易、pool state 和资产变化事实生成价格影响与 Sandwich 四态 verdict，不接入生产 provider 或用户运行面。

- [ ] 定义 block transaction neighborhood、pre/post pool state、token delta 与来源冲突契约。
- [ ] 对 allowlisted V2/V3 路径计算 lossless quote、execution price 和 price impact，不使用 LLM 猜价格。
- [ ] 定义 `confirmed | likely | unlikely | insufficient_data` Sandwich verdict、必要证据和反例。
- [ ] 处理 multi-hop、fee-on-transfer、rebase、聚合器和缺 archive state 的显式降级边界。
- [ ] 建立合成/真实脱敏 replay corpus、deterministic golden tests 和误报/漏报基线。
- [ ] 保持无网络、无 Capability/MCP/Agent 接线；生产数据面和授权另立目标。

## GitHub Planning Convention

- Roadmap 记录长期方向和阶段目标。
- Epic issue 记录一个大方向的目标、范围和任务列表。
- 普通 issue 记录可以由一个 PR 完成的具体任务。
- 每个 PR 应尽量关联一个具体 issue；大功能通过 Epic issue 追踪整体进度。
