# Chain Analysis Production Environment & Governance Decision Gate

## 状态

本文档是 v0.14b2b1 / Goal 19 已确认的技术与治理决策记录，不是生产配置或生产批准 artifact。

```text
record_status: confirmed_decision
decision_confirmed_on: 2026-07-23
decision_confirmation_scope: technical_baseline_and_role_ownership
production_approval_status: unapproved
real_provider_configured: false
real_identity_grants_recorded: false
real_mainnet_evidence_recorded: false
readiness_status: not_evaluated
```

产品负责人已在项目任务中确认推荐技术基线、90 天保留期、身份来源和四类责任 owner。该确认只证明本记录中的架构与治理选择已经确定，不得转换为 source/legal approval、provider descriptor、authorization grant、operations evidence 或 readiness attestation。本文档不得包含 endpoint、credential、token、个人身份原文或未脱敏的审批材料。

## 为什么必须先过这个 Gate

仓库已经具备离线分析核心、受限 RPC adapters、sampling/review 治理、Postgres control store 和可重算 readiness evidence ledger，但当前 Docker Compose 只部署 Product RAG 的 pgvector、API/Web 与 Telegram。链上控制面目前没有：

- 生产 composition root 或独立进程；
- sampling、review、retention、reconciliation worker 调度；
- 真实 Provider endpoint/secret reference 配置；
- 受控人工账号和平台服务账号到八类 control-store role 的映射；
- 正式 source/legal/retention approval evidence；
- 真实主网 reviewed corpus、SLO、故障演练、安全或 runbook evidence。

因此不能直接复用 Product RAG 的 `.env` 或 Docker Compose 并宣称链上能力已部署，也不能用 contract-only fixture 填补这些空缺。

## 已确认决策快照

以下快照是本 Goal 的唯一决策基线。`confirmation_evidence` 指向本项目任务中的用户确认；仓库不复制会话身份、个人信息或凭据。字段值是治理输入，不是可以绕过 canonical validators 的运行时配置。

```yaml
decision_id: goal-19-v0.14b2b1
decision_confirmed_on: 2026-07-23
confirmation_evidence: project_task_user_confirmation
technical_baseline_decision: approve_recommended

target_chain_ids: ['1']
expansion_policy: one_chain_must_reach_ready_before_adding_another
initial_capability_scope: full_chain_analysis
required_adapters: [execution, mev_observation, snapshot]
protocols: [uniswap_v2, uniswap_v3]
independent_provider_vendors_per_adapter_chain: 2
mev_observation_archive_required: true
deployment_boundary: dedicated_private_control_plane
database_boundary: dedicated_database
selected_source_kinds: [public_rpc, official_explorer_export]
retention_days: 90
identity_source: [platform_service_accounts, controlled_human_accounts]
governance_mode: single_owner
human_owner_count: 1
required_human_reviews_per_candidate: 1
automated_authority_verification_required: true
governance_owner: product_owner
provider_operations_owner: platform_operations
legal_and_retention_owner: product_owner
readiness_policy_owner: technical_owner
mandatory_drill_scope: all_eight_builtin_drills
readiness_acceptance: evaluator_status_must_equal_ready

production_approval_status: unapproved
source_legal_approval_evidence: pending
provider_contract_and_configuration: pending
authorization_grants: pending
operations_and_mainnet_evidence: pending
```

`owner` 是责任域，不代表不同的人。当前产品负责人、平台运维、法律与保留、技术负责人都由同一个真实 owner 承担。单 owner profile 将四个人工治理角色映射到这个稳定受控人工 principal，并将采集、Provider、保留等执行职责映射到不同 service-account principal；它不把同一人的多个账号描述为独立审批人。候选仍必须由服务账号提交、由 owner 复核，生产 plan 还必须经过确认窗口和自动 authority verifier。

## 已由代码固定的边界

这些项目不是本轮可自由选择的生产功能：

| 范围               | 已实现边界                                                                                                                                             | 状态             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 链类型             | 仅 EVM chain id；Solana 等非 EVM 链不在现有 pipeline 内                                                                                                | `fixed_by_code`  |
| 协议               | `uniswap_v2`、`uniswap_v3`                                                                                                                             | `fixed_by_code`  |
| Adapter            | `snapshot`、`execution`、`mev_observation`                                                                                                             | `fixed_by_code`  |
| 路由覆盖           | `direct_pool`、`allowlisted_router`、`complex_route`；复杂路由主要用于 unsupported/coverage，不代表已支持高置信分析                                    | `fixed_by_code`  |
| 样本来源类型       | `public_rpc`、`official_explorer_export`、`protocol_event_archive`                                                                                     | `fixed_by_code`  |
| 样本维度           | positive/negative/unsupported、complete/partial/unsupported、canonical/provider conflict/reorg、standard/fee-on-transfer/rebasing/unknown              | `fixed_by_code`  |
| 治理角色           | 一个 owner 承担 planner、publisher、reviewer、attestor；submitter、sampling/provider/retention worker 使用隔离 service account                         | `fixed_by_code`  |
| 故障演练类型       | audit、budget、circuit backend unavailable，malformed payload、provider conflict/rate limit/timeout、reorg                                             | `fixed_by_code`  |
| Readiness 质量门禁 | 固定 internal gate，至少 20 cases、10 reviewed cases，并包含 V2/V3、provider conflict、allowlisted router 覆盖及固定 precision/recall/determinism 阈值 | `fixed_by_code`  |
| 运行面             | 当前不得接入 Agent、Capability、MCP、API、CLI 或 Telegram                                                                                              | `fixed_by_scope` |

