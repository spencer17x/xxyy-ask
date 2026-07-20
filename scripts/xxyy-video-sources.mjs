import path from 'node:path';

const PRODUCT_FEATURES_DIR = path.join('docs', 'product-features');

export const VIDEO_SOURCES = [
  {
    id: 'xxyy-add-to-home',
    kind: 'local',
    path: path.join(PRODUCT_FEATURES_DIR, 'assets', 'xxyy-add-to-home.mp4'),
    sourceUrl: '/assets/xxyy-add-to-home.mp4',
    title: 'XXYY 添加到桌面演示',
    reviewedSummary:
      '在 iPhone Safari 中打开 XXYY，点击浏览器分享按钮，在分享菜单选择“Add to Home Screen（添加到主屏幕）”，确认后即可从桌面图标进入 XXYY。',
  },
  {
    id: 'mzTSPHqP8UA',
    kind: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=mzTSPHqP8UA',
    title: 'XXYY Telegram 钱包监控配置教程',
    textCoverage: {
      level: 'full',
      rationale: '官网同页提供了完整的三步配置说明和逐步截图，视频属于辅助演示。',
      sources: [
        {
          file: 'pages/51-getting-started__dashboard__jian-kong-guan-li__telegram-wallet-monitoring-configuration-guide.md',
          requiredMarkers: [
            '#### 第一步：创建 Telegram Group',
            '#### 第二步：创建自己的 Bot',
            '#### 第三步：获取 Group ID',
            '点击测试推送验证配置是否成功',
          ],
        },
      ],
    },
  },
  {
    id: 'ssww8GJnedE',
    kind: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=ssww8GJnedE',
    title: 'XXYY 三分钟功能视频指南',
    textCoverage: {
      level: 'core',
      rationale:
        '官方文字与专题文档覆盖扫链、钱包监控、发现区、代币安全信息和 Holder 分析等核心知识；未转写部分仅可能包含演示顺序或旁白细节。',
      sources: [
        {
          file: 'pages/54-getting-started__sao-lian-ye-mian.md',
          requiredMarkers: ['# 扫链页面', '### ⚙️ 交易设置', '### 🆕 新交易对'],
        },
        {
          file: 'pages/47-getting-started__dashboard__jian-kong-guan-li.md',
          requiredMarkers: ['# 监控管理', '关注钱包设置', '设置 TG通知'],
        },
        {
          file: 'pages/21-getting-started__fa-xian.md',
          requiredMarkers: ['# 发现', '收藏、Pump、趋势、钱包、监控四个区域'],
        },
        {
          file: 'pages/37-getting-started__dai-bi-xin-xi-qu.md',
          requiredMarkers: ['# 代币信息区', '安全性数据', 'Top 10 Holders持有比例'],
        },
        {
          file: 'pages/42-getting-started__dashboard__holders.md',
          requiredMarkers: ['# Holders', 'Holder', 'TagHolder'],
        },
      ],
    },
  },
];

export const VIDEO_SOURCE_BY_ID = new Map(VIDEO_SOURCES.map((source) => [source.id, source]));
