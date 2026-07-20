import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createLocalHashEmbedding,
  loadProductDocuments,
  prepareKnowledgeChunks,
} from '@xxyy/knowledge';
import type { RagIndex } from '@xxyy/shared';
import { describe, expect, it } from 'vitest';

import { retrieve } from './retrieve.js';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function loadProductIndex(): Promise<RagIndex> {
  const documents = await loadProductDocuments({ cwd: workspaceRoot });
  return {
    builtAt: '1970-01-01T00:00:00.000Z',
    entries: prepareKnowledgeChunks(documents).map((chunk) => ({
      documentId: chunk.documentId,
      embedding: createLocalHashEmbedding(chunk.searchableText),
      id: chunk.id,
      metadata: chunk.metadata,
      text: chunk.text,
      tokens: chunk.tokens,
    })),
    version: 1,
  };
}

describe('retrieve over product docs', () => {
  it('prioritizes Swap trading docs for buy-token how-to questions', async () => {
    const index = await loadProductIndex();

    const results = retrieve('如何在 XXYY 买入代币？', index, { topK: 3 });

    expect(results[0]?.metadata.title).toBe('Swap 交易');
  });

  it('retrieves the API reference for explicit developer API questions', async () => {
    const index = await loadProductIndex();

    const results = retrieve('XXYY API 的认证方式和 Swap 接口是什么？', index, { topK: 3 });

    expect(results[0]?.metadata.title).toBe('XXYY API 参考文档');
    expect(results[0]?.metadata.sourceUrl).toBe('https://docs.xxyy.io/xxyy-api-can-kao-wen-dang');
  });

  it('retrieves the reviewed English fallback for the upstream empty Avg. Price Line page', async () => {
    const index = await loadProductIndex();

    const results = retrieve('How does the Avg. Price Line work?', index, { topK: 3 });

    expect(results[0]?.metadata.title).toBe('Avg. Price Line');
    expect(results[0]?.metadata.sourceUrl).toBe(
      'https://docs.xxyy.io/en/chart-area/avg.-price-line',
    );
    expect(results[0]?.text).toContain('average purchase cost');
  });

  it('retrieves the mobile app desktop shortcut FAQ', async () => {
    const index = await loadProductIndex();

    const results = retrieve('XXYY 有 APP 吗？', index, { topK: 3 });

    expect(results[0]?.metadata.title).toBe('移动端桌面入口');
    expect(results[0]?.text).toContain('可以添加到桌面');
    expect(results[0]?.text).toContain('/assets/xxyy-add-to-home.mp4');
  });

  it('retrieves a complete XXYY Pro benefits FAQ', async () => {
    const index = await loadProductIndex();

    const results = retrieve('XXYY Pro 有哪些权益？', index, { topK: 3 });

    expect(results[0]?.text).toContain('独享服务器和节点');
    expect(results[0]?.text).toContain('每条链最多监控5000个钱包');
    expect(results[0]?.text).toContain('收藏1000个代币');
  });

  it('retrieves individual X posts with direct tweet source URLs', async () => {
    const index = await loadProductIndex();

    const results = retrieve('钱包备注支持最多 1 万条是哪条推文？', index, { topK: 3 });

    expect(results[0]?.metadata.title).toBe('X Post 2030954722350575916');
    expect(results[0]?.metadata.sourceUrl).toBe(
      'https://x.com/useXXYYio/status/2030954722350575916',
    );
    expect(results[0]?.text).toContain('钱包备注支持最多 1 万条');
  });
});