## 已确认的技术与治理决策

### DEC-01：首批目标链

状态：`confirmed_decision / production_activation_unapproved`

首批只选择 Ethereum 主网，并在真实采集、owner 复核和故障演练闭环后再扩链：

```text
target_chain_ids: ["1"]
expansion_policy: one_chain_must_reach_ready_before_adding_another
```

理由：现有 pipeline 的生产验证成本按 chain × adapter × provider 增长；先完成单链闭环更容易发现数据、运维和 reviewer 流程问题。该选择不授权连接真实主网 Provider，也不代表已有主网 evidence。

### DEC-02：分析和协议范围

状态：`confirmed_decision / production_activation_unapproved`

首批生产验证覆盖全部三个 adapter，但只对已有确定性语义输出结论：

```text
required_adapters: ["execution", "mev_observation", "snapshot"]
protocols: ["uniswap_v2", "uniswap_v3"]
high_confidence_scope:
  - direct_pool
  - allowlisted_router where existing semantic checks close
explicitly_unsupported:
  - complex multi-hop or aggregator semantics not closed by current cores
  - fee-on-transfer and rebasing token high-confidence verdicts
  - cross-tick V3 execution outside current supported semantics
```

`complex_route`、fee-on-transfer、rebasing 和超出当前语义闭包的 V3 execution 必须保持 unsupported/abstain，不能因为已确认 full-chain-analysis 范围而提升结论置信度。

### DEC-03：Provider 拓扑

状态：`confirmed_decision / provider_configuration_unapproved`

已确认：

```text
independent_provider_vendors_per_required_adapter_chain: 2
mev_observation_archive_required: true
runtime_endpoint_source: secret_manager_only
cross_provider_conflict_policy: fail_closed
```

两个独立 Provider 才能真实验证 provider conflict；单 Provider 不能支撑当前 readiness 目标。Provider operations owner 是 `platform_operations`。真实厂商采购、合同、endpoint 和 secret reference 仍待后续受控配置；仓库只允许保存 `secretref:`，本记录不收集厂商名称、URL 或 token。

### DEC-04：部署与数据库边界

状态：`confirmed_decision / deployment_unapproved`

已确认：

```text
deployment_boundary: dedicated_private_control_plane
database_boundary: dedicated_database
public_product_rag_imports_control_store: false
worker_network_access: allowlisted_provider_egress_only
migrations: separate_release_job
secrets: managed_secret_store
```

链上 control plane 与公开 Product RAG 运行面分离，使用独立 database、最小权限用户、独立备份/恢复和审计策略；Provider secret 不得注入 API/Web/Telegram 容器。具体云平台、secret manager 产品、数据库实例和备份实现仍由 `platform_operations` 在后续部署审批中选择，本 Goal 不虚构这些资源。

### DEC-05：身份与职责分离

状态：`confirmed_ownership / grants_unapproved`

身份来源确认为平台 service account 与受控人工账号，治理模式确认为 `single_owner`：

| 职责                              | 最低要求                                     | 已确认责任域          | 真实 grant |
| --------------------------------- | -------------------------------------------- | --------------------- | ---------- |
| governance publisher              | 单一 owner；只发布 persisted governance 结果 | `product_owner`       | `pending`  |
| provider operator                 | 隔离 service account，不生成 readiness 结论  | `platform_operations` | `pending`  |
| readiness attestor                | 单一 owner；只引用 persisted evidence        | `technical_owner`     | `pending`  |
| sampling planner                  | 单一 owner；只固定 policy/plan               | `product_owner`       | `pending`  |
| sampling worker                   | 隔离 service account，仅执行有界采集         | `platform_operations` | `pending`  |
| candidate submitter               | 隔离 service account，不能审核 candidate     | `platform_operations` | `pending`  |
| independent reviewer              | 单一 owner，必须与 candidate submitter 分离  | `product_owner`       | `pending`  |
| retention/reconciliation operator | 隔离、可撤销的 service-account identity      | `platform_operations` | `pending`  |

四个人工角色共享同一个真实 owner principal，但保留不同的角色 grant、有效期、撤销和审计记录；四个执行角色使用不同 service-account principal。来源/法律/保留只需要 owner 一次批准，随后必须等待至少 15 分钟并由 plan 外的自动 authority verifier 核验精确 fingerprint。自动 verifier 是机器控制，不被描述为第二名审批人。

### DEC-06：来源、法律和保留策略

