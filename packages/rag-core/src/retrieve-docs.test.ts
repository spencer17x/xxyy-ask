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
});
