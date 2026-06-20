# LangGraph Agentic RAG Design

## Goal

把当前 XXYY 客服系统收敛为 **LangGraph 驱动的 Agentic RAG 系统**。第一阶段只实现最小可用的自主规划客服 Agent，不建设重型运营平台。

系统需要支持：

1. 自主根据官方 X / Twitter 和产品文档更新知识库。
2. 自动回复用户的 XXYY 产品问题，并基于检索引用回答。
3. 对特定问题自主规划并调用工具，例如交易哈希夹子查询。
4. 保留 MCP 和 Skill 作为外部 Agent 调用 XXYY 能力的入口。
5. 为未来交易池子查询、链上交易分析、多工具证据收集预留扩展路径。

最终定位是 **XXYY Customer Support Agentic RAG**。第一阶段使用 LangGraph JS 作为 Agent Runtime / orchestration layer，但不把业务能力写死在 LangGraph 节点里。

## Design Principles

- **LangGraph 负责自主规划和状态编排**：用户请求进入 LangGraph graph，由 planner 决定需要调用哪些工具、是否继续收集证据、何时生成最终回答。
- **Capability Core 负责业务能力**：产品 RAG、交易分析、未来池子查询和链上分析都做成独立 TypeScript capability，可被 LangGraph、API、CLI 和 MCP 复用。
- **Tool 是内部调度契约**：每个 capability 包装成内部 tool，提供 name、description、input schema、output schema、permissions 和 invoke。
- **MCP 是外部接入层**：MCP server 包装同一份 capability / tool，供外部 Agent 使用；内部 Runtime 不必须通过 MCP 协议调用本机能力。
- **Skills 是外部 Agent 使用说明**：Skill 描述何时调用产品问答、交易分析、未来池子查询，以及安全边界。
- **边界策略前置**：账户余额、订单、钱包、私有交易记录、投资建议等请求必须被 policy guard 拦截或转成固定边界回复。
- **先做最小 Agentic Core**：不做 ops、knowledge-ops、多轮长期记忆、反馈闭环和完整 eval gate。

## Target Architecture

```text
Knowledge Sync Plane
  -> fetch official X updates and product docs
  -> normalize and dedupe
  -> chunk
  -> embed
  -> upsert pgvector

Agent Runtime Plane
  -> API / Web / CLI request
  -> LangGraph StateGraph
      -> policy_guard
      -> planner
      -> tool_executor
      -> evidence_collector
      -> should_continue
      -> answer_composer
  -> ChatResponse

Capability Core
  -> product_rag
  -> tx_analysis
  -> future_pool_query
  -> future_onchain_analysis

External Tool Plane
  -> product-qa MCP
  -> tx-analysis MCP
  -> future pool-query MCP
  -> future onchain-analysis MCP
  -> Skills
```

第一阶段 LangGraph 主图：

```text
START
  -> policy_guard
  -> planner
  -> tool_executor
  -> evidence_collector
  -> should_continue?
      -> planner
      -> answer_composer
  -> END
```

`planner` 是自主规划节点，由 LLM 基于系统指令、当前状态、可用工具和安全策略决定下一步动作。为了控制风险，第一阶段限制最大 step 数、工具白名单、工具输入 schema、超时和错误归一化。

## Agent State

LangGraph state 至少包含：

- `messages`：当前用户请求和必要上下文。
- `policyDecision`：边界策略判断结果。
- `plan`：planner 产生的下一步动作或最终回答意图。
- `toolCalls`：已请求的工具调用。
- `toolResults`：工具执行结果。
- `evidence`：可用于回答的 RAG citations、交易分析证据、截图和报告 artifact。
- `route`：`product_answer`、`transaction_analysis`、`boundary`、`clarify`、`unsupported` 等内部路线。
- `errors`：归一化错误，不包含密钥或用户私有身份。
- `finalResponse`：符合 shared 聊天契约的回答。

第一阶段不做长期 memory，不保存 session summary。短期 state 只存在于一次 graph run 内，除非 API/Web 已经有明确的请求级 session 需求。

## Tool Contract

内部 tool 统一形态：

```ts
type XxyyAgentTool<Input, Output> = {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  permissions: string[];
  invoke(input: Input, context: ToolContext): Promise<Output>;
};
```

第一阶段工具：

