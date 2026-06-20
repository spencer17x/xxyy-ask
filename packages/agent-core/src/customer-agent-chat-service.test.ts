import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatResponse } from '@xxyy/shared';
import type { AnswerProvider, RetrievedChunk, Retriever, TxAnalysisProvider } from '@xxyy/rag-core';

import { createCustomerAgentChatService } from './customer-agent-chat-service.js';
import { createScriptedPlannerModel } from './planner-model.js';

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
const originalOpenAiModel = process.env.OPENAI_MODEL;

describe('createCustomerAgentChatService', () => {
  afterEach(() => {
    restoreEnvValue('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnvValue('OPENAI_BASE_URL', originalOpenAiBaseUrl);
    restoreEnvValue('OPENAI_MODEL', originalOpenAiModel);
    vi.unstubAllGlobals();
  });

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
          citations: [
            {
              excerpt: input.retrievedChunks[0]?.text ?? '',
              file: input.retrievedChunks[0]?.metadata.file ?? '',
              title: input.retrievedChunks[0]?.metadata.title ?? '',
            },
          ],
          confidence: 0.82,
          intent: input.classification.intent,
        };
        return Promise.resolve(response);
      },
    };

    const service = createCustomerAgentChatService({
      answerProvider,
      config: { topK: 1 },
      planner: createScriptedPlannerModel([
        {
          input: { channel: 'web', question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
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
      planner: createScriptedPlannerModel([
        {
          kind: 'final',
          reason: 'Boundary guard should answer before this plan is used.',
          response: {
            answer: 'planner should not be called',
            citations: [],
            confidence: 0,
            intent: 'unknown',
          },
          route: 'clarify',
        },
      ]),
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

  it('keeps deprecated session context from affecting single-run planning', async () => {
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
    const service = createCustomerAgentChatService({
      answerProvider,
      audit: {},
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
        {
          input: { question: '怎么升级？' },
          kind: 'tool',
          reason: 'Use the current user message only.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      qualitySignals: {},
      retriever,
      sessionContext: {},
      txAnalysisProvider: undefined,
    });

    await service.ask({ channel: 'web', message: 'XXYY Pro 有哪些权益？', sessionId: 's1' });
    await service.ask({ channel: 'web', message: '怎么升级？', sessionId: 's1' });

    expect(retrieveCalls.at(-1)).toBe('怎么升级？');
  });

  it('uses local first-slice routing for product questions without OpenAI planner config', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;
    const retrieveCalls: Array<{ question: string; topK: number | undefined }> = [];
    const retriever: Retriever = {
      retrieve(question, options) {
        retrieveCalls.push({ question, topK: options.topK });
        return [createRetrievedChunk()];
      },
    };
    const answerProvider: AnswerProvider = {
      answer(input) {
        return Promise.resolve({
          answer: `fallback answered ${input.question}`,
          citations: [],
          confidence: 0.88,
          intent: input.classification.intent,
        });
      },
    };

    const service = createCustomerAgentChatService({
      answerProvider,
      config: { topK: 2 },
      retriever,
      txAnalysisProvider: undefined,
    });

    await expect(
      service.ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      }),
    ).resolves.toMatchObject({
      agentRoute: 'product_answer',
      answer: 'fallback answered XXYY Pro 有哪些权益？',
      confidence: 0.88,
      intent: 'product_qa',
    });
    expect(retrieveCalls).toEqual([{ question: 'XXYY Pro 有哪些权益？', topK: 2 }]);
  });

  it('uses local first-slice routing to clarify multiple transaction hashes', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;
    const firstTxHash = `0x${'a'.repeat(64)}`;
    const secondTxHash = `0x${'b'.repeat(64)}`;
    const txAnalysisProvider: TxAnalysisProvider = {
      analyze() {
        throw new Error('tx analysis provider should not be called');
      },
    };

    const service = createCustomerAgentChatService({
      answerProvider: {
        answer() {
          throw new Error('answer provider should not be called');
        },
      },
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
      txAnalysisProvider,
    });

    const response = await service.ask({
      channel: 'web',
      message: `帮我分析 ${firstTxHash} 和 ${secondTxHash} 有没有被夹`,
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      confidence: 0.55,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('一次只能分析一笔交易');
  });

  it('uses passed config values when creating the default planner', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    process.env.OPENAI_BASE_URL = 'https://env.example/v1';
    process.env.OPENAI_MODEL = 'env-model';
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    kind: 'final',
                    reason: 'test planner response',
                    response: {
                      answer: '请补充更具体的问题。',
                      citations: [],
                      confidence: 0.45,
                      intent: 'unknown',
                    },
                    route: 'clarify',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const service = createCustomerAgentChatService({
      answerProvider: {
        answer() {
          throw new Error('answer provider should not be called');
        },
      },
      config: {
        databaseUrl: 'postgres://xxyy:test@localhost:5432/xxyy_ask',
        openAiApiKey: 'config-key',
        openAiBaseUrl: 'https://config.example/v1',
        openAiModel: 'config-model',
      },
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
      txAnalysisProvider: undefined,
    });

    await expect(
      service.ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      }),
    ).resolves.toMatchObject({
      agentRoute: 'clarify',
      intent: 'unknown',
    });

    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe('https://config.example/v1/chat/completions');
    const init = call?.[1];
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer config-key',
    });
    expect(typeof init?.body).toBe('string');
    const requestBody = JSON.parse(init?.body as string) as { model?: unknown };
    expect(requestBody.model).toBe('config-model');
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

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
