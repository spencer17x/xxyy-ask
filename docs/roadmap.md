# Roadmap

本文档记录当前工程方向。当前功能状态见 [feature-status.md](feature-status.md)。

## Completed First Slice

- [x] LangGraph 客服 Runtime：`CustomerAgentRuntime` 已迁移到 LangGraph JS，统一处理产品问答、边界回复、工具降级和最终回答合成。
- [x] Product RAG：产品问题基于 Postgres + pgvector 检索产品文档和官方 X / Twitter 更新，再调用 OpenAI-compatible chat completion 生成带引用回答。
- [x] 官方 X / Twitter 同步：`pnpm run app:dev -- --sync` 做增量抓取和入库后启动服务，`pnpm run app:dev -- --full-sync` 做低频全量重建后启动服务。
- [x] 服务基础面：Web UI、health/deep health、chat/stream、static assets、请求体限制、基础限流和 CORS 配置已保留。
- [x] Telegram Bot：long polling 入口复用同一套客服 Agent runtime。

## Paused

- [ ] MCP 和 project skills：当前阶段先移除，不作为对外或本地调用入口。
- [ ] 交易分析、池子查询和链上取证：当前客服入口只做知识库产品回答，相关问题进入边界/澄清回复。

## Planned Work

- [ ] Product RAG 质量增强：补充产品文档结构、X / Twitter 更新清洗、引用稳定性和回归样本。
- [ ] Agent planning 增强：让 planner 对产品问答、边界问题和澄清问题保持更稳定的选择。
- [ ] 部署验收增强：围绕 `pnpm agent:smoke` 增加更多产品问题、边界问题和流式回答样本。
- [ ] 多渠道接入：复用同一个客服 Agent runtime，接入更多客服入口，同时保持隐私边界和日志脱敏。
- [ ] 安全与隐私增强：完善 prompt injection 防护、敏感信息脱敏、数据保留和删除策略。
