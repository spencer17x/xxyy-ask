# Chain Control Production Provisioning Operations

## 状态与用途

`@xxyy/chain-control-cli` 是 Goal 20B-1 的私有控制面 composition root。它把真实 owner 审批、身份登记和自动验证产生的指纹转换为可验证的 PostgreSQL provisioning receipt，但不接入 Agent、API、Web、Telegram、MCP 或 Product RAG。

仓库已具备以下执行路径：

- 从受控 JSON 生成 content-addressed single-owner plan；
- 使用独立 Ed25519 机器密钥签署精确 plan fingerprint；
- 使用固定 public key 和 authority id 验证 attestation；
- 在计划执行时间后的 15 分钟窗口内原子写入 1 个 approval、8 个 role grants、8 条 normalized grant lineage、1 个 receipt 和 10 个治理审计事件；
- 重读 receipt、normalized lineage 和完整治理 audit chain，输出脱敏 verification summary；
- 对同一 plan 做精确幂等重试，对漂移、撤销、过期窗口、签名错误和数据库失败保持 fail closed。

这只是可部署执行面。没有真实受控账号、审批 evidence、独立生产数据库和最终 receipt 时，Goal 20B-1 仍是 `pending_owner_execution`；本地或 CI integration test 不得写成生产完成证明。

## 信任边界

流程有三个相互分离的主体：

1. `owner` 准备来源、法律、保留和 identity evidence，只把 SHA-256 fingerprint 放入 request。
2. `automated authority` 在冷静期结束后读取 exact plan，按固定 schema/policy 校验并使用 Ed25519 私钥签名。它是机器补偿控制，不是第二名人工审批人。
3. `chain-control runtime` 只持有 authority public key，验证签名后写入独立 PostgreSQL。它不能生成 approval、identity evidence 或 authority signature。

私钥、数据库密码、Provider credential、endpoint inventory、姓名、邮箱和证件不得进入 request、plan、attestation、receipt、Git、日志或聊天。私钥应由 secret manager、KMS/HSM 或受限文件挂载提供；CLI 要求文件不是 symlink 且 group/other 权限为零。

## 配置

命令只读取进程环境，不自动加载项目 `.env`：

| 变量                                      | 使用命令                     | 约束                                                         |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| `CHAIN_CONTROL_DATABASE_URL`              | migrate/apply/receipt/verify | 必须命名显式数据库；必须与 Product RAG 数据库不同            |
| `CHAIN_CONTROL_AUTHORITY_SYSTEM_ID`       | apply/verify                 | 必须与 attestation 中的固定 authority id 完全一致            |
| `CHAIN_CONTROL_AUTHORITY_PUBLIC_KEY_FILE` | apply/verify                 | 固定 Ed25519 SPKI PEM public key；不是 private key           |
| `DATABASE_URL` 或 `POSTGRES_DB/HOST/PORT` | 安全比较                     | 若解析为同一 Product RAG 数据库，chain-control 命令拒绝运行  |
| `CHAIN_CONTROL_INTEGRATION_DATABASE_URL`  | opt-in integration test      | 只能指向可删除的一次性空测试数据库；不用于普通测试或生产执行 |

远程 `CHAIN_CONTROL_DATABASE_URL` 必须显式使用 `sslmode=verify-ca` 或 `sslmode=verify-full`。迁移阶段使用 DDL owner credential；apply/receipt/verify 阶段切换为独立最小权限 runtime credential。不要让客服 API、Telegram 或知识刷新 Job 获得这些变量。

## Request 契约

`plan --input` 接收严格 JSON object，未知字段会拒绝。它包含：

- `approval`：真实 approval name、owner hash、approved/valid 时间、Ethereum 公开来源、90 天保留 policy id，以及法律/保留/两类来源 evidence hash；
- `identities`：恰好八条角色绑定；
- `authorizationValidUntil`：八个 grant 的共同到期时间；
- `provisionedAt`：预先安排的首次 apply 时间；
- `provisionedByHash`：唯一 owner principal hash。

固定角色如下：

| Role                   | Identity kind              | Principal 约束                |
| ---------------------- | -------------------------- | ----------------------------- |
| `candidate_submitter`  | `platform_service_account` | 独立 service account          |
| `governance_publisher` | `controlled_human_account` | 唯一 owner                    |
| `independent_reviewer` | `controlled_human_account` | 同一 owner，与 submitter 分离 |
| `provider_operator`    | `platform_service_account` | 独立 service account          |
| `readiness_attestor`   | `controlled_human_account` | 同一 owner                    |
| `retention_worker`     | `platform_service_account` | 独立 service account          |
| `sampling_planner`     | `controlled_human_account` | 同一 owner                    |
| `sampling_worker`      | `platform_service_account` | 独立 service account          |

所有 principal/evidence 都使用 `sha256:<64 lowercase hex>`。四个 service-account principal 必须彼此不同，也不能等于 owner 或 verifier；八个 identity evidence hash 必须唯一。CLI 不提供“自动生成真实 evidence”的命令，因为随机 hash 或测试 fixture 不能证明身份和审批。

