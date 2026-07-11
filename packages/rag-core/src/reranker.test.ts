import { describe, expect, it } from 'vitest';

import type { RetrievedChunk } from './retrieve.js';
import { createInMemoryQualityTracer } from './quality-trace.js';
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
      score: 1,
      sourceBoost: 0.05,
      vectorScore: 0.1,
    });
    expect(results[0]?.rank).toBe(1);
  });

  it('traces bounded pre/post rerank summaries without chunk text', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const retriever = createRerankingRetriever(
      createBaseRetriever([
        createChunk({ id: 'weak-related', title: '费用说明', score: 2 }),
        createChunk({ id: 'direct-pro', title: 'XXYY Pro 权益', score: 1 }),
      ]),
      createMetadataReranker(),
      { candidateMultiplier: 4, tracer },
    );

    await retriever.retrieve('XXYY Pro secret raw question', { topK: 1 });

    expect(records).toContainEqual(
      expect.objectContaining({
        inputs: {
          candidates: [
            expect.objectContaining({ id: 'weak-related', score: 2 }),
            expect.objectContaining({ id: 'direct-pro', score: 1 }),
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

  it('prefers support-entity evidence over generic 支持 noise', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({
        id: 'generic-holder-support',
        score: 3.8,
        text: 'Holder页面会展示当前代币持有者的所有地址汇总情况，支持查看持仓量前100的所有地址。',
        title: 'Holder',
      }),
      createChunk({
        id: 'generic-wallet-support',
        score: 3.6,
        text: '钱包监控支持全链开关，开启后支持全链交易推送。',
        title: '钱包监控',
      }),
      createChunk({
        id: 'robinhood-x-post',
        score: 1.1,
        sourceType: 'x_updates',
        text: 'Robinbood 链更新 支持扫链、NOXA 内盘交易、钱包监控地址自动同步。',
        title: 'X Post robinhood',
      }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker());

    const results = await retriever.retrieve('当前支持robinhood么', { topK: 1 });

    expect(results.map((chunk) => chunk.id)).toEqual(['robinhood-x-post']);
  });

  it('prefers direct copy-trading launch evidence for short support questions', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({
        id: 'generic-trading-summary',
        score: 24,
        sourceType: 'x_updates',
        text: '支持快捷买卖、挂单、Dev Sell、自动止盈止损、一键回本、持仓页一键卖出、多钱包快捷交易、跟单交易。',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
      createChunk({
        id: 'base-single-chain-update',
        score: 23,
        sourceType: 'x_updates',
        text: 'Base 跟单、自动止盈止损、地址监控、挂单、扫链全功能满血支持。',
        title: 'X Post 2057026261667713229',
      }),
      createChunk({
        id: 'copy-trading-launch',
        score: 22,
        sourceType: 'x_updates',
        text: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链，可查看地址利润和胜率，自定义跟单金额、卖出比例、gas、滑点和过滤条件。',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker());

    const results = await retriever.retrieve('XXYY支持跟单么', { topK: 1 });

    expect(results.map((chunk) => chunk.id)).toEqual(['copy-trading-launch']);
  });

  it('prefers direct P1/P2/P3 trade-setting update evidence for natural questions', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({
        id: 'generic-trade-settings',
        score: 28,
        text: '滑点、交易模式、交易 Fee 支持自定义，设置完成后交易组件中默认使用该值。',
        title: '交易设置',
      }),
      createChunk({
        id: 'scan-page-noise',
        score: 27,
        text: '新交易对是指 Pump 项目新发射的所有项目。',
        title: '扫链页面',
      }),
      createChunk({
        id: 'p123-trade-setting-update',
        score: 24,
        sourceType: 'x_updates',
        text: '1、交易设置多档位切换 P1 P2 P3 买卖/挂单支持不同gas与滑点，灵活应对各种交易场景。',
        title: 'X Post 2026285686907883612',
      }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker());

    const results = await retriever.retrieve('P1/P2/P3 是什么交易设置？', { topK: 1 });

    expect(results.map((chunk) => chunk.id)).toEqual(['p123-trade-setting-update']);
  });

  it('prefers direct Base B20 support evidence for short entity questions', async () => {
    const baseRetriever = createBaseRetriever([
      createChunk({
        id: 'generic-trade-settings',
        score: 28,
        text: '滑点、交易模式、交易 Fee 支持自定义，设置完成后交易组件中默认使用该值。',
        title: '交易设置',
      }),
      createChunk({
        id: 'generic-base-support',
        score: 27,
        sourceType: 'x_updates',
        text: 'Base 跟单、自动止盈止损、地址监控、挂单、扫链全功能满血支持。',
        title: 'X Post 2057026261667713229',
      }),
      createChunk({
        id: 'base-b20-question',
        score: 26,
        sourceType: 'x_updates',
        text: '今晚有人一起蹲 #BASE 链的 B20 上线吗？',
        title: 'X Post 2070536322838831188',
      }),
      createChunk({
        id: 'base-b20-support',
        score: 24,
        sourceType: 'x_updates',
        text: '全面支持B20代币交易，同时在代币详情和扫链页面都增加了专属标识。',
        title: 'X Post 2070536322838831188',
      }),
    ]);
    const retriever = createRerankingRetriever(baseRetriever, createMetadataReranker(), {
      candidateMultiplier: 4,
    });

    const results = await retriever.retrieve('XXYY 是否支持 Base B20？', { topK: 1 });

    expect(results.map((chunk) => chunk.id)).toEqual(['base-b20-support']);
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