- `product_rag_answer`：检索产品知识库并生成带 citations 的 grounded answer。
- `tx_analysis`：根据交易哈希或 explorer 链接做夹子查询，返回 verdict、evidence、related transactions、截图和可复查 artifact。
- `boundary_reply`：对私有账户数据、订单、余额、投资建议等请求生成固定边界回复。
- `clarify_request`：当问题缺少必要参数时生成澄清问题，例如交易链和哈希冲突。

未来工具：

- `pool_query`：查询交易池子、池子页面、池子成交窗口。
- `onchain_analysis`：对更复杂链上问题做多步证据分析。

MCP server 复用同一份 capability 或 tool definition，但 MCP 不作为内部业务逻辑的唯一入口。

## Keep

保留以下能力和模块：

- LangGraph JS Agent Runtime：自主规划、工具调用循环、状态管理、streaming 事件桥接。
- 产品问答 RAG：Markdown 知识库、官方 X 更新、embedding、pgvector 检索和 LLM grounded answer。
- X 自动同步：增量抓取、去重、chunk、embedding、upsert 到 pgvector。
- 交易哈希夹子查询：交易哈希 / explorer 链接识别、链路判断、browser provider、规则化 sandwich 分析、截图和可复查结果 artifact。
- Capability Core：产品 RAG、交易分析、未来池子查询和链上分析的独立业务模块。
- MCP 入口：产品问答 MCP 和交易分析 MCP 保留，供外部 Agent 或内部工具调用。
- Skills：保留产品问答和交易分析 Skill，指导外部 Agent 安全调用 MCP。
- 基础 API / Web / CLI：保留用户入口和本地调试入口。
- 基础健康检查：保留 `GET /health`，可选保留 `GET /health/deep` 作为 readiness check。

## Remove

删除或停用以下重型能力：

- 知识运营闭环：Telegram 客服学习、候选知识、审核、发布、gate、eval-only 候选。
- Ops 后台：`/ops` 页面、`/api/ops/summary`、`API_OPS_TOKEN`、质量缺口、成本统计、session 观测、alerts、candidate backlog。
- 长期多轮会话：session turn、session summary、省略指代、用户偏好记忆。
- 反馈闭环：反馈统计、负反馈生成知识候选、反馈运营面板。
- 完整 eval / gate 流水线：全量 LLM eval、targeted eval gate、approved-only candidate gate。
- 交易报告客服处理流：claim、close、reopen、assignee、review notes、复杂报告筛选和批量处理。
- 重型知识运营 Skill：不保留 `xxyy-knowledge-ops`。

## Module Boundary

保留或演进模块：

- `packages/shared`
- `packages/knowledge`
- `packages/rag-core`
- `packages/agent-core`：演进为 LangGraph Agent Runtime、tool contract、tool registry、policy guard 和 answer normalizer。
- `packages/product-qa-mcp`
- `packages/tx-analysis-mcp`
- `apps/api`
- `apps/web`
- `apps/cli`
- `skills/xxyy-product-support`
- `skills/xxyy-transaction-analysis`

删除或拆除模块：

- `packages/knowledge-ops`
- `packages/knowledge-ops-mcp`
- `skills/xxyy-knowledge-ops`

重命名或替换：

- `skills/xxyy-autonomous-answering-agent` 可删除，或改成更准确的 `skills/xxyy-customer-agent`，描述 LangGraph Agent 的工具边界和安全策略。

## Public Commands

保留或精简后的命令：

- `pnpm start`
- `pnpm start:service`
- `pnpm sync`
- `pnpm x:scrape`
- `pnpm rag:ingest`
- `pnpm rag:sync:x`
- `pnpm rag:stats`
- `pnpm rag:ask`
- `pnpm product:mcp`
- `pnpm tx:mcp`
- `pnpm check`

新增或替换：

- `pnpm agent:smoke`：检查 `/health`、一次产品问答、一次边界回复、一次交易哈希工具路由和 LangGraph step trace 摘要。

删除或停用命令：

- `pnpm knowledge-ops:mcp`
- `pnpm rag:sync:telegram`
- `pnpm rag:publish:knowledge`
- `pnpm rag:gate:knowledge`
- `pnpm rag:feedback`
- `pnpm rag:evaluate`
- `pnpm ops:check`
- `pnpm ops:check:rag`
- `pnpm ops:check:full`
- `pnpm ops:refresh`
- `pnpm ops:smoke`

## API Surface

保留：

