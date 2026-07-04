import { describe, expect, it, vi } from 'vitest';

import type { ChatResponse, RagIndex } from '@xxyy/shared';
import type { AnswerProvider, RetrievedChunk, Retriever } from '@xxyy/rag-core';

import { createToolRegistry } from '../tool-registry.js';
import {
  PRODUCT_TOOL_NAMES,
  answerProductQuestionInputSchema,
  createProductTools,
  searchProductDocsInputSchema,
} from './product-tools.js';

describe('createProductTools', () => {
  it('exports the product tool names in registration order', () => {
    expect(PRODUCT_TOOL_NAMES).toEqual(['search_product_docs', 'answer_product_question']);
  });

  it('registers search_product_docs and returns chunks, citations, and confidence for a Telegram docs question', async () => {
    const registry = createToolRegistry();

    for (const tool of createProductTools({ config: { topK: 1 }, index: createRagIndex() })) {
      registry.register(tool);
    }

    const result = (await registry.execute('search_product_docs', {
      query: 'Telegram 通知如何配置？',
    })) as { chunks: unknown[]; confidence: number };

    expect(result).toMatchObject({
      citations: [
        {
          file: 'docs/product-features/telegram.md',
          sourceUrl: 'https://docs.xxyy.io/telegram',
          title: 'Telegram 通知',
        },
      ],
      chunks: [
        {
          id: 'telegram-setup',
          metadata: {
            title: 'Telegram 通知',
          },
          rank: 1,
        },
      ],
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('keeps search_product_docs chunks free of internal index artifacts', async () => {
    const registry = createToolRegistry();

    for (const tool of createProductTools({ config: { topK: 1 }, index: createRagIndex() })) {
      registry.register(tool);
    }

    const result = (await registry.execute('search_product_docs', {
      query: 'Telegram 通知如何配置？',
    })) as { chunks: Array<Record<string, unknown>> };

    expect(result.chunks[0]).not.toHaveProperty('embedding');
    expect(result.chunks[0]).not.toHaveProperty('tokens');
    expect(result.chunks[0]).toHaveProperty('sourceBoost');
  });

  it('rejects blank product tool inputs at the schema boundary', () => {
    expect(searchProductDocsInputSchema.safeParse({ query: '' }).success).toBe(false);
    expect(searchProductDocsInputSchema.safeParse({ query: '   ' }).success).toBe(false);
    expect(answerProductQuestionInputSchema.safeParse({ question: '' }).success).toBe(false);
    expect(answerProductQuestionInputSchema.safeParse({ question: '   ' }).success).toBe(false);
  });

  it('answers a product question through an injected AnswerProvider with retrieved chunks', async () => {
    const registry = createToolRegistry();
    const answerProvider: AnswerProvider = {
      answer(input) {
        const response: ChatResponse = {
          answer: `retrieved ${input.retrievedChunks.length} chunks`,
          citations: [],
          confidence: 0.73,
          intent: input.classification.intent,
        };
        return Promise.resolve(response);
      },
    };

    for (const tool of createProductTools({
      answerProvider,
      config: { topK: 2 },
      index: createRagIndex(),
    })) {
      registry.register(tool);
    }

    await expect(
      registry.execute('answer_product_question', {
        channel: 'agent',
        question: 'XXYY Pro 有哪些权益？',
      }),
    ).resolves.toEqual({
      answer: 'retrieved 2 chunks',
      citations: [],
      confidence: 0.73,
      intent: 'product_qa',
    });
  });

  it('trusts planner-selected product questions even when deterministic classification is unknown', async () => {
    const registry = createToolRegistry();
    const retrieve = vi.fn<Retriever['retrieve']>(() => [
      createRetrievedChunk({
        text: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
      }),
    ]);
    const answer = vi.fn<AnswerProvider['answer']>((input) =>
      Promise.resolve({
        answer: `intent ${input.classification.intent}; chunks ${input.retrievedChunks.length}`,
        citations: [],
        confidence: input.classification.confidence,
        intent: input.classification.intent,
      }),
    );

    for (const tool of createProductTools({
      answerProvider: { answer },
      retriever: { retrieve },
    })) {
      registry.register(tool);
    }

    await expect(
      registry.execute('answer_product_question', {
        channel: 'agent',
        question: '支持跟单么',
      }),
    ).resolves.toMatchObject({
      answer: 'intent product_qa; chunks 1',
      intent: 'product_qa',
    });
    expect(retrieve).toHaveBeenCalledWith('支持跟单么', { topK: 6 });
    const answerInput = answer.mock.calls[0]?.[0];
    expect(answerInput).toBeDefined();
    expect(answerInput?.classification).toMatchObject({
      intent: 'product_qa',
      reason: 'planner selected product answer tool',
    });
    expect(answerInput?.question).toBe('支持跟单么');
  });

  it('keeps realtime account lookups blocked even when planner selects answer_product_question', async () => {
    const registry = createToolRegistry();
    const retrieve = vi.fn<Retriever['retrieve']>(() => [createRetrievedChunk()]);
    const answer = vi.fn<AnswerProvider['answer']>((input) =>
      Promise.resolve({
        answer: `planner routed ${input.classification.intent}`,
        citations: [],
        confidence: input.classification.confidence,
        intent: input.classification.intent,
      }),
    );

    for (const tool of createProductTools({
      answerProvider: { answer },
      retriever: { retrieve },
    })) {
      registry.register(tool);
    }

    const result = (await registry.execute('answer_product_question', {
      question: '帮我查一下钱包余额',
    })) as ChatResponse;

    expect(result.answer).toContain('我不能直接查询你的钱包余额');
    expect(result).toMatchObject({
      citations: [],
      intent: 'realtime_account_query',
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it('keeps investment advice blocked even when planner selects answer_product_question', async () => {
    const registry = createToolRegistry();
    const retrieve = vi.fn<Retriever['retrieve']>(() => [createRetrievedChunk()]);
    const answer = vi.fn<AnswerProvider['answer']>();

    for (const tool of createProductTools({
      answerProvider: { answer },
      retriever: { retrieve },
    })) {
      registry.register(tool);
    }

    const result = (await registry.execute('answer_product_question', {
      question: '现在可以买 SOL 吗，推荐一个能保证盈利的 token',
    })) as ChatResponse;

    expect(result.answer).toContain('我不能提供买卖建议');
    expect(result).toMatchObject({
      citations: [],
      intent: 'investment_advice',
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it('normalizes citation file paths, truncates excerpts, and limits citations for search results', async () => {
    const registry = createToolRegistry();
    const longText = `第一段\n\n${'很长的产品说明 '.repeat(40)}`;
    const retrieve = vi.fn<Retriever['retrieve']>(() =>
      Array.from({ length: 4 }, (_, index) =>
        createRetrievedChunk({
          id: `chunk-${index + 1}`,
          text: longText,
        }),
      ),
    );

    for (const tool of createProductTools({ retriever: { retrieve } })) {
      registry.register(tool);
    }

    const result = (await registry.execute('search_product_docs', {
      query: 'XXYY Pro 权益',
    })) as { citations: Array<{ excerpt: string; file: string }> };

    expect(result.citations).toHaveLength(3);
    expect(result.citations[0]?.file).toBe('docs/pro.md');
    expect(result.citations[0]?.excerpt).toHaveLength(220);
    expect(result.citations[0]?.excerpt).toMatch(/…$/u);
    expect(result.citations[0]?.excerpt).not.toMatch(/\s{2,}|\n/u);
  });

  it('caps externally supplied search topK before calling the retriever', async () => {
    const registry = createToolRegistry();
    const retrieve = vi.fn<Retriever['retrieve']>(() => []);

    for (const tool of createProductTools({ config: { topK: 99 }, retriever: { retrieve } })) {
      registry.register(tool);
    }

    await registry.execute('search_product_docs', {
      query: 'XXYY Pro 权益',
      topK: 999,
    });

    expect(retrieve).toHaveBeenCalledWith('XXYY Pro 权益', { topK: 20 });
  });
});

function createRetrievedChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  const base: RetrievedChunk = {
    documentId: 'pro',
    embedding: [],
    id: 'chunk',
    lexicalScore: 1,
    metadata: {
      file: '/Users/17a/projects/xxyy-ask/docs/pro.md',
      headingPath: ['XXYY Pro'],
      module: 'Pro',
      sourceType: 'official_docs',
      title: 'XXYY Pro',
    },
    rank: 1,
    score: 2,
    sourceBoost: 0.05,
    text: 'XXYY Pro 产品说明',
    tokens: [],
    vectorScore: 1,
  };

  return {
    ...base,
    ...overrides,
    metadata: {
      ...base.metadata,
      ...overrides.metadata,
    },
  };
}

function createRagIndex(): RagIndex {
  return {
    builtAt: '2026-06-16T00:00:00.000Z',
    entries: [
      {
        documentId: 'telegram',
        embedding: [],
        id: 'telegram-setup',
        metadata: {
          file: 'docs/product-features/telegram.md',
          headingPath: ['Telegram 通知', '配置步骤'],
          module: '通知',
          sourceType: 'official_docs',
          sourceUrl: 'https://docs.xxyy.io/telegram',
          title: 'Telegram 通知',
        },
        text: 'Telegram 通知可以在 XXYY 内配置，用于接收产品提醒和监控消息。',
        tokens: ['telegram', '通知', '通', '知', '配置', '配', '置', '提醒', '监控', 'xxyy'],
      },
      {
        documentId: 'pro',
        embedding: [],
        id: 'pro-benefits',
        metadata: {
          file: 'docs/product-features/pro.md',
          headingPath: ['XXYY Pro', '权益'],
          module: 'Pro',
          sourceType: 'official_docs',
          title: 'XXYY Pro 权益',
        },
        text: 'XXYY Pro 提供更高监控上限、钱包备注和高级提醒权益。',
        tokens: ['xxyy', 'pro', '权益', '权', '益', '监控', '上限', '钱包', '备注'],
      },
      {
        documentId: 'pro',
        embedding: [],
        id: 'pro-limits',
        metadata: {
          file: 'docs/product-features/pro.md',
          headingPath: ['XXYY Pro', '监控上限'],
          module: 'Pro',
          sourceType: 'official_docs',
          title: 'XXYY Pro 监控上限',
        },
        text: 'XXYY Pro 用户可以获得更多关注钱包和监控数量。',
        tokens: ['xxyy', 'pro', '监控', '上限', '权益', '钱包', '数量'],
      },
    ],
    version: 1,
  };
}