状态：`policy_decision_confirmed / legal_approval_evidence_pending`

已确认的数据政策输入与仍待审批的证据如下：

```text
selected_source_kinds:
  - public_rpc
  - official_explorer_export
public_chain_data_only: true
credentials_allowed: false
private_data_allowed: false
retention_days: 90
retention_policy_id: TBD
legal_review_owner: product_owner
retention_review_owner: product_owner
source_approval_owner: product_owner
approval_status: unapproved
approval_evidence_fingerprint: pending
approval_valid_from: TBD
approval_valid_until: TBD
```

这里的 `selected_source_kinds` 和 90 天保留期是已确认的产品政策，不是法律意见或可执行 source approval。Provider 访问凭据只能来自 managed secret store，不得进入样本、manifest 或审批材料。真实 source/legal/retention evidence 必须由唯一 owner 通过受控审批记录完成，control store 只保存其 SHA-256 fingerprint，不能用空值、示例 hash 或 contract fixture 替代。

### DEC-07：SLO、成本和 Readiness policy

状态：`acceptance_process_confirmed / production_thresholds_unapproved`

已确认首批强制执行全部八类内置故障演练，且只有 canonical evaluator 输出 `ready` 才能通过 readiness acceptance。生产 policy 仍必须由 `technical_owner` 与 `platform_operations` 基于真实环境显式确定：

```text
mandatory_drills:
  - audit_sink_unavailable
  - budget_exhaustion
  - circuit_backend_unavailable
  - malformed_payload
  - provider_conflict
  - provider_rate_limit
  - provider_timeout
  - reorg_detected
```

- availability、error rate、p95 latency、平均成本上限；
- 每个 chain/adapter 的 Provider 数量；
- SLO 最小样本数和最大证据年龄；
- circuit snapshot、故障演练和 corpus 的最大年龄；
- audit retention、open incident 上限和最大恢复时间；
- 八类内置故障演练各自的成功标准和证据新鲜度。

阈值不能从 contract-only fixture 复制到生产。在真实阈值、operations evidence、governed corpus 和 persisted lineage 完整前，状态只能是 `not_evaluated`、`blocked` 或 `degraded`，不能声明 `ready`。

### DEC-08：上线与回滚权限

状态：`confirmed_decision / activation_unapproved`

已确认：

```text
activation_requires_readiness_status: ready
activation_scope: internal_only
automatic_public_rollout: false
rollback_trigger:
  - readiness becomes blocked or degraded
  - provider conflict cannot be resolved
  - audit/budget/circuit backend unavailable
  - security or retention evidence expires
```

即使真实 attestation 为 `ready`，也只允许提出内部 Capability bridge 评审；公开客服接线仍需独立产品、安全与合规批准。

## 确定性校验映射

不新增一套会与现有契约漂移的“草案配置 schema”。用户确认后的值必须分别通过已经存在的 canonical validators：

| 决策                          | Canonical validator/artifact                                                |
| ----------------------------- | --------------------------------------------------------------------------- |
| 来源、法律、保留              | `mainnetSamplingSourceApprovalInputSchema` → content-addressed approval     |
| chain、protocol、route、quota | `mainnetSamplingPolicyInputSchema` → policy/plan/slots                      |
| Provider topology             | `providerDeploymentDescriptorInputSchema`，只保存 `secretref:`              |
| 身份与角色                    | `createGovernanceAuthorization()` 和 control-store authorization/revocation |
| 预算与熔断                    | provider budget policy、shared circuit state 和 Postgres CAS backend        |
| SLO/drill/security/runbook    | `productionOperationsEvidenceBundleSchema`                                  |
| Readiness thresholds          | `productionReadinessPolicyInputSchema`                                      |
| 最终结论                      | persisted export/report/evidence/policy → evidence ledger 重算              |

这样可以避免 Markdown 中的 `TBD` 被误当成可执行配置。任何真实 artifact 都必须由对应 schema 生成并持久化，不能手工复制 fingerprint。

## 决策确认与后续审批边界

产品负责人已于 2026-07-23 确认：

```yaml
target_chain_ids: ['1']
initial_capability_scope: full_chain_analysis
independent_provider_vendors_per_adapter_chain: 2
deployment_boundary: dedicated_private_control_plane
database_boundary: dedicated_database
selected_source_kinds: [public_rpc, official_explorer_export]
retention_days: 90
identity_source: [platform_service_accounts, controlled_human_accounts]
governance_mode: single_owner
human_owner_count: 1
required_human_reviews_per_candidate: 1
automated_authority_verification_required: true
governance_owner: product_owner
provider_operations_owner: platform_operations
legal_and_retention_owner: product_owner
readiness_policy_owner: technical_owner
technical_baseline_decision: approve_recommended
```

因此本记录状态为 `confirmed_decision`。真实法律与来源审批、Provider 合同和配置、principal/grant、生产 SLO policy、主网 evidence 与 readiness attestation 仍属于后续 v0.14b2b 执行阶段；任何一项缺失都不得被本决策记录替代。
