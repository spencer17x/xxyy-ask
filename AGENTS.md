# AGENTS.md

## 项目目标

XXYY Ask 是一个用于面试展示的 AI Agent 项目。目标不是一次性堆出完整系统，而是一步步构建一个能讲清楚的 AI 应用：Agent 工作流、工具调用、RAG、评测、可观测性、Web 客服页和 Telegram bot。

## 协作规则

- 每次只实现一个小能力，不一次性生成大量代码。
- 写代码前，先用中文解释概念、设计和取舍。
- 非平凡改动需要先给出小方案，等用户确认后再写代码。
- 优先小提交，每个提交只表达一个清楚的面试知识点。
- 每完成一步，都补充“面试时怎么讲”。
- 代码要服务于学习和展示，不为了炫技增加复杂度。

## 技术栈

- Web：Next.js、TypeScript、Vercel AI SDK
- Agent API：FastAPI、Python
- Agent 编排：LangGraph
- RAG 组件：按需使用 LangChain
- 数据库：Supabase Postgres、pgvector
- 模型调用：OpenAI SDK、Responses API
- 可观测性：LangSmith 或等价 tracing
- Bot：Telegram

## 开发顺序

1. 最小 Agent API
2. 工具调用
3. 文档抓取与清洗
4. Embedding 与 pgvector 检索
5. LangGraph 工作流
6. 引用校验与拒答策略
7. 评测与 tracing
8. Web 客服页
9. Telegram bot

## 面试展示重点

- 能解释什么是 Agent，以及它和普通 Chatbot 的区别。
- 能解释为什么需要 tool calling，而不是只靠 prompt。
- 能解释 RAG 的完整链路：ingestion、chunking、embedding、retrieval、generation、citation。
- 能解释为什么用 LangGraph 管理多步骤状态。
- 能展示如何评估答案质量、检索质量、延迟和成本。
- 能说明每个技术选择的取舍，而不是只报技术名。