- `GET /health`
- `GET /health/deep`，可选
- `POST /api/chat`
- `POST /api/chat/stream`，如果 Web 仍需要流式输出
- `POST /api/tx-analysis`，作为交易分析 direct API
- 静态资产访问，用于交易分析截图和结果 artifact

删除：

- `/ops`
- `/api/ops/summary`
- `/api/feedback`
- 知识候选审核 API
- 交易分析报告 review / batch review API
- 复杂报告列表、摘要和处理状态 API

`POST /api/chat` 是主要 Agentic RAG 入口，会执行 LangGraph。`POST /api/tx-analysis` 是专用 direct API，复用 `tx_analysis` capability，不经过完整 planner。

## Model And Provider Strategy

LangGraph 作为 orchestration runtime，不把系统绑定到单一模型供应商。第一阶段继续使用项目已有 OpenAI-compatible chat completion 和 embedding 配置。

约束：

- planner 模型必须支持稳定 tool calling / structured output。
- product RAG answer 模型必须能遵守 citations 和边界回复要求。
- embedding 仍走 OpenAI-compatible `/embeddings`。
- 所有模型配置通过 env 注入，不在代码或测试中写真实 key。

预留配置：

```bash
AGENT_MODEL=
AGENT_BASE_URL=
AGENT_API_KEY=
OPENAI_MODEL=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

如果当前实现仍复用 `OPENAI_*`，先不要新增重复变量；等 LangGraph planner 和 RAG answer 需要分模型时再拆。

## Error Handling

产品问答错误需要清晰区分：

- embedding 配置缺失
- chat LLM / planner 配置缺失
- vector store 配置缺失
- vector store 运行时不可用
- 没有可引用知识

交易分析错误需要面向用户保持稳定分类：

- 未启用真实数据源
- 交易引用无效
- 暂不支持链
- 公开数据源临时不可用
- 交易未找到
- 交易执行失败或未完成
- 截图或 XXYY 池子页不可复查

LangGraph 执行错误需要归一化：

- planner 返回不可解析计划
- planner 请求未授权工具
- 工具输入 schema 校验失败
- 工具超时
- 达到最大 step 数

错误不写入 ops 质量队列，只在 API 响应、服务日志和可选 agent smoke 输出中保留必要上下文。

## Testing

保留 focused tests：

- LangGraph graph happy path：产品问题调用 `product_rag_answer` 并生成 citations。
- LangGraph graph tool path：交易哈希调用 `tx_analysis`。
- LangGraph guardrail path：账户余额、订单、投资建议不调用工具并返回边界回复。
- LangGraph safety path：planner 请求未授权工具、无效输入或超过 step limit 时可控失败。
- X 更新同步去重和增量入库。
- 产品 RAG 检索、引用和边界回复。
- 交易哈希 / explorer 链接识别和链冲突处理。
- 交易分析 provider 的成功、失败、未配置和暂不支持链路径。
- MCP 工具 schema 和基础调用。
- `pnpm check` 作为主要回归入口。

删除或重写 tests：

- knowledge ops candidate / review / gate 测试。
- Telegram sync 测试。
- session summary / multi-turn memory 测试。
- feedback candidate generation 测试。
- ops summary、alerts、tool audit、cost budget 测试。
- full eval gate 测试。

## Migration Strategy

裁剪和演进顺序：

1. 更新文档和 package scripts，让项目目标变成 LangGraph Agentic RAG。
2. 删除 knowledge ops、ops、feedback、长期 session、eval gate 入口及其测试。
3. 抽出 capability core：产品 RAG 和交易分析先成为 LangGraph tool 可调用的稳定模块。
4. 在 `packages/agent-core` 引入 LangGraph StateGraph，先实现 policy guard、planner、tool executor、answer composer。
5. 保留并验证产品 RAG、X sync、交易分析 API、产品问答 MCP、交易分析 MCP 和两个 Skills。
6. 增加 `agent:smoke`，固定产品问答、边界回复和交易哈希工具路由。
7. 跑 `pnpm check`。

## Non-goals

- 不查询用户账户、订单、余额、钱包或私有交易记录。
- 不提供投资建议。
- 不做 Telegram 客服消息自动学习。
- 不做后台候选审核和知识发布工作台。
- 不做长期多轮记忆和用户偏好存储。
- 不做 ops 运维后台。
- 不做完整运营级 eval / gate 平台。
