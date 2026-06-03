import { describe, expect, it } from 'vitest';

import { createPgVectorStore, toPgVectorLiteral } from './pgvector-store.js';

class FakePgClient {
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  rows: unknown[] = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    return Promise.resolve({ rows: this.rows as T[] });
  }
}

describe('toPgVectorLiteral', () => {
  it('formats vectors for pgvector parameters', () => {
    expect(toPgVectorLiteral([0.1, -0.2, 0])).toBe('[0.1,-0.2,0]');
  });
});

describe('createPgVectorStore', () => {
  it('migrates the knowledge chunk schema', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.migrate();

    expect(client.queries.map((query) => query.sql).join('\n')).toContain(
      'create table if not exists knowledge_chunks',
    );
  });

  it('upserts embedded chunks', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.upsertChunks([
      {
        contentHash: 'hash-1',
        documentId: 'official_docs:pro',
        embedding: [0.1, 0.2, 0.3],
        id: 'official_docs:pro:chunk:0001',
        metadata: {
          file: 'docs/pro.md',
          headingPath: ['XXYY Pro 权益'],
          module: 'XXYY Pro',
          sourceType: 'official_docs',
          title: 'XXYY Pro 权益',
        },
        searchableText: 'XXYY Pro 权益\nXXYY Pro 支持 Telegram 钱包监控。',
        text: 'XXYY Pro 支持 Telegram 钱包监控。',
        tokens: ['xxyy', 'pro', 'telegram'],
      },
    ]);

    expect(client.queries[0]?.sql).toContain('insert into knowledge_chunks');
    expect(client.queries[0]?.values).toContain('[0.1,0.2,0.3]');
  });

  it('retrieves and maps pgvector rows into RetrievedChunk results', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        content: 'XXYY Pro 支持 Telegram 钱包监控。',
        document_id: 'official_docs:pro',
        embedding_distance: 0.1,
        file: 'docs/pro.md',
        heading_path: ['XXYY Pro 权益'],
        id: 'official_docs:pro:chunk:0001',
        module: 'XXYY Pro',
        order_index: null,
        retrieved_at: null,
        source_type: 'official_docs',
        source_url: null,
        title: 'XXYY Pro 权益',
        tokens: ['xxyy', 'pro', 'telegram'],
      },
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([[0.1, 0.2, 0.3]]) },
    });

    const results = await store.retrieve('XXYY Pro 支持什么？', { topK: 1 });

    expect(results[0]).toMatchObject({
      id: 'official_docs:pro:chunk:0001',
      rank: 1,
      metadata: {
        file: 'docs/pro.md',
        sourceType: 'official_docs',
        title: 'XXYY Pro 权益',
      },
      text: 'XXYY Pro 支持 Telegram 钱包监控。',
    });
  });
});
