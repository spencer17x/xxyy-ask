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
      'official_docs:pages/telegram:chunk:0004',
    ]);

    expect(chunks[0]?.metadata).toMatchObject({
      title: '设置 TG通知',
      module: 'Dashboard',
      sourceType: 'official_docs',
      file: '/docs/product-features/pages/telegram.md',
      sourceUrl: 'https://docs.xxyy.io/telegram',
      order: 51,
      headingPath: ['设置 TG通知'],
    });
    expect(chunks[1]?.metadata.headingPath).toEqual(['设置 TG通知', '第一步：创建 Telegram Group']);
    expect(chunks[2]?.metadata.headingPath).toEqual(['设置 TG通知', '第一步：创建 Telegram Group']);
    expect(chunks[2]?.text).toContain('点击创建 group');
    expect(chunks[2]?.text).toContain('将 bot 设置为管理员');
    expect(chunks[3]?.metadata.headingPath).toEqual(['设置 TG通知', '第二步：创建自己的 Bot']);
  });
});
