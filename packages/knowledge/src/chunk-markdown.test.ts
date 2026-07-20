import { describe, expect, it } from 'vitest';

import type { SourceDocument } from '@xxyy/shared';

import { chunkMarkdownDocuments } from './chunk-markdown.js';

const document: SourceDocument = {
  id: 'official_docs:pages/telegram',
  title: '设置 TG通知',
  module: 'Dashboard',
  sourceType: 'official_docs',
  file: '/docs/product-features/pages/telegram.md',
  sourceUrl: 'https://docs.xxyy.io/telegram',
  order: 51,
  effectiveAt: '2025-10-24T09:17:54.613Z',
  retrievedAt: '2026-05-24T06:41:04.265Z',
  status: 'current',
  supersedes: ['x_updates:telegram-old'],
  content: [
    '# 设置 TG通知',
    '',
    '重要提示：请使用官方 bot。',
    '',
    '## 第一步：创建 Telegram Group',
    '',
    '打开 Telegram，点击左上角菜单。',
    '',
    '1. 点击创建 group',
    '2. 将 bot 设置为管理员',
    '',
    '## 第二步：创建自己的 Bot',
    '',
    '访问 BotFather 创建 bot，并保存 token api。',
    '',
  ].join('\n'),
};

describe('chunkMarkdownDocuments', () => {
  it('rejects invalid chunk sizes before splitting text', () => {
    expect(() => chunkMarkdownDocuments([document], { maxChunkChars: 0 })).toThrow(
      'maxChunkChars must be a positive integer',
    );
  });

  it('splits markdown into stable heading-aware chunks', () => {
    const chunks = chunkMarkdownDocuments([document], { maxChunkChars: 90 });

    expect(chunks.map((chunk) => chunk.id)).toEqual([
      'official_docs:pages/telegram:chunk:0001',
      'official_docs:pages/telegram:chunk:0002',
      'official_docs:pages/telegram:chunk:0003',
    ]);

    expect(chunks[0]?.metadata).toMatchObject({
      title: '设置 TG通知',
      module: 'Dashboard',
      sourceType: 'official_docs',
      file: '/docs/product-features/pages/telegram.md',
      sourceUrl: 'https://docs.xxyy.io/telegram',
      order: 51,
      effectiveAt: '2025-10-24T09:17:54.613Z',
      retrievedAt: '2026-05-24T06:41:04.265Z',
      status: 'current',
      supersedes: ['x_updates:telegram-old'],
      headingPath: ['设置 TG通知'],
    });
    expect(chunks[1]?.metadata.headingPath).toEqual(['设置 TG通知', '第一步：创建 Telegram Group']);
    expect(chunks[1]?.text).toContain('打开 Telegram');
    expect(chunks[1]?.text).toContain('点击创建 group');
    expect(chunks[1]?.text).toContain('将 bot 设置为管理员');
    expect(chunks[2]?.metadata.headingPath).toEqual(['设置 TG通知', '第二步：创建自己的 Bot']);
  });

  it('uses a 900-character default ceiling', () => {
    const chunks = chunkMarkdownDocuments([
      {
        ...document,
        content: `# 长篇说明\n\n${'这是一个完整的产品说明句子。'.repeat(120)}`,
      },
    ]);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 900)).toBe(true);
  });

  it('splits long prose on sentence boundaries and overlaps the previous sentence', () => {
    const chunks = chunkMarkdownDocuments(
      [
        {
          ...document,
          content:
            '# 操作说明\n\n第一句介绍入口位置。第二句说明打开设置面板。第三句说明选择钱包并保存。第四句说明测试配置是否生效。',
        },
      ],
      { maxChunkChars: 45, overlapChars: 15 },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain('第三句说明选择钱包并保存。');
    expect(chunks[1]?.text).toContain('第三句说明选择钱包并保存。');
    expect(chunks[1]?.text).toContain('第四句说明测试配置是否生效。');
  });

  it('uses character overlap only as the final fallback for one oversized sentence', () => {
    const chunks = chunkMarkdownDocuments(
      [
        {
          ...document,
          content: `# 超长字段\n\n${'ABCDEFGHIJ'.repeat(10)}`,
        },
      ],
      { maxChunkChars: 40, overlapChars: 10 },
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.text.slice(-10)).toBe(chunks[1]?.text.slice(0, 10));
    expect(chunks[1]?.text.slice(-10)).toBe(chunks[2]?.text.slice(0, 10));
  });

  it('keeps list items intact when splitting long procedures', () => {
    const listItems = [
      '1. 打开 Telegram 并创建一个新的 Group',
      '2. 搜索官方机器人并将其添加到 Group',
      '3. 将机器人设置为管理员并保存配置',
      '4. 返回 XXYY 页面执行测试推送',
    ];
    const chunks = chunkMarkdownDocuments(
      [{ ...document, content: ['# 操作步骤', '', ...listItems].join('\n') }],
      { maxChunkChars: 58, overlapChars: 10 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((chunk) => chunk.text.split('\n'))).toEqual(listItems);
  });

  it('drops isolated Markdown fences and license-only links', () => {
    const chunks = chunkMarkdownDocuments([
      {
        ...document,
        content: [
          '# Agent Skill',
          '',
          '## 示例',
          '',
          '```bash',
          '```',
          '',
          '## License',
          '',
          '[MIT](../LICENSE)',
          '',
          '## 产品能力',
          '',
          'XXYY Agent Skill 支持查询趋势列表。',
        ].join('\n'),
      },
    ]);

    expect(chunks.map((chunk) => chunk.text)).toEqual(['XXYY Agent Skill 支持查询趋势列表。']);
  });

  it('keeps headings and blank lines inside fenced code under the surrounding section', () => {
    const chunks = chunkMarkdownDocuments([
      {
        ...document,
        content: [
          '# API 示例',
          '',
          '## 请求',
          '',
          '```bash',
          'curl https://api.example.test/v1',
          '',
          '## 这是命令参数，不是 Markdown 标题',
          '```',
        ].join('\n'),
      },
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.metadata.headingPath).toEqual(['API 示例', '请求']);
    expect(chunks[0]?.text).toContain('## 这是命令参数，不是 Markdown 标题');
  });

  it('drops chunks that contain only an empty figure, comment, or horizontal rule', () => {
    const chunks = chunkMarkdownDocuments([
      {
        ...document,
        content: [
          '# 页面',
          '',
          '<figure><img src="/assets/demo.png" alt=""><figcaption></figcaption></figure>',
          '',
          '<!-- generated marker -->',
          '',
          '***',
          '',
          '## 有效内容',
          '',
          '这里有可检索的产品说明。',
        ].join('\n'),
      },
    ]);

    expect(chunks.map((chunk) => chunk.text)).toEqual(['这里有可检索的产品说明。']);
  });

  it('removes empty figures and generated comments from otherwise useful chunks', () => {
    const chunks = chunkMarkdownDocuments([
      {
        ...document,
        content: [
          '# 页面',
          '',
          '<figure><img src="/assets/demo.png" alt=""><figcaption></figcaption></figure>',
          '',
          '这里有可检索的产品说明。',
          '',
          '<!-- xxyy-ask:curated-end -->',
        ].join('\n'),
      },
    ]);

    expect(chunks.map((chunk) => chunk.text)).toEqual(['这里有可检索的产品说明。']);
  });

  it('adds one bounded overview chunk for documents with several short sections', () => {
    const chunks = chunkMarkdownDocuments([
      {
        ...document,
        title: '扫链页面',
        content: [
          '# 扫链页面',
          '',
          '## 交易设置',
          '',
          '可选择钱包、交易费和滑点。',
          '',
          '## 新交易对',
          '',
          '展示新发射项目。',
          '',
          '## 已经发射',
          '',
          '展示已迁移项目。',
        ].join('\n'),
      },
    ]);

    expect(chunks).toHaveLength(4);
    expect(chunks[3]?.metadata.headingPath).toEqual(['扫链页面', 'Document overview / 页面概览']);
    expect(chunks[3]?.text).toContain('### 交易设置');
    expect(chunks[3]?.text).toContain('### 新交易对');
    expect(chunks[3]?.text).toContain('### 已经发射');
    expect(chunks[3]?.text.length).toBeLessThanOrEqual(900);
  });
});
