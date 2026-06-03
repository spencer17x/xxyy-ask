import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SourceDocument } from '@xxyy/shared';

import {
  buildKnowledgeIndex,
  loadKnowledgeIndex,
  prepareKnowledgeChunks,
  saveKnowledgeIndex,
} from './index-store.js';

const document: SourceDocument = {
  id: 'official_docs:pages/pro',
  title: 'XXYY Pro 权益',
  module: 'XXYY Pro 权益',
  sourceType: 'official_docs',
  file: '/docs/product-features/pages/pro.md',
  sourceUrl: 'https://docs.xxyy.io/pro',
  order: 61,
  content: '# XXYY Pro 权益\n\nPro 用户支持 Telegram 钱包监控。\n',
};

describe('knowledge index storage', () => {
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

  it('builds a deterministic local token and embedding index', async () => {
    const first = await buildKnowledgeIndex([document]);
    const second = await buildKnowledgeIndex([document]);

    expect(first).toEqual(second);
    expect(first.version).toBe(1);
    expect(first.builtAt).toBe('1970-01-01T00:00:00.000Z');
    expect(first.entries).toHaveLength(1);
    const entry = first.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error('Expected the knowledge index to contain one entry');
    }

    expect(entry.id).toBe('official_docs:pages/pro:chunk:0001');
    expect(entry.documentId).toBe(document.id);
    for (const token of ['xxyy', 'pro', 'telegram', '钱包', '监控']) {
      expect(entry.tokens).toContain(token);
    }
    expect(entry.embedding.length).toBeGreaterThan(0);
  });

  it('saves and loads JSON indexes at caller-provided paths', async () => {
    const index = await buildKnowledgeIndex([document]);
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'xxyy-knowledge-index-'));
    const indexPath = path.join(fixtureDir, 'nested', 'knowledge-index.json');

    await saveKnowledgeIndex(indexPath, index);

    await expect(readFile(indexPath, 'utf8')).resolves.toContain('"version": 1');
    await expect(loadKnowledgeIndex(indexPath)).resolves.toEqual(index);
  });

  it('rejects malformed persisted indexes', async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'xxyy-knowledge-index-'));
    const indexPath = path.join(fixtureDir, 'knowledge-index.json');
    await writeFile(indexPath, JSON.stringify({ version: 2, entries: [] }), 'utf8');

    await expect(loadKnowledgeIndex(indexPath)).rejects.toThrow('Invalid knowledge index');
  });
});
