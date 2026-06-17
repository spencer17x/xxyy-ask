import { describe, expect, it } from 'vitest';

import type { ChatResponse } from '@xxyy/shared';
import type { AnswerProvider, RetrievedChunk } from '@xxyy/rag-core';

import { createProductQaToolHandlers } from './tools.js';

describe('product QA MCP tool handlers', () => {
  it('searches product docs through the configured retriever', async () => {
    const retrieveCalls: unknown[] = [];
    const handlers = createProductQaToolHandlers({
      config: { topK: 2 },
      retriever: {
        retrieve(question, options) {
          retrieveCalls.push({ question, options });
          return [createRetrievedChunk()];
        },
      },
    });

    await expect(
      handlers.searchProductDocs({ query: 'Telegram 通知如何配置？' }),
    ).resolves.toMatchObject({
      chunks: [{ id: 'telegram-setup' }],
      citations: [{ title: 'Telegram 通知' }],
    });
    expect(retrieveCalls).toEqual([
      {
        options: { topK: 2 },
        question: 'Telegram 通知如何配置？',
      },
    ]);
  });

  it('answers product questions through the configured AnswerProvider', async () => {
    const answerProvider: AnswerProvider = {
      answer(input) {
        const response: ChatResponse = {
          answer: `answered ${input.question}`,
          citations: [],
          confidence: 0.76,
          intent: input.classification.intent,
        };
        return Promise.resolve(response);
      },
    };
    const handlers = createProductQaToolHandlers({
      answerProvider,
      retriever: {
        retrieve() {
          return [createRetrievedChunk()];
        },
      },
    });

    await expect(
      handlers.answerProductQuestion({
        channel: 'agent',
        question: 'XXYY Pro 有哪些权益？',
      }),
    ).resolves.toMatchObject({
      answer: 'answered XXYY Pro 有哪些权益？',
      confidence: 0.76,
      intent: 'product_qa',
    });
  });
});

function createRetrievedChunk(): RetrievedChunk {
  return {
    documentId: 'telegram',
    embedding: [],
    id: 'telegram-setup',
    lexicalScore: 1,
    metadata: {
      file: 'docs/product-features/telegram.md',
      headingPath: ['Telegram 通知'],
      module: '通知',
      sourceType: 'official_docs',
      sourceUrl: 'https://docs.xxyy.io/telegram',
      title: 'Telegram 通知',
    },
    rank: 1,
    score: 1,
    text: 'Telegram 通知可以在 XXYY 内配置。',
    tokens: [],
    vectorScore: 0,
  };
}
