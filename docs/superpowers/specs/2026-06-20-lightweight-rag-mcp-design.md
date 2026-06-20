# Lightweight RAG + MCP Design

## Goal

把当前 XXYY 客服系统从完整 Agentic RAG 平台收缩为轻量系统，只服务两个核心能力：

1. 自主根据官方 X / Twitter 更新产品知识库。
2. 支持交易哈希夹子查询，并保留 MCP 和 Skill 作为外部 Agent 调用入口。

最终定位是 **MCP-enabled Product RAG + Transaction Analysis**，不是完整 Agentic RAG 平台。

## Keep

保留以下能力和模块：

- 产品问答 RAG：Markdown 知识库、官方 X 更新、embedding、pgvector 检索和 LLM grounded answer。
- X 自动同步：增量抓取、去重、chunk、embedding、upsert 到 pgvector。
- 交易哈希夹子查询：交易哈希 / explorer 链接识别、链路判断、browser provider、规则化 sandwich 分析、截图和可复查结果 artifact。
- 轻量 router：产品问题走 RAG，交易哈希走交易分析，私有数据和投资建议走固定边界回复。
- MCP 入口：产品问答 MCP 和交易分析 MCP 保留，供外部 Agent 或内部工具调用。
- Skills：保留产品问答和交易分析 Skill，指导外部 Agent 安全调用 MCP。
- 基础 API / Web / CLI：保留用户入口和本地调试入口。
- 基础健康检查：保留 `GET /health`，可选保留 `GET /health/deep` 作为 readiness check。

## Remove

删除或停用以下重型能力：

- 知识运营闭环：Telegram 客服学习、候选知识、审核、发布、gate、eval-only 候选。
- Ops 后台：`/ops` 页面、`/api/ops/summary`、`API_OPS_TOKEN`、质量缺口、成本统计、session 观测、alerts、candidate backlog。
- 多轮会话：session turn、session summary、省略指代、用户偏好记忆。
- 反馈闭环：反馈统计、负反馈生成知识候选、反馈运营面板。
- 完整 eval / gate 流水线：全量 LLM eval、targeted eval gate、approved-only candidate gate。
- 交易报告客服处理流：claim、close、reopen、assignee、review notes、复杂报告筛选和批量处理。
- 重型 autonomous answering skill：不再保留完整自动客服 Agent 的 Skill。

## Target Architecture

```text
Scheduled sync
  -> fetch official X updates
  -> normalize and dedupe
  -> chunk
  -> embed
  -> upsert pgvector

User / API / MCP request
  -> lightweight router
    -> product question: retrieve + answer with citations
    -> transaction hash/link: transaction analysis tool
    -> private account/order/balance/investment request: boundary response
```

`packages/agent-core` 可以保留，但职责收缩为 tool registry 和确定性 router，不再承担多轮记忆、质量信号、工具审计、候选知识或 autonomous planning。

## Module Boundary

保留模块：

- `packages/shared`
- `packages/knowledge`
- `packages/rag-core`
- `packages/agent-core`，但只保留轻量 router 和工具契约
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
- `skills/xxyy-autonomous-answering-agent`

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

如果仍需要发布前验证，把 `ops:smoke` 替换为更小的 API smoke：检查 `/health`、一次产品问答、一次边界回复、一次交易哈希路由。

## API Surface

保留：

- `GET /health`
- `GET /health/deep`，可选
- `POST /api/chat`
- `POST /api/chat/stream`，如果 Web 仍需要流式输出
- `POST /api/tx-analysis`
- 静态资产访问，用于交易分析截图和结果 artifact

删除：

- `/ops`
- `/api/ops/summary`
- `/api/feedback`
- 知识候选审核 API
- 交易分析报告 review / batch review API
- 复杂报告列表、摘要和处理状态 API

## Error Handling

产品问答错误需要清晰区分：

- embedding 配置缺失
- chat LLM 配置缺失
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

错误不再写入 ops 质量队列，只在 API 响应和服务日志中保留必要上下文。

## Testing

保留 focused tests：

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

裁剪顺序：

1. 更新文档和 package scripts，先让项目目标与命令表收敛。
2. 删除 knowledge ops、ops、feedback、session、eval gate 入口及其测试。
3. 收缩 `agent-core`，保留 deterministic router 和 tool registry。
4. 保留并验证产品 RAG、X sync、交易分析 API、产品问答 MCP、交易分析 MCP 和两个 Skills。
5. 跑 `pnpm check`，再补一个轻量 API smoke 脚本作为上线前验证。

## Non-goals

- 不做用户账户、订单、余额、钱包或私有交易记录查询。
- 不做投资建议。
- 不做 Telegram 客服消息自动学习。
- 不做后台候选审核和知识发布工作台。
- 不做多轮长期记忆和用户偏好存储。
- 不做完整 autonomous agent planning。
