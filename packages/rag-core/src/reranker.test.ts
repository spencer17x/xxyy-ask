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

  it('does not let metadata-only matches override much stronger retrieved evidence', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({
        id: 'x-post-capacity',
        module: 'X / @useXXYYio / 2026-03',
        score: 57,
        sourceType: 'x_updates',
        title: 'X Post 2031333475010355227',
      }),
      createChunk({
        id: 'official-wallet-monitor',
        score: 36,
        title: '钱包监控',
      }),
      createChunk({
        id: 'x-summary',
        module: 'X Updates',
        score: 35,
        sourceType: 'x_updates',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker());

    const results = await retriever.retrieve('现在钱包监控最多支持多少个地址？', { topK: 1 });

    expect(results.map((chunk) => chunk.id)).toEqual(['x-post-capacity']);
  });

  it('prefers broad chain coverage evidence for supported-chain questions', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({
        id: 'eth-single-chain-update',
        score: 24,
        sourceType: 'x_updates',
        text: '支持 ETH 链跟单聪明钱包。',
        title: 'X Post 2046851115644494085',
      }),
      createChunk({
        id: 'base-single-chain-update',
        score: 21,
        sourceType: 'x_updates',
        text: 'Base 跟单、自动止盈止损、地址监控全功能支持。',
        title: 'X Post 2057026261667713229',
      }),
      createChunk({
        id: 'six-chain-copy-trading',
        score: 19,
        sourceType: 'x_updates',
        text: '支持6大公链，#SOL #BSC #Base #ETH #XLayer #Plasma，输入地址即可判断是否值得跟单。',
        title: 'X Post 2029522365408067746',
      }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker());

    const results = await retriever.retrieve('XXYY 跟单支持哪些链？', { topK: 1 });

    expect(results.map((chunk) => chunk.id)).toEqual(['six-chain-copy-trading']);
  });
});

function createBaseRetriever(chunks: RetrievedChunk[]): Retriever {
  return {
    retrieve(_question, options) {
      return chunks.slice(0, options.topK);
    },
  };
}

function createChunk(input: {
  id: string;
  module?: string;
  score: number;
  sourceType?: RetrievedChunk['metadata']['sourceType'];
  text?: string;
  title: string;
}): RetrievedChunk {
  const text = input.text ?? `${input.title} 内容。`;
  return {
    documentId: input.id,
    embedding: [],
    id: input.id,
    lexicalScore: 1,
    metadata: {
      file: `docs/${input.id}.md`,
      headingPath: [input.title],
      module: input.module ?? input.title,
      sourceType: input.sourceType ?? 'official_docs',
      title: input.title,
    },
    rank: 0,
    score: input.score,
    sourceBoost: 0.05,
    text,
    tokens: [],
    vectorScore: 0.1,
  };
}
