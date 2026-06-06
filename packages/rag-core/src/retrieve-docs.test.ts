import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildKnowledgeIndex, loadProductDocuments } from '@xxyy/knowledge';
import { describe, expect, it } from 'vitest';

import { retrieve } from './retrieve.js';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('retrieve over product docs', () => {
  it('prioritizes Swap trading docs for buy-token how-to questions', async () => {
    const documents = await loadProductDocuments({ cwd: workspaceRoot });
    const index = await buildKnowledgeIndex(documents);

    const results = retrieve('如何在 XXYY 买入代币？', index, { topK: 3 });

    expect(results[0]?.metadata.title).toBe('Swap 交易');
  });

  it('retrieves the mobile app desktop shortcut FAQ', async () => {
    const documents = await loadProductDocuments({ cwd: workspaceRoot });
    const index = await buildKnowledgeIndex(documents);

    const results = retrieve('XXYY 有 APP 吗？', index, { topK: 3 });

    expect(results[0]?.metadata.title).toBe('移动端桌面入口');
    expect(results[0]?.text).toContain('可以添加到桌面');
    expect(results[0]?.text).toContain('/assets/xxyy-add-to-home.mp4');
  });

  it('retrieves a complete XXYY Pro benefits FAQ', async () => {
    const documents = await loadProductDocuments({ cwd: workspaceRoot });
    const index = await buildKnowledgeIndex(documents);

    const results = retrieve('XXYY Pro 有哪些权益？', index, { topK: 3 });

    expect(results[0]?.text).toContain('独享服务器和节点');
    expect(results[0]?.text).toContain('监控2000个钱包');
    expect(results[0]?.text).toContain('收藏1000个代币');
  });
});