## 执行顺序

### 1. 迁移独立数据库

```bash
export CHAIN_CONTROL_DATABASE_URL='postgresql://.../xxyy_chain_control?sslmode=verify-full'
pnpm chain:control:migrate
```

迁移可重复执行。生产 API 不会代为迁移。

### 2. 生成不可变 plan

```bash
pnpm chain:provision:plan -- \
  --input /secure/inbox/provisioning-request.json \
  --out /secure/outbox/provisioning-plan.json
```

输出使用 mode `0600` 且绝不覆盖已有文件。保存命令输出中的 `planId` 和 `planFingerprint`，由 owner 对照原始审批系统核验。

### 3. 冷静期后生成机器 attestation

`approvedAt + 900 seconds <= 当前执行机时间 <= provisionedAt` 时运行：

```bash
pnpm chain:provision:attest -- \
  --plan /secure/outbox/provisioning-plan.json \
  --private-key /run/secrets/chain-authority-private.pem \
  --policy-evidence-hash 'sha256:...' \
  --authority-system-id platform_policy_verifier \
  --out /secure/outbox/provisioning-attestation.json
```

`verifiedAt` 只能来自命令执行机的当前时钟，不能通过参数覆盖。机器时钟必须由受控 NTP 同步；签名机应与 runtime principal 和 owner credential 分离。attestation 只含 public-key fingerprint、decision、signature 和 content-addressed verification claim，不含 private key。

### 4. 在批准窗口内 apply

首次 apply 必须满足：

```text
provisionedAt <= current time < provisionedAt + 15 minutes
```

```bash
export CHAIN_CONTROL_AUTHORITY_SYSTEM_ID=platform_policy_verifier
export CHAIN_CONTROL_AUTHORITY_PUBLIC_KEY_FILE=/run/secrets/chain-authority-public.pem
export CHAIN_CONTROL_DATABASE_URL='postgresql://.../xxyy_chain_control?sslmode=verify-full'

pnpm chain:provision:apply -- \
  --plan /secure/outbox/provisioning-plan.json \
  --attestation /secure/outbox/provisioning-attestation.json \
  --out /secure/outbox/provisioning-receipt.json
```

新 plan 超出窗口会返回 `provisioning_time_invalid`。已经成功写入的相同 plan 可以在窗口后安全重试并返回原 receipt；不同 fingerprint、活动 grant/approval 漂移或预先撤销都会拒绝。

### 5. 独立重读与验证

```bash
pnpm chain:provision:receipt -- \
  --plan-id production_provisioning_plan_... \
  --out /secure/outbox/read-receipt.json

pnpm chain:provision:verify -- \
  --plan-id production_provisioning_plan_... \
  --attestation /secure/outbox/provisioning-attestation.json \
  --out /secure/outbox/provisioning-verification.json
```

`receipt` 会重新解析 content-addressed receipt 并核对 8 条 normalized grant lineage。`verify` 还会使用固定 authority public key 重新验证 attestation 与 receipt 中的精确 plan/verification，再读取完整 governance hash chain，要求 approval、8 个 grants 和 receipt 各有且只有一个匹配事件；输出 verification/audit fingerprint 和计数，不输出 principal 或 evidence 原文。

把 receipt、verification summary、数据库备份/加密/访问审计证明和外部审批记录放入受控 evidence store。不要提交到 Git。

## 失败与恢复

- schema、签名、authority id/public-key fingerprint 不匹配：修复受控输入，不能跳过 verifier；
- 首次 apply 过早或过晚：生成新的 owner-approved plan 和 attestation，不能修改旧 plan；
- database unavailable：保持无写入或事务回滚，恢复数据库后使用相同 plan 重试；
- active approval/grant conflict 或 revocation：先调查现有不可变历史，再走新审批；不能 delete/update 历史行；
- output 已存在：选择新的受控路径并人工比对；CLI 不覆盖文件；
- audit/lineage 验证失败：停止后续 worker 与 Capability 激活，保留数据库快照并调查。

## 验证

默认测试不会连接数据库：

```bash
pnpm --filter @xxyy/chain-control-cli typecheck
pnpm --filter @xxyy/chain-control-cli test
pnpm check
```

一次性 PostgreSQL 验证必须显式指向空的可删除数据库：

```bash
CHAIN_CONTROL_INTEGRATION_DATABASE_URL='postgresql://.../disposable_empty_database' \
  pnpm --filter @xxyy/chain-control-cli exec vitest run src/postgres.integration.test.ts
```

该测试覆盖迁移二次执行、签名、首次 apply、窗口后幂等 retry、receipt 重读、1 approval / 8 grants / 8 lineage / 1 receipt / 10 audit events、完整 audit verification 和 append-only trigger。运行成功仍只表示仓库执行路径有效，不是生产审批或生产 readiness evidence。
