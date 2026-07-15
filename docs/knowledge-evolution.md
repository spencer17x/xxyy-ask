# 受控知识演进与 Telegram 导入

当前实现不是让模型直接用聊天记录训练或自动改写自己，而是把管理员确认过的客服回复沉淀为候选知识，经人工审核和自动门禁后发布到 RAG。Web、Telegram Bot 与 CLI 最终仍读取同一个 pgvector 知识库。

## 安全边界

- Telegram 群聊原始导出只作为候选来源，不直接进入正式知识库，也不要提交到 Git。
- 只识别指定管理员对用户消息的直接回复；管理员普通发言、管理员互相回复和无法配对的消息不会成为候选。
- 账户、订单、余额、私有交易、投资建议、交易取证等边界问题会在导入时过滤。
- 候选文本写库前会脱敏常见密钥、地址、邮箱、电话和 Telegram 用户名。
- 每条候选都必须人工批准；发布时再执行产品边界、候选检索命中和完整 deterministic golden QA。
- 自动脱敏不能替代人工检查。审核时仍应删除姓名、群名、联系方式和其他不应长期保留的数据。

## 第一次迁移

候选表已包含在普通数据库迁移中：

```bash
pnpm rag:migrate
```

该命令不调用 embedding 或 LLM。

## 1. 导入 Telegram JSON

用 Telegram Desktop 把目标群导出为机器可读的 JSON，然后找到管理员在导出文件中的 `from_id`。`user123456789` 和 `123456789` 两种写法都可以传入；有多个管理员时重复 `--admin-id`。

```bash
pnpm rag:knowledge:import:telegram -- /absolute/path/result.json \
  --admin-id 123456789 \
  --admin-id 987654321
```

导入会输出扫描消息数、管理员消息数、候选数、重复数、边界过滤数和无法配对数。相同问题与答案会按内容哈希去重；重复运行同一导出不会重复创建候选。

## 2. 审核候选

列出待审核候选：

```bash
pnpm rag:knowledge:list -- --status pending --limit 20
```

命令按 JSONL 输出，便于复制候选 ID。批准前至少核对：答案是否仍然有效、是否来自有权限的管理员、是否含用户隐私、是否与正式文档冲突，以及生效时间是否正确。

批准：

```bash
pnpm rag:knowledge:approve -- knowledge_candidate_0123456789abcdef \
  --reviewer ops:alice \
  --effective-at 2026-07-15T08:00:00Z \
  --source-url https://docs.example.com/product/feature \
  --supersedes official_docs:old-feature \
  --note "已与产品负责人确认"
```

`--effective-at` 可覆盖 Telegram 消息时间。`--source-url` 可选，但有正式依据时应填写。`--supersedes` 接受逗号分隔的 document ID 或 chunk ID；它表示新规则替代哪些旧知识。默认问答会排除这些旧知识，包含“以前、历史、变更、哪条推文”等语义的问题仍可检索旧版本。

拒绝：

```bash
pnpm rag:knowledge:reject -- knowledge_candidate_0123456789abcdef \
  --reviewer ops:alice \
  --note "属于用户账户个案，不是通用产品规则"
```

审核状态只能从 `pending` 进入 `approved` 或 `rejected`，避免重复审批覆盖审计记录。

## 3. 发布

```bash
pnpm rag:knowledge:publish -- knowledge_candidate_0123456789abcdef
```

发布过程会：

1. 在 `docs/product-features/admin-verified/` 生成版本化 Markdown 文档。
2. 验证问题仍属于产品问答边界，并验证本地检索能命中新文档。
3. 运行完整 deterministic golden QA。
4. 生成 embeddings，在一个数据库事务内替换知识 chunks、记录 ingestion run，并把候选标为 `published`。

任一数据库步骤失败都会回滚知识替换和候选状态；本次新建的 Markdown 也会删除。发布成功后，Web、Telegram 和 CLI 会从同一 pgvector 数据读取更新后的知识。

## 当前没有自动做的事

- 不监听 Bot 未加入的群，也不使用个人账号 MTProto 抓取群聊。
- 不根据用户高频说法自动改变事实。
- 不自动把 Telegram 链接内容发布成知识。
- 尚未接入 Telegram Guest Mode 的 `/teach`、`/approve`、`/reject`。后续应复用这里的候选表、管理员白名单和发布门禁，而不是建立第二套知识库。
