import { describe, expect, it } from 'vitest';

import type { ChatResponse } from '@xxyy/shared';
import type { AnswerProvider, RetrievedChunk, Retriever } from '@xxyy/rag-core';

import { createCustomerAgentChatService } from './customer-agent-chat-service.js';
import { createInMemorySessionContextStore } from './session-context.js';

describe('createCustomerAgentChatService', () => {
  it('answers product questions through registered product tools', async () => {
    const retrieveCalls: Array<{ question: string; topK: number | undefined }> = [];
    const retriever: Retriever = {
      retrieve(question, options) {
        retrieveCalls.push({ question, topK: options.topK });
        return [createRetrievedChunk()];
      },
    };
    const answerProvider: AnswerProvider = {
      answer(input) {
        const response: ChatResponse = {
          answer: `agent answered with ${input.retrievedChunks.length} chunk`,
          citations: [],
          confidence: 0.82,
          intent: input.classification.intent,
        };
        return Promise.resolve(response);
      },
    };

    const service = createCustomerAgentChatService({
      answerProvider,
      config: { topK: 1 },
      retriever,
      txAnalysisProvider: undefined,
    });

    await expect(
      service.ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      }),
    ).resolves.toMatchObject({
      answer: 'agent answered with 1 chunk',
      confidence: 0.82,
      intent: 'product_qa',
    });
    expect(retrieveCalls).toEqual([{ question: 'XXYY Pro 有哪些权益？', topK: 1 }]);
  });

  it('keeps boundary questions inside the runtime without touching retriever or answer provider', async () => {
    const retriever: Retriever = {
      retrieve() {
        throw new Error('retriever should not be called');
      },
    };
    const answerProvider: AnswerProvider = {
      answer() {
        throw new Error('answer provider should not be called');
      },
    };

    const service = createCustomerAgentChatService({
      answerProvider,
      retriever,
      txAnalysisProvider: undefined,
    });

    await expect(
      service.ask({
        channel: 'cli',
        message: '帮我查一下钱包余额',
      }),
    ).resolves.toMatchObject({
      citations: [],
      intent: 'realtime_account_query',
    });
  });

  it('passes optional session context through the customer agent runtime', async () => {
    const retrieveCalls: string[] = [];
    const retriever: Retriever = {
      retrieve(question) {
        retrieveCalls.push(question);
        return [createRetrievedChunk()];
      },
    };
    const answerProvider: AnswerProvider = {
      answer(input) {
        return Promise.resolve({
          answer: `answered ${input.question}`,
          citations: [],
          confidence: 0.9,
          intent: input.classification.intent,
        });
      },
    };
    const sessionContext = createInMemorySessionContextStore();
    const service = createCustomerAgentChatService({
      answerProvider,
      retriever,
      sessionContext,
      txAnalysisProvider: undefined,
    });

    await service.ask({ channel: 'web', message: 'XXYY Pro 有哪些权益？', sessionId: 's1' });
    await service.ask({ channel: 'web', message: '怎么升级？', sessionId: 's1' });

    expect(retrieveCalls.at(-1)).toBe('XXYY Pro 怎么升级？');
  });
});

function createRetrievedChunk(): RetrievedChunk {
  return {
    documentId: 'pro',
    embedding: [],
    id: 'pro-benefits',
    lexicalScore: 1,
    metadata: {
      file: 'docs/product-features/pro.md',
      headingPath: ['XXYY Pro'],
      module: 'Pro',
      sourceType: 'official_docs',
      title: 'XXYY Pro 权益',
    },
    rank: 1,
    score: 1,
    text: 'XXYY Pro 提供更多权益。',
    tokens: [],
    vectorScore: 0,
  };
}
