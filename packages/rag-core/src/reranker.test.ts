import { describe, expect, it } from 'vitest';

import type { RetrievedChunk } from './retrieve.js';
import { createMetadataReranker, createRerankingRetriever, type Retriever } from './retriever.js';

describe('createRerankingRetriever', () => {
  it('keeps default retrieval order when no reranker is provided', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({ id: 'weak-related', title: '费用说明', score: 2 }),
      createChunk({ id: 'direct-pro', title: 'XXYY Pro 权益', score: 1 }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever);

    const results = await retriever.retrieve('XXYY Pro 有哪些权益？', { topK: 2 });

    expect(results.map((chunk) => chunk.id)).toEqual(['weak-related', 'direct-pro']);
  });

  it('reranks ambiguous product evidence while preserving chunk metadata and debug scores', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({ id: 'weak-related', title: '费用说明', score: 2 }),
      createChunk({ id: 'direct-pro', title: 'XXYY Pro 权益', score: 1 }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker());

    const results = await retriever.retrieve('XXYY Pro 有哪些权益？', { topK: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'direct-pro',
      lexicalScore: 1,
      metadata: {
        file: 'docs/direct-pro.md',
        title: 'XXYY Pro 权益',
      },
      score: 1,
      sourceBoost: 0.05,
      vectorScore: 0.1,
    });
    expect(results[0]?.rank).toBe(1);
  });
});

function createBaseRetriever(chunks: RetrievedChunk[]): Retriever {
  return {
    retrieve(_question, options) {
      return chunks.slice(0, options.topK);
    },
  };
}

function createChunk(input: { id: string; title: string; score: number }): RetrievedChunk {
  return {
    documentId: input.id,
    embedding: [],
    id: input.id,
    lexicalScore: 1,
    metadata: {
      file: `docs/${input.id}.md`,
      headingPath: [input.title],
      module: input.title,
      sourceType: 'official_docs',
      title: input.title,
    },
    rank: 0,
    score: input.score,
    sourceBoost: 0.05,
    text: `${input.title} 内容。`,
    tokens: [],
    vectorScore: 0.1,
  };
}
