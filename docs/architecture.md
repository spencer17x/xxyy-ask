# Architecture

本文档描述当前 XXYY Ask 的业务架构。当前实现聚焦产品客服 RAG：基于产品文档和官方 X 更新回答产品问题；账户、订单、私有交易记录、交易哈希、池子查询、泛 MEV/链上取证和投资建议等问题走边界或澄清回复。

## 当前业务架构

```mermaid
flowchart LR
  subgraph Entrances["用户入口"]
    Web["Web 聊天页"]
    Cli["CLI 提问"]
    Telegram["Telegram Bot"]
  end

  subgraph Api["API 服务"]
    ChatApi["/api/chat"]
    StreamApi["/api/chat/stream"]
    HealthApi["/health / /health/deep"]
    Assets["/assets/*"]
  end

  subgraph Agent["LangGraph CustomerAgentRuntime"]
    Policy["策略边界"]
    Intent["确定性产品意图路由"]
    Planner["路由 / 缺失证据 Query Planner"]
    Search["search_product_docs"]
    Observe["Evidence Observation"]
    Composer["answer_composer"]
    Boundary["边界 / 澄清回复"]
  end

  subgraph Rag["Product RAG"]
    Retriever["pgvector 向量 / 关键词 / 实体候选"]
    Reranker["RRF + 通用元数据 / 时效重排"]
    Safety["知识注入隔离 + Chunk-aware Packing"]
    Llm["OpenAI-compatible LLM"]
    Grounding["关键 Claim Grounding"]
    Citations["支持性引用选择"]
    Fallback["Grounded Answer 降级"]
    Response["回答 + 引用 + 产品附件"]
  end

  subgraph Knowledge["知识库与同步"]
    ProductDocs["产品文档 Markdown"]
    XUpdates["官方 X 更新"]
    Ingest["rag:ingest 全量入库"]
    SyncX["x:scrape + rag:sync:x 增量同步"]
    PgVector["Postgres + pgvector"]
  end

  Web --> ChatApi
  Web --> StreamApi
  Cli --> ChatApi
  Telegram --> ChatApi

  ChatApi --> Policy
  StreamApi --> Policy
  Policy --> Intent
  Intent -->|product_qa / how_to，原问题快路径| Search
  Intent -->|无法确定| Planner
  Planner --> Search
  Planner --> Boundary
  Search --> Retriever
  Retriever --> PgVector
  Retriever --> Reranker
  Reranker --> Observe
  Observe -->|证据充分| Composer
  Observe -->|缺少维度且仍有预算| Planner
  Observe -.->|重复 query / 无新增证据 / 达到上限| Boundary
  Composer --> Safety
  Safety --> Llm
  Llm --> Grounding
  Grounding -->|通过| Citations
  Citations --> Response
  Grounding -.->|关键 claim 无证据| Fallback
  Llm -.->|超时 / 限流 / 不可用| Fallback
  Fallback --> Response
  Boundary --> Response
  Response --> ChatApi
  Response --> StreamApi
  Assets --> Web

  ProductDocs --> Ingest
  XUpdates --> Ingest
  XUpdates --> SyncX
  Ingest --> PgVector
  SyncX --> PgVector
```

## 说明

- `CustomerAgentRuntime` 是当前问答编排核心：先做策略边界；确定识别为 `product_qa` / `how_to` 的普通问题直接用完整原问题执行一次 `search_product_docs`，不增加 Planner 调用。模糊路由和证据不充分的复杂问题才调用 Planner。
- 产品运行面只注册检索工具。`search_product_docs` 负责检索、重排和返回安全 chunks；`observe` 按比较维度、引用和新增 chunk 判断证据是否充分；`answer_composer` 聚合去重后的 chunks 并调用 AnswerProvider，不再由一个工具同时检索和回答。
- 首次检索 query 固定为完整原问题。只有 observation 给出缺失维度后，Planner 才能改写后续 query；改写必须命中缺失维度、保持原问题范围以及时间/版本限定。原问题始终独立保留给引用选择和最终回答。
- loop 同时受 max steps、重复工具输入和无新增证据保护。不同 query 若返回同一批 chunk/引用，也会停止；已有部分证据时返回带引用的“不足以完整回答”，没有证据时返回澄清或知识不足，而不是继续循环。
- 产品问答和操作步骤会检索 `Postgres + pgvector`，再调用 OpenAI-compatible chat completion 生成回答。
- 正式检索将向量、全文关键词和实体候选按 rank 融合，再应用标题/模块覆盖、直接来源、时效与冲突元数据做通用重排；不依赖具体产品 case 的固定查询扩展。
- 检索结果不会原样进入模型：正文、标题、模块和章节先执行敏感信息脱敏与确定性 prompt injection 检测；角色覆盖、忽略规则、提示词泄露和伪造工具调用片段会被替换为隔离标记。正文随后用 JSON 字符串承载，避免知识文本突破资料边界。
- 上下文打包在总预算内为多个 chunk 公平保留空间，再按问题词、数字、完整句子、列表和限制/条件信号选择内容。只有无法继续拆分的单个内容单元才允许带省略号截短，并记录 included/omitted/quarantined/truncated 统计。
- 模型回答完成后执行本地 claim grounding，不增加第二次模型调用。每个关键陈述都要与安全知识片段在数字、支持/不支持极性和有效词项上对齐；失败时返回 deterministic grounded answer。成功时引用只从实际支撑 claim 的 chunk 生成，并用问题和回答选择相关 excerpt。
- 为避免流式 token 发出后无法撤回，answer provider 会先缓冲模型流、完成同一 grounding 校验，再发送原始有效 deltas 或安全降级回答。`status` 事件和公开 `ChatStreamEvent`/`ChatResponse` 契约保持不变；代价是 answer delta 的首包会晚于模型完成，但校验是本地线性计算，不引入额外网络往返。
- 当前只注册 `search_product_docs` 业务工具；交易分析、池子查询、链上取证和 MCP adapter 暂不接入运行面。
- LLM 超时、限流、模型路由不可用、非 JSON、不可用答案或 claim grounding 失败时，会降级为本地 grounded answer；embedding 对超时、429 和 5xx 做有界重试。
- 知识库按来源分为 `official_docs`（仅 `docs.xxyy.io`）、`x_updates`（仅 `x.com/useXXYYio`）和 `admin_verified`（客服群审核知识，当前为空）；支持全量入库和 X 增量同步。
- 图片 OCR、视频解析和官方 X 媒体会把原始媒体地址写入 chunk 元数据；被选为回答依据的 chunk 可同时返回相关截图、本地 MP4 或外部视频链接。
- Web UI 支持流式回答、引用展示、产品知识库附件和基础聊天体验。
- 当前目标不包含用户侧人工接管或业务动作执行；无法自动回答的问题应返回清晰边界或澄清问题。
