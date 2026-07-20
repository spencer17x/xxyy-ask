# 知识来源与分类

XXYY Ask 的正式知识库只接受以下三类来源，分类在入库阶段完成，不由回答模型临时判断。

| 分类             | 内部值           | 规范来源                | 当前状态 |
| ---------------- | ---------------- | ----------------------- | -------- |
| XXYY 官方文档    | `official_docs`  | https://docs.xxyy.io/   | 已启用   |
| XXYY 官方 X 更新 | `x_updates`      | https://x.com/useXXYYio | 已启用   |
| XXYY 客服群知识  | `admin_verified` | 暂无固定 URL            | 当前为空 |

## 入库规则

- 官网页面、官网图片 OCR、官网视频 sidecar 和从官网正文派生的人工校正内容归为 `official_docs`。
- `x.com/useXXYYio/status/<id>` 的原始帖子，以及明确以该帖子为来源的整理页归为 `x_updates`。
- 外部 GitHub、博客、第三方转发或其他 X 账号不进入正式知识库；已有文件可以保留为归档，但加载器不会索引。
- 客服群原始聊天不能直接入库。后续上传聊天记录或让 Bot 进入群时，只能先生成脱敏候选，再经人工批准、检索门禁和 Golden QA 发布为 `admin_verified`。
- `current`、`historical`、`deprecated` 和 `supersedes` 独立描述知识时效，不替代来源分类。

## 引用与统计

RAG 生成的引用携带 `sourceType`，Web 和 Telegram 会显示对应中文来源标签。`pnpm rag:stats` 按三类来源输出文档数和 chunk 数，便于确认客服群来源在未接入前保持为零。

## 媒体检索

- 图片 OCR 和视频字幕、转写或关键帧 OCR 仍以文本参与 embedding；原始媒体地址作为 chunk 元数据保存。
- 检索命中媒体解析 chunk、带媒体的官方 X 帖子，或正文中紧邻的图片/视频链接时，回答最多返回 4 个去重后的相关附件。
- Web 直接展示本地 MP4 和图片；外部 X / YouTube 视频显示封面或原始视频链接。
- Telegram 直接发送 PNG、JPEG 和本地 MP4；其他图片格式或外部视频返回可访问链接。相对 `/assets/*` 地址需要配置 `TELEGRAM_PUBLIC_BASE_URL` 才能由 Telegram 拉取。
