import { describe, expect, it } from 'vitest';

import type { RetrievedChunk } from './retrieve.js';
import { createInMemoryQualityTracer } from './quality-trace.js';
import { createMetadataReranker, createRerankingRetriever, type Retriever } from './retriever.js';

describe('createRerankingRetriever', () => {
  it('keeps default retrieval order when no reranker is provided', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({ id: 'weak-related', title: '费用说明', score: 0.8 }),
      createChunk({ id: 'direct-pro', title: 'XXYY Pro 权益', score: 0.7 }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever);

    const results = await retriever.retrieve('XXYY Pro 有哪些权益？', { topK: 2 });

    expect(results.map((chunk) => chunk.id)).toEqual(['weak-related', 'direct-pro']);
  });

  it('reranks ambiguous product evidence while preserving chunk metadata and debug scores', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({ id: 'weak-related', title: '费用说明', score: 0.8 }),
      createChunk({ id: 'direct-pro', title: 'XXYY Pro 权益', score: 0.7 }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker(), {
      candidateMultiplier: 4,
    });

    const results = await retriever.retrieve('XXYY Pro 有哪些权益？', { topK: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'direct-pro',
      lexicalScore: 1,
      metadata: {
        file: 'docs/direct-pro.md',
        title: 'XXYY Pro 权益',
      },
      score: 0.7,
      sourceBoost: 0.05,
      vectorScore: 0.1,
    });
    expect(results[0]?.rank).toBe(1);
  });

  it('traces bounded pre/post rerank summaries without chunk text', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const retriever = createRerankingRetriever(
      createBaseRetriever([
        createChunk({ id: 'weak-related', title: '费用说明', score: 0.8 }),
        createChunk({ id: 'direct-pro', title: 'XXYY Pro 权益', score: 0.7 }),
      ]),
      createMetadataReranker(),
      { candidateMultiplier: 4, tracer },
    );

    await retriever.retrieve('XXYY Pro secret raw question', { topK: 1 });

    expect(records).toContainEqual(
      expect.objectContaining({
        inputs: {
          candidates: [
            expect.objectContaining({ id: 'weak-related', score: 0.8 }),
            expect.objectContaining({ id: 'direct-pro', score: 0.7 }),
          ],
          topK: 1,
        },
        name: 'rag.metadata_rerank',
        outputs: {
          chunks: [expect.objectContaining({ id: 'direct-pro', rank: 1 })],
        },
      }),
    );
    expect(JSON.stringify(records)).not.toContain('secret raw question');
    expect(JSON.stringify(records)).not.toContain('内容');
  });

  it('does not let metadata-only matches override much stronger retrieved evidence', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({
        id: 'x-post-capacity',
        module: 'X / @useXXYYio / 2026-03',
        score: 57,
        sourceType: 'x_updates',
        text: '钱包监控最多支持5000个地址。',
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
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker(), {
      candidateMultiplier: 4,
    });

    const results = await retriever.retrieve('现在钱包监控最多支持多少个地址？', { topK: 1 });

    expect(results.map((chunk) => chunk.id)).toEqual(['x-post-capacity']);
  });

  it('prefers actionable instructions over generic launch mentions for how-to questions', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({
        id: 'generic-stop-loss-summary',
        score: 0.9,
        sourceType: 'x_updates',
        text: '快速设置挂单，轻松止盈止损。',
        title: 'X Post summary',
      }),
      createChunk({
        id: 'stop-loss-launch',
        score: 0.85,
        sourceType: 'x_updates',
        text: '自动止盈止损上线啦！',
        title: 'X Post launch',
      }),
      createChunk({
        id: 'stop-loss-instructions',
        score: 0.7,
        sourceType: 'x_updates',
        text: '提前设置好条件，勾选自动止盈止损，每笔交易都能自动创建挂单。',
        title: 'X Post instructions',
      }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker());

    const results = await retriever.retrieve('我的钱包怎么设置止盈止损？', { topK: 1 });

    expect(results.map((chunk) => chunk.id)).toEqual(['stop-loss-instructions']);
  });

  it('prefers evidence that covers all dimensions of a multi-part capability question', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({
        id: 'partial-wallet-support',
        score: 24,
        text: '支持自托管钱包交易，私钥只储存在本地设备中。',
        title: '钱包安全更新',
      }),
      createChunk({
        id: 'wallet-create-and-manage',
        score: 22,
        text: '支持创建交易钱包，并可在钱包管理列表中查看和管理已经创建的钱包。',
        title: '钱包管理',
      }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker());

    const results = await retriever.retrieve('支持创建和管理交易钱包吗？', { topK: 1 });

    expect(results.map((chunk) => chunk.id)).toEqual(['wallet-create-and-manage']);
  });

  it('uses rank-based relevance so reranking is stable across provider score scales', async () => {
    const lowScale = createRerankingRetriever(
      createBaseRetriever([
        createChunk({ id: 'generic', score: 0.9, title: '产品更新' }),
        createChunk({ id: 'direct', score: 0.8, title: '扫链筛选' }),
      ]),
      createMetadataReranker(),
    );
    const highScale = createRerankingRetriever(
      createBaseRetriever([
        createChunk({ id: 'generic', score: 90, title: '产品更新' }),
        createChunk({ id: 'direct', score: 80, title: '扫链筛选' }),
      ]),
      createMetadataReranker(),
    );

    const question = '扫链筛选支持哪些条件？';

    await expect(lowScale.retrieve(question, { topK: 1 })).resolves.toMatchObject([
      { id: 'direct' },
    ]);
    await expect(highScale.retrieve(question, { topK: 1 })).resolves.toMatchObject([
      { id: 'direct' },
    ]);
  });
});

function createBaseRetriever(chunks: RetrievedChunk[]): Retriever {
  return {
    retrieve(_question, options) {
      return chunks.slice(0, options.topK).map((chunk, index) => ({ ...chunk, rank: index + 1 }));
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
