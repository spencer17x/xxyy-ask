import { describe, expect, it } from 'vitest';

import {
  createPgVectorStore,
  toPgVectorLiteral,
  type EmbeddedKnowledgeChunk,
  VectorStoreUnavailableError,
} from './pgvector-store.js';

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
    const vector = embedding1536({ 0: 0.1, 1: -0.2 });

    expect(toPgVectorLiteral(vector)).toBe(`[${vector.join(',')}]`);
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
      createChunk({
        embedding: embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 }),
        metadata: { retrievedAt: '2026-05-24T06:41:04.265Z' },
      }),
      createChunk({
        contentHash: 'hash-2',
        documentId: 'official_docs:basic',
        id: 'official_docs:basic:chunk:0001',
        metadata: {
          file: 'docs/basic.md',
          headingPath: ['XXYY Basic'],
          module: 'XXYY Basic',
          title: 'XXYY Basic',
        },
      }),
    ]);

    expect(client.queries[0]?.sql).toContain('insert into knowledge_chunks');
    expect(client.queries[0]?.sql).toContain(
      'retrieved_at = coalesce(excluded.retrieved_at, knowledge_chunks.retrieved_at)',
    );
    expect(client.queries[0]?.values).toContain(
      toPgVectorLiteral(embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })),
    );
    expect(client.queries[0]?.values[9]).toBe('2026-05-24T06:41:04.265Z');
    expect(client.queries[1]?.values[9]).toBeNull();
  });

  it('rejects upsert chunk embeddings with the wrong dimension', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await expect(store.upsertChunks([createChunk({ embedding: [0.1, 0.2, 0.3] })])).rejects.toThrow(
      'Expected embedding dimension 1536, got 3.',
    );
  });

  it('rejects upsert chunk embeddings with non-finite values', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await expect(
      store.upsertChunks([createChunk({ embedding: embedding1536({ 0: Number.NaN }) })]),
    ).rejects.toThrow('Embedding contains a non-finite value.');
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
    const embeddedTexts: string[][] = [];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts(texts) {
          embeddedTexts.push(texts);
          return Promise.resolve([embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })]);
        },
      },
    });

    const results = await store.retrieve('XXYY Pro 支持什么？', { topK: 1 });

    expect(embeddedTexts).toEqual([['XXYY Pro 支持什么？']]);
    expect(client.queries.at(-1)?.sql).toContain('embedding <=> $1::vector');
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

  it('includes token-overlap candidates for short feature questions', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        content: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
        document_id: 'x_updates:xxyy-x-updates',
        embedding_distance: 0.9,
        file: 'docs/product-features/xxyy-x-updates.md',
        heading_path: ['2026 年 3 月至 4 月'],
        id: 'x_updates:xxyy-x-updates:chunk:0001',
        module: 'X Updates',
        order_index: null,
        retrieved_at: null,
        source_type: 'x_updates',
        source_url: null,
        title: 'XXYY X 历史推文产品更新汇总',
        tokens: ['跟单功能上线', '跟', '跟单', '单', '功能', '上线'],
      },
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })]),
      },
    });

    const results = await store.retrieve('XXYY支持跟单么', { topK: 1 });

    const lastQuery = client.queries.at(-1);
    expect(lastQuery?.sql).toContain('tokens && $3::text[]');
    expect(lastQuery?.values[2]).toContain('跟单');
    expect(results[0]?.id).toBe('x_updates:xxyy-x-updates:chunk:0001');
    expect(results[0]?.lexicalScore).toBeGreaterThan(0);
  });

  it('wraps pgvector query failures as vector store unavailability', async () => {
    const store = createPgVectorStore({
      client: {
        query: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
      },
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1 })]),
      },
    });

    await expect(store.retrieve('XXYY Pro 支持什么？', { topK: 1 })).rejects.toBeInstanceOf(
      VectorStoreUnavailableError,
    );
  });

  it('rejects query embeddings with the wrong dimension', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([[0.1, 0.2, 0.3]]) },
    });

    await expect(store.retrieve('XXYY Pro 支持什么？', { topK: 1 })).rejects.toThrow(
      'Expected embedding dimension 1536, got 3.',
    );
  });

  it('rejects query embeddings with non-finite values', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: Number.POSITIVE_INFINITY })]),
      },
    });

    await expect(store.retrieve('XXYY Pro 支持什么？', { topK: 1 })).rejects.toThrow(
      'Embedding contains a non-finite value.',
    );
  });

  it.each([0, -2])('normalizes invalid topK %s to the default', async (topK) => {
    const client = new FakePgClient();
    client.rows = Array.from({ length: 8 }, (_, index) => ({
      content: `XXYY Pro chunk ${index}`,
      document_id: 'official_docs:pro',
      embedding_distance: index / 100,
      file: 'docs/pro.md',
      heading_path: ['XXYY Pro 权益'],
      id: `official_docs:pro:chunk:${String(index + 1).padStart(4, '0')}`,
      module: 'XXYY Pro',
      order_index: null,
      retrieved_at: null,
      source_type: 'official_docs',
      source_url: null,
      title: 'XXYY Pro 权益',
      tokens: ['xxyy', 'pro'],
    }));
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })]),
      },
    });

    const results = await store.retrieve('XXYY Pro 支持什么？', { topK });

    expect(client.queries.at(-1)?.values[1]).toBe(24);
    expect(results).toHaveLength(6);
  });
});

type TestChunk = EmbeddedKnowledgeChunk & {
  metadata: EmbeddedKnowledgeChunk['metadata'] & { retrievedAt?: string };
};

type TestChunkOverrides = Partial<Omit<TestChunk, 'metadata'>> & {
  metadata?: Partial<TestChunk['metadata']>;
};

function embedding1536(overrides: Record<number, number> = {}): number[] {
  const vector = Array.from({ length: 1536 }, () => 0);
  for (const [index, value] of Object.entries(overrides)) {
    vector[Number(index)] = value;
  }
  return vector;
}

function createChunk(overrides: TestChunkOverrides = {}): TestChunk {
  const { metadata: metadataOverrides, ...chunkOverrides } = overrides;

  return {
    contentHash: 'hash-1',
    documentId: 'official_docs:pro',
    embedding: embedding1536(),
    id: 'official_docs:pro:chunk:0001',
    metadata: {
      file: 'docs/pro.md',
      headingPath: ['XXYY Pro 权益'],
      module: 'XXYY Pro',
      sourceType: 'official_docs',
      title: 'XXYY Pro 权益',
      ...metadataOverrides,
    },
    searchableText: 'XXYY Pro 权益\nXXYY Pro 支持 Telegram 钱包监控。',
    text: 'XXYY Pro 支持 Telegram 钱包监控。',
    tokens: ['xxyy', 'pro', 'telegram'],
    ...chunkOverrides,
  };
}
