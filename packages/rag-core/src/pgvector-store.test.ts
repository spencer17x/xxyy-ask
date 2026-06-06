import { describe, expect, it } from 'vitest';

import {
  createPgVectorStore,
  toPgVectorLiteral,
  type EmbeddedKnowledgeChunk,
  VectorStoreUnavailableError,
} from './pgvector-store.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  rows: unknown[] = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    const rows = this.queuedRows.length > 0 ? (this.queuedRows.shift() ?? []) : this.rows;
    return Promise.resolve({ rows: rows as T[] });
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
    expect(client.queries.map((query) => query.sql).join('\n')).toContain(
      'create table if not exists rag_ingestion_runs',
    );
  });

  it('records ingestion runs for production knowledge versioning', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.recordIngestionRun({
      chunkCount: 64,
      contentHash: 'content-hash-1',
      documentCount: 12,
      runId: 'ingest_20260606T010203Z_abcd1234',
      source: 'cli',
      sourceCounts: {
        official_docs: 48,
        x_updates: 16,
      },
    });

    expect(client.queries[0]?.sql).toContain('insert into rag_ingestion_runs');
    expect(client.queries[0]?.values).toEqual([
      'ingest_20260606T010203Z_abcd1234',
      'cli',
      12,
      64,
      JSON.stringify({ official_docs: 48, x_updates: 16 }),
      'content-hash-1',
    ]);
  });

  it('records chat feedback for answer quality operations', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.recordFeedback({
      answer: '根据知识库，XXYY Pro 提供更多权益。',
      channel: 'web',
      citationCount: 2,
      comment: '没有讲清楚监控数量上限',
      intent: 'product_qa',
      question: 'XXYY Pro 有哪些权益？',
      rating: 'negative',
      sessionId: 'session-1',
    });

    expect(client.queries[0]?.sql).toContain('insert into rag_feedback');
    expect(client.queries[0]?.values).toEqual([
      'web',
      'session-1',
      'negative',
      'XXYY Pro 有哪些权益？',
      '根据知识库，XXYY Pro 提供更多权益。',
      'product_qa',
      2,
      '没有讲清楚监控数量上限',
    ]);
  });

  it('returns feedback stats for quality operations', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [{ negative_count: 1, positive_count: 2, total_count: 3 }],
      [
        {
          answer: '根据知识库，XXYY Pro 提供更多权益。',
          channel: 'web',
          citation_count: 2,
          comment: '没有讲清楚监控数量上限',
          created_at: '2026-06-06T02:03:04.000Z',
          intent: 'product_qa',
          question: 'XXYY Pro 有哪些权益？',
          rating: 'negative',
          session_id: 'session-1',
        },
      ],
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    const stats = await store.getFeedbackStats({ limit: 5 });

    expect(stats).toEqual({
      latest: [
        {
          answer: '根据知识库，XXYY Pro 提供更多权益。',
          channel: 'web',
          citationCount: 2,
          comment: '没有讲清楚监控数量上限',
          createdAt: '2026-06-06T02:03:04.000Z',
          intent: 'product_qa',
          question: 'XXYY Pro 有哪些权益？',
          rating: 'negative',
          sessionId: 'session-1',
        },
      ],
      negativeCount: 1,
      positiveCount: 2,
      totalCount: 3,
    });
    expect(client.queries[1]?.sql).toContain('from rag_feedback');
    expect(client.queries[1]?.values).toEqual([5]);
  });

  it('filters feedback stats by rating for operations review queues', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [{ negative_count: 1, positive_count: 0, total_count: 1 }],
      [
        {
          answer: '根据知识库，XXYY Pro 提供更多权益。',
          channel: 'web',
          citation_count: 2,
          comment: '没有讲清楚监控数量上限',
          created_at: '2026-06-06T02:03:04.000Z',
          intent: 'product_qa',
          question: 'XXYY Pro 有哪些权益？',
          rating: 'negative',
          session_id: 'session-1',
        },
      ],
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    const stats = await store.getFeedbackStats({ limit: 25, rating: 'negative' });

    expect(stats.negativeCount).toBe(1);
    expect(stats.latest).toHaveLength(1);
    expect(client.queries[0]?.sql).toContain('where rating = $1');
    expect(client.queries[0]?.values).toEqual(['negative']);
    expect(client.queries[1]?.sql).toContain('where rating = $1');
    expect(client.queries[1]?.values).toEqual(['negative', 25]);
  });

  it('returns knowledge stats for operations visibility', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        {
          chunk_count: 64,
          document_count: 12,
          latest_chunk_updated_at: '2026-06-06T01:02:03.000Z',
          source_url_count: 8,
        },
      ],
      [
        { chunk_count: 48, document_count: 10, source_type: 'official_docs' },
        { chunk_count: 16, document_count: 2, source_type: 'x_updates' },
      ],
      [
        {
          chunk_count: 64,
          content_hash: 'content-hash-1',
          created_at: '2026-06-06T01:03:04.000Z',
          document_count: 12,
          run_id: 'ingest_20260606T010203Z_abcd1234',
          source: 'cli',
          source_counts: { official_docs: 48, x_updates: 16 },
        },
      ],
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    const stats = await store.getStats();

    expect(stats).toEqual({
      chunkCount: 64,
      documentCount: 12,
      latestChunkUpdatedAt: '2026-06-06T01:02:03.000Z',
      latestIngestionRun: {
        chunkCount: 64,
        contentHash: 'content-hash-1',
        createdAt: '2026-06-06T01:03:04.000Z',
        documentCount: 12,
        runId: 'ingest_20260606T010203Z_abcd1234',
        source: 'cli',
        sourceCounts: { official_docs: 48, x_updates: 16 },
      },
      sourceStats: [
        { chunkCount: 48, documentCount: 10, sourceType: 'official_docs' },
        { chunkCount: 16, documentCount: 2, sourceType: 'x_updates' },
      ],
      sourceUrlCount: 8,
    });
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

  it('replaces stale chunks after upserting the current index', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.replaceChunks([
      createChunk({
        id: 'official_docs:pro:chunk:0001',
      }),
      createChunk({
        contentHash: 'hash-2',
        id: 'official_docs:pro:chunk:0002',
      }),
    ]);

    expect(client.queries[0]?.sql).toContain('insert into knowledge_chunks');
    expect(client.queries[1]?.sql).toContain('insert into knowledge_chunks');
    expect(client.queries[2]?.sql).toContain('delete from knowledge_chunks');
    expect(client.queries[2]?.values).toEqual([
      ['official_docs:pro:chunk:0001', 'official_docs:pro:chunk:0002'],
    ]);
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

  it('prioritizes direct X post source rows for tweet-source questions', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        content: '钱包备注支持最多 1 万条（来源：2030954722350575916）。',
        document_id: 'x_updates:xxyy-x-updates',
        embedding_distance: 0.1,
        file: 'docs/product-features/xxyy-x-updates.md',
        heading_path: ['2026 年 3 月至 4 月'],
        id: 'x_updates:xxyy-x-updates:chunk:0013',
        module: 'X Updates',
        order_index: null,
        retrieved_at: null,
        source_type: 'x_updates',
        source_url: null,
        title: 'XXYY X 历史推文产品更新汇总',
        tokens: ['钱包', '备注', '支持', '最多', '1', '万条'],
      },
      {
        content: '钱包备注支持最多 1 万条，快速捕捉前排地址。',
        document_id: 'x_updates:sources/usexxyyio-x-posts/2030954722350575916',
        embedding_distance: 0.4,
        file: 'docs/product-features/sources/usexxyyio-x-posts.jsonl',
        heading_path: ['X Post 2030954722350575916', 'Text'],
        id: 'x_updates:sources/usexxyyio-x-posts/2030954722350575916:chunk:0003',
        module: 'X / @useXXYYio / 2026-03',
        order_index: null,
        retrieved_at: null,
        source_type: 'x_updates',
        source_url: 'https://x.com/useXXYYio/status/2030954722350575916',
        title: 'X Post 2030954722350575916',
        tokens: ['钱包', '备注', '支持', '最多', '1', '万条'],
      },
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })]),
      },
    });

    const results = await store.retrieve('钱包备注支持最多 1 万条是哪条推文？', { topK: 2 });

    expect(results[0]?.id).toBe(
      'x_updates:sources/usexxyyio-x-posts/2030954722350575916:chunk:0003',
    );
    expect(results[0]?.metadata.sourceUrl).toBe(
      'https://x.com/useXXYYio/status/2030954722350575916',
    );
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
