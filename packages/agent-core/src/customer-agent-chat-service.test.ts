import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatResponse } from '@xxyy/shared';
import {
  LlmConfigurationError,
  type AnswerProvider,
  type RetrievedChunk,
  type Retriever,
} from '@xxyy/rag-core';

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

  it('lets the planner answer boundary-like questions without touching product retrieval', async () => {
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
          reason: 'The planner cannot access private account data.',
          response: {
            answer: '我无法直接查询你的钱包余额，但可以说明 XXYY 产品里的相关入口。',
            citations: [],
            confidence: 0.7,
            intent: 'realtime_account_query',
          },
          route: 'boundary',
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
      agentRoute: 'boundary',
      answer: '我无法直接查询你的钱包余额，但可以说明 XXYY 产品里的相关入口。',
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

  it('requires LLM planner config instead of falling back to local product routing', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;

    const service = createCustomerAgentChatService({
      answerProvider: {
        answer() {
          throw new Error('answer provider should not be called');
        },
      },
      config: { topK: 2 },
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
    ).rejects.toBeInstanceOf(LlmConfigurationError);
  });

  it('requires LLM planner config instead of falling back to local transaction routing', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;

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
      txAnalysisProvider: {
        analyze() {
          throw new Error('tx analysis provider should not be called');
        },
      },
    });

    await expect(
      service.ask({
        channel: 'web',
        message: `帮我分析 0x${'a'.repeat(64)} 有没有被夹`,
      }),
    ).rejects.toBeInstanceOf(LlmConfigurationError);
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

  it('lets the LLM planner choose product tools for short feature questions', async () => {
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
                    input: { channel: 'web', question: '支持跟单么' },
                    kind: 'tool',
                    reason: 'The user asks whether an XXYY feature is supported.',
                    route: 'product_answer',
                    toolName: 'answer_product_question',
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
    const retrieve = vi.fn<Retriever['retrieve']>(() => [
      createRetrievedChunk({
        text: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
      }),
    ]);
    const answer = vi.fn<AnswerProvider['answer']>((input) =>
      Promise.resolve({
        answer: `planner answered ${input.question} with ${input.retrievedChunks.length} chunks`,
        citations: [],
        confidence: 0.81,
        intent: input.classification.intent,
      }),
    );

    const service = createCustomerAgentChatService({
      answerProvider: { answer },
      config: { topK: 1 },
      retriever: { retrieve },
      txAnalysisProvider: undefined,
    });

    await expect(
      service.ask({
        channel: 'web',
        message: '支持跟单么',
      }),
    ).resolves.toMatchObject({
      agentRoute: 'product_answer',
      answer: 'planner answered 支持跟单么 with 1 chunks',
      confidence: 0.81,
      intent: 'product_qa',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledWith('支持跟单么', { topK: 1 });
    const answerInput = answer.mock.calls[0]?.[0];
    expect(answerInput).toBeDefined();
    expect(answerInput?.classification).toMatchObject({
      intent: 'product_qa',
      reason: 'planner selected product answer tool',
    });
  });
});

function createRetrievedChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  const base: RetrievedChunk = {
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

  return {
    ...base,
    ...overrides,
    metadata: {
      ...base.metadata,
      ...overrides.metadata,
    },
  };
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
