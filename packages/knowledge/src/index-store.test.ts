import { describe, expect, it } from 'vitest';

import { prepareKnowledgeChunks } from './index-store.js';

describe('knowledge chunk preparation', () => {
  it('prepares chunks with tokens, searchable text, and stable content hashes', () => {
    const documents = [
      {
        id: 'official_docs:pro',
        title: 'XXYY Pro 权益',
        module: 'XXYY Pro',
        sourceType: 'official_docs' as const,
        file: '/docs/pro.md',
        content: '# XXYY Pro 权益\n\nXXYY Pro 支持 Telegram 钱包监控。',
      },
    ];

    const chunks = prepareKnowledgeChunks(documents);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      documentId: 'official_docs:pro',
      metadata: {
        title: 'XXYY Pro 权益',
        module: 'XXYY Pro',
        sourceType: 'official_docs',
        file: 'docs/pro.md',
      },
    });
    expect(chunks[0]?.tokens).toContain('xxyy');
    expect(chunks[0]?.searchableText).toContain('Telegram 钱包监控');
    expect(chunks[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('preserves document retrieval timestamps on prepared chunks', () => {
    const chunks = prepareKnowledgeChunks([
      {
        id: 'official_docs:pro',
        title: 'XXYY Pro 权益',
        module: 'XXYY Pro',
        sourceType: 'official_docs' as const,
        file: '/docs/pro.md',
        content: '# XXYY Pro 权益\n\nXXYY Pro 支持 Telegram 钱包监控。',
        retrievedAt: '2026-05-24T06:41:04.265Z',
      },
    ]);

    expect(chunks[0]?.metadata).toMatchObject({
      retrievedAt: '2026-05-24T06:41:04.265Z',
    });
  });
});
