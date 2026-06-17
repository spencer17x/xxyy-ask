# Roadmap

本文档记录 XXYY 客服应用的后续工程方向。用户和运营可感知功能状态见 [feature-status.md](feature-status.md)。

## Planned Work

- [ ] Agent 化客服流程：支持澄清问题、自动分流、调用客服动作、创建工单和转人工。
- [ ] Telegram 知识学习闭环：在已完成的 `@xxyy/knowledge-ops` 授权采集、候选知识、持久化、采集运行入口、审核 API 和 approved-only 发布入口上，补自动 ingest/embedding、targeted eval gate、发布 run 关联和回滚线索。
- [ ] 交易分析多链稳定性：继续补 Base、Ethereum、BSC 真实样本，覆盖更多 explorer 页面结构、XXYY 搜索结果和池子交易窗口。
- [ ] 交易分析复查工作流：完善多成员分派策略、SLA、工单联动和可交互分析详情页。
- [ ] 工单与人工接管：无法直接解决的问题可以创建客服工单，复杂问题可以转人工继续处理。
- [ ] 多渠道接入：支持 Telegram、Discord、站内 widget、移动端等入口。
- [ ] 工具权限与审计：为客服动作、链上查询和后台操作增加权限控制与审计日志。
- [ ] 安全与隐私增强：完善敏感信息脱敏、prompt injection 防护、数据保留和删除策略。
- [ ] 质量与成本观测：记录检索命中、模型耗时、token 成本、降级原因、用户反馈和质量趋势。
