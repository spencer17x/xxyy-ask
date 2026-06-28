# Roadmap

本文档记录 LangGraph Agentic RAG 迁移后的工程方向。当前功能状态见 [feature-status.md](feature-status.md)。

## Completed First Slice

- [x] LangGraph 客服 Runtime：`CustomerAgentRuntime` 已迁移到 LangGraph JS，统一处理产品问答、交易分析、边界回复、工具降级和最终回答合成。
- [x] Product RAG：产品问题基于 Postgres + pgvector 检索产品文档和官方 X / Twitter 更新，再调用 OpenAI-compatible chat completion 生成带引用回答。
- [x] 官方 X / Twitter 同步：`pnpm run app:dev -- --sync` 做增量抓取和入库后启动服务，`pnpm run app:dev -- --full-sync` 做低频全量重建后启动服务。
- [x] 交易哈希工具路线：公开交易哈希或受支持 explorer 链接可以通过聊天入口或 `POST /api/tx-analysis` 进入交易分析工具。
- [x] MCP 第一片：产品问答 MCP 和交易分析 MCP 已复用同一套 agent-core 工具定义。
- [x] 服务基础面：Web UI、health/deep health、chat/stream、direct transaction analysis、static assets、请求体限制、基础限流和 CORS 配置已保留。

## Planned Work

- [ ] 池子查询工具：设计公开池子查询 tool schema、权限边界、回答格式和 MCP 复用方式，并接入 LangGraph planner。
- [ ] 链上分析工具：在单笔交易哈希分析之外，扩展公开链上分析能力；保持不查询用户私有账户或订单数据。
- [ ] 交易分析真实样本扩展：继续补 Solana、Base、Ethereum、BSC 样本，覆盖更多 explorer 页面结构、备用浏览器、XXYY 池子搜索和截图场景。
- [ ] Product RAG 质量增强：补充产品文档结构、X / Twitter 更新清洗、引用稳定性和回归样本。
- [ ] Agent planning 增强：让 planner 在产品问答、交易分析、未来池子查询和链上分析之间做更稳的工具选择，并保留清晰边界回复。
- [ ] MCP 使用文档：补外部 Agent 如何调用 `product:mcp:dev` 与 `tx:mcp:dev` 的示例、错误处理和边界说明。
- [ ] 部署验收增强：围绕 `pnpm agent:smoke` 增加更多产品问题、边界问题、流式回答和交易分析路线样本。
- [ ] 多渠道接入：复用同一个客服 Agent runtime，接入更多客服入口，同时保持隐私边界和日志脱敏。
- [ ] 安全与隐私增强：完善 prompt injection 防护、敏感信息脱敏、数据保留和删除策略。
