# Architecture

本文档描述当前 XXYY Ask 的业务架构。当前实现聚焦产品客服 RAG：基于产品文档和官方 X 更新回答产品问题；账户、订单、私有交易记录、泛 MEV/链上取证和投资建议等问题仍走边界回复。交易哈希夹子检测已有专用 MVP 路由，默认未接数据源时返回“暂未启用”，显式配置 mock provider 时只返回 fixture 演示结果，配置 browser provider 时会用本机 Chrome 查询公开交易浏览器和 XXYY 原池子页；当前支持 Solana，并已接入 Base、Ethereum、BSC 浏览器取证初版。

## 当前业务架构

```mermaid
flowchart LR
  subgraph Entrances["用户入口"]
    Web["Web 聊天页"]
    Cli["CLI 提问"]
    FutureChannels["未来渠道<br/>Telegram / 站内入口"]
  end

  subgraph Api["API 服务"]
    ChatApi["/api/chat"]
    StreamApi["/api/chat/stream"]
    FeedbackApi["/api/feedback"]
    HealthApi["/health / /health/deep / /ops"]
  end

  subgraph Chat["ChatService"]
    Classifier["意图分类"]
    ProductRoute["产品问答 / 操作步骤"]
    TxRoute["交易哈希检测 MVP"]
    BoundaryRoute["边界问题直接回复"]
  end

  subgraph Rag["RAG 回答"]
    Retriever["pgvector 检索"]
    Llm["OpenAI-compatible LLM"]
    Fallback["Grounded Answer 降级"]
    Response["回答 + 引用 + 附件"]
  end

  subgraph TxAnalysis["交易分析 MVP"]
    HashParser["交易哈希解析"]
    TxProvider["TxAnalysisProvider"]
    MockFixture["Mock Fixture 结果"]
    BrowserProvider["Browser Provider"]
    Solscan["Solscan 交易页"]
    XxyyDiscover["XXYY Discover"]
    ImageAttachment["图片附件"]
    TxReports["交易分析报告<br/>文件 / Postgres"]
  end

  subgraph Knowledge["知识库与同步"]
    ProductDocs["产品文档 Markdown"]
    XUpdates["官方 X 更新"]
    Ingest["rag:ingest 全量入库"]
    SyncX["x:scrape + rag:sync:x 增量同步"]
    PgVector["Postgres + pgvector"]
  end

  subgraph Ops["反馈与运维"]
    UserFeedback["用户正负反馈"]
    FeedbackStore["rag_feedback"]
    DeepHealth["Deep Health"]
    OpsSummary["Ops Summary"]
    Evaluation["RAG 评测"]
  end

  subgraph Planned["未完成能力"]
    MultiTurn["多轮对话"]
    TxHash["真实链上夹子检测"]
    Screenshot["真实截图生成"]
    Tickets["工单与人工接管"]
    Channels["多渠道接入"]
  end

  Web --> ChatApi
  Web --> StreamApi
  Cli --> ChatApi
  FutureChannels -.-> ChatApi

  ChatApi --> Classifier
  StreamApi --> Classifier
  Classifier --> ProductRoute
  Classifier --> TxRoute
  Classifier --> BoundaryRoute

  ProductRoute --> Retriever
  Retriever --> PgVector
  Retriever --> Llm
  Llm --> Response
  Llm -.->|超时 / 限流 / 不可用| Fallback
  Fallback --> Response
  BoundaryRoute --> Response
  TxRoute --> HashParser
  HashParser --> TxProvider
  TxProvider --> MockFixture
  TxProvider --> BrowserProvider
  BrowserProvider --> Solscan
  BrowserProvider --> XxyyDiscover
  BrowserProvider --> TxReports
  MockFixture --> ImageAttachment
  XxyyDiscover --> ImageAttachment
  ImageAttachment --> Response
  Response --> ChatApi
  Response --> StreamApi
  ChatApi --> Web
  StreamApi --> Web

  ProductDocs --> Ingest
  XUpdates --> Ingest
  XUpdates --> SyncX
  Ingest --> PgVector
  SyncX --> PgVector

  Web --> FeedbackApi
  FeedbackApi --> UserFeedback
  UserFeedback --> FeedbackStore
  FeedbackStore --> OpsSummary
  TxReports --> OpsSummary
  HealthApi --> DeepHealth
  DeepHealth --> OpsSummary
  PgVector --> OpsSummary
  PgVector --> Evaluation
  FeedbackStore -.->|补知识库 / 扩评测| ProductDocs

  Planned -.->|后续路线| Chat
```

## 说明

- `ChatService` 是当前问答编排核心：先做规则意图分类，再决定进入 RAG 检索或返回边界回复。
- 产品问答和操作步骤会检索 `Postgres + pgvector`，再调用 OpenAI-compatible chat completion 生成回答。
- 交易哈希夹子检测已经有专用路由：解析交易哈希后调用 `TxAnalysisProvider`；默认无 provider 时不编造结论，`TX_ANALYSIS_PROVIDER=mock` 只返回 fixture 演示结果和截图，`TX_ANALYSIS_PROVIDER=browser` 使用本机 Chrome 查询公开交易浏览器页面和 XXYY 原池子页。当前 Solana 已能定位目标交易前后窗口，使用规则化 SandwichAnalyzer 输出同一交易者前后腿、时间窗口和覆盖度证据，返回带目标行标记的 XXYY 原表格截图；browser provider 已按链适配器路由，Base、Ethereum、BSC 已接入初版 EVM 浏览器取证链路。裸 EVM 哈希会按 Base、Ethereum、BSC 顺序探测公开交易浏览器，命中后继续分析；EVM 链路会优先按 explorer 解析到的池子地址直达 XXYY 原池子页，目标交易匹配失败时再回退合约搜索。browser provider 支持可插拔异步 reviewer；配置 `TX_ANALYSIS_REVIEWER=openai` 后会复用 OpenAI-compatible chat completion 对规则分析结果做模型复核，并可调整最终结论、置信度、摘要和证据；模型复核不可用时保留规则结果。交易分析报告默认写入本地 JSON/JSONL，也可通过 `TX_ANALYSIS_REPORT_STORE=postgres` 写入 `tx_analysis_reports` 表；运维接口和 `/ops` 页面会聚合报告，展示成功/失败数量、链分布、失败原因、处理状态分布、运行配置和最近报告，并可按处理状态或负责人过滤复查队列；文件和 Postgres 模式都支持通过受保护接口保存处理状态、备注和负责人。
- LLM 超时、限流、模型路由不可用或返回不可用答案时，会降级为本地 grounded answer。
- 知识库由产品文档和官方 X 更新组成，支持全量入库和 X 增量同步。
- Web UI 支持流式回答、引用展示、视频/图片附件和正负反馈。
- Base/Ethereum/BSC 更多真实样本稳定性验证、更完整的客服复查后台、工单、人工接管、多轮对话和多渠道接入目前仍是未完成能力。
