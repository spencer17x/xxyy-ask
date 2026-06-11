import { describe, expect, it } from 'vitest';

import type { ChatResponse, ChatStreamEvent } from '@xxyy/shared';

import type { AnswerProvider } from './answer-provider.js';
import { createChatService } from './chat-service.js';
import { createFixtureIndex } from './test-fixtures.js';
import type { TxAnalysisProvider } from './tx-analysis.js';
import { TxAnalysisProviderUnavailableError } from './tx-analysis.js';

describe('createChatService', () => {
  it('classifies, retrieves, and delegates grounded product questions to the answer provider', async () => {
    const calls: string[] = [];
    const answerProvider: AnswerProvider = {
      answer({ question, retrievedChunks }) {
        calls.push(question);
        const response: ChatResponse = {
          answer: '可以通过 Telegram 钱包监控页面设置提醒。',
          citations: retrievedChunks.map((chunk) => ({
            excerpt: chunk.text,
            file: 'docs/telegram.md',
            title: chunk.metadata.title,
          })),
          confidence: 0.88,
          intent: 'how_to',
        };
        return Promise.resolve(response);
      },
    };
    const service = createChatService({
      answerProvider,
      config: { topK: 1 },
      index: createFixtureIndex([
        {
          id: 'official_docs:telegram:chunk:0001',
          title: 'Telegram 钱包监控',
          sourceType: 'official_docs',
          file: '/docs/telegram.md',
          text: 'XXYY 支持通过 Telegram 设置钱包监控提醒。',
        },
      ]),
    });

    const response = await service.ask({
      channel: 'web',
      message: '如何设置 Telegram 钱包监控？',
      sessionId: 'session-1',
    });

    expect(response.intent).toBe('how_to');
    expect(response.answer).toContain('Telegram 钱包监控');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.file).toBe('docs/telegram.md');
    expect(calls).toEqual(['如何设置 Telegram 钱包监控？']);
  });

  it('does not retrieve factual answers for realtime account lookup requests', async () => {
    const service = createChatService({
      index: createFixtureIndex([
        {
          id: 'official_docs:wallet:chunk:0001',
          title: '钱包余额',
          sourceType: 'official_docs',
          text: '你的钱包余额是 100 SOL。',
        },
      ]),
    });

    const response = await service.ask({
      channel: 'cli',
      message: '帮我查一下钱包余额',
    });

    expect(response.intent).toBe('realtime_account_query');
    expect(response.answer).not.toContain('100 SOL');
    expect(response.citations).toEqual([]);
  });

  it('routes transaction hash sandwich detection to the transaction analysis provider', async () => {
    const analyzedHashes: string[] = [];
    const txAnalysisProvider: TxAnalysisProvider = {
      analyze(reference) {
        analyzedHashes.push(reference.txHash);
        return Promise.resolve({
          analyzedAt: '2026-06-10T00:00:00.000Z',
          chain: reference.chain,
          confidence: 0.77,
          evidence: [
            {
              detail: '测试 provider 发现前后交易模式。',
              label: '前后交易模式',
              severity: 'warning',
            },
          ],
          relatedTransactions: [],
          screenshotUrl: '/assets/tx-analysis-fixture.svg',
          summary: '测试 provider：疑似存在 sandwich 模式。',
          txHash: reference.txHash,
          verdict: 'sandwiched',
        });
      },
    };
    const service = createChatService({
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
      message:
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 这个交易是不是被夹了？',
    });

    expect(response.intent).toBe('tx_sandwich_detection');
    expect(response.answer).toContain('疑似被夹');
    expect(response.attachments?.[0]).toMatchObject({
      kind: 'image',
      url: '/assets/tx-analysis-fixture.svg',
    });
    expect(analyzedHashes).toEqual([
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    ]);
  });

  it('uses an async retriever for grounded product questions', async () => {
    const retrievedQuestions: string[] = [];
    const answerProvider: AnswerProvider = {
      answer({ retrievedChunks }) {
        return Promise.resolve({
          answer: 'XXYY Pro 支持 Telegram 钱包监控。',
          citations: retrievedChunks.map((chunk) => ({
            excerpt: chunk.text,
            file: chunk.metadata.file,
            title: chunk.metadata.title,
          })),
          confidence: 0.9,
          intent: 'product_qa',
        });
      },
    };
    const service = createChatService({
      answerProvider,
      retriever: {
        retrieve(question) {
          retrievedQuestions.push(question);
          const fixtureEntry = createFixtureIndex([
            {
              id: 'official_docs:pro:chunk:0001',
              title: 'XXYY Pro 权益',
              sourceType: 'official_docs',
              file: 'docs/pro.md',
              text: 'XXYY Pro 支持 Telegram 钱包监控。',
            },
          ]).entries[0];
          if (fixtureEntry === undefined) {
            throw new Error('Expected fixture entry to exist');
          }

          return Promise.resolve([
            {
              ...fixtureEntry,
              lexicalScore: 1,
              rank: 1,
              score: 1,
              vectorScore: 1,
            },
          ]);
        },
      },
    });

    const response = await service.ask({
      channel: 'web',
      message: 'XXYY Pro 支持什么？',
    });

    expect(response.citations).toHaveLength(1);
    expect(retrievedQuestions).toEqual(['XXYY Pro 支持什么？']);
  });

  it('streams grounded product questions through the answer provider', async () => {
    const streamedQuestions: string[] = [];
    const answerProvider: AnswerProvider = {
      answer() {
        throw new Error('answer should not be used for streamed requests');
      },
      async *stream({ question, retrievedChunks }) {
        await Promise.resolve();
        streamedQuestions.push(question);
        yield { type: 'answer_delta', delta: 'XXYY Pro' };
        yield { type: 'answer_delta', delta: ' 支持提醒。' };
        yield {
          type: 'metadata',
          citations: retrievedChunks.map((chunk) => ({
            excerpt: chunk.text,
            file: chunk.metadata.file,
            title: chunk.metadata.title,
          })),
          confidence: 0.9,
          intent: 'product_qa',
        };
      },
    };
    const service = createChatService({
      answerProvider,
      index: createFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro 权益',
          sourceType: 'official_docs',
          file: 'docs/pro.md',
          text: 'XXYY Pro 支持 Telegram 钱包监控。',
        },
      ]),
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of service.stream({
      channel: 'web',
      message: 'XXYY Pro 支持什么？',
    })) {
      events.push(event);
    }

    expect(streamedQuestions).toEqual(['XXYY Pro 支持什么？']);
    expect(events.slice(0, 2)).toEqual([
      { type: 'answer_delta', delta: 'XXYY Pro' },
      { type: 'answer_delta', delta: ' 支持提醒。' },
    ]);
    const metadata = events[2];
    expect(metadata?.type).toBe('metadata');
    if (metadata?.type !== 'metadata') {
      throw new Error('Expected metadata event');
    }
    expect(metadata.citations).toHaveLength(1);
    expect(metadata.confidence).toBe(0.9);
    expect(metadata.intent).toBe('product_qa');
  });

  it('streams fixed boundary responses without retrieval', async () => {
    const service = createChatService({
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of service.stream({
      channel: 'web',
      message: '帮我查一下钱包余额',
    })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      type: 'answer_delta',
    });
    expect(events.at(-1)).toMatchObject({
      citations: [],
      intent: 'realtime_account_query',
      type: 'metadata',
    });
  });

  it('streams transaction analysis responses with metadata attachments', async () => {
    const service = createChatService({
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
      txAnalysisProvider: {
        analyze(reference) {
          return Promise.resolve({
            analyzedAt: '2026-06-10T00:00:00.000Z',
            chain: reference.chain,
            confidence: 0.71,
            evidence: [],
            relatedTransactions: [],
            screenshotUrl: '/assets/tx-analysis-fixture.svg',
            summary: '演示数据：当前无法确认是否被夹。',
            txHash: reference.txHash,
            verdict: 'inconclusive',
          });
        },
      },
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of service.stream({
      channel: 'web',
      message: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      type: 'answer_delta',
    });
    expect(events.at(-1)).toMatchObject({
      attachments: [
        {
          kind: 'image',
          url: '/assets/tx-analysis-fixture.svg',
        },
      ],
      citations: [],
      intent: 'tx_sandwich_detection',
      type: 'metadata',
    });
  });

  it('can enable the fixture transaction analysis provider through config', async () => {
    const service = createChatService({
      config: { txAnalysisProvider: 'mock' },
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });

    const response = await service.ask({
      channel: 'web',
      message: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 被夹了吗？',
    });

    expect(response.intent).toBe('tx_sandwich_detection');
    expect(response.answer).toContain('演示数据');
    expect(response.attachments?.[0]).toMatchObject({
      kind: 'image',
      url: '/assets/tx-analysis-fixture.svg',
    });
  });

  it('returns a clear unavailable response when transaction analysis is not configured', async () => {
    const service = createChatService({
      config: { txAnalysisProvider: 'none' },
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });

    const response = await service.ask({
      channel: 'web',
      message: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 被夹了吗？',
    });

    expect(response.intent).toBe('tx_sandwich_detection');
    expect(response.answer).toContain('暂未启用');
    expect(response.citations).toEqual([]);
  });

  it('returns a clear unavailable response when the transaction analysis provider is down', async () => {
    const service = createChatService({
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
      txAnalysisProvider: {
        analyze() {
          throw new TxAnalysisProviderUnavailableError('chain source down');
        },
      },
    });

    const response = await service.ask({
      channel: 'web',
      message: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 被夹了吗？',
    });

    expect(response.intent).toBe('tx_sandwich_detection');
    expect(response.answer).toContain('数据源暂时不可用');
    expect(response.citations).toEqual([]);
  });

  it('does not call the async retriever for boundary questions', async () => {
    const service = createChatService({
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });

    const response = await service.ask({
      channel: 'web',
      message: '帮我查一下钱包余额',
    });

    expect(response.intent).toBe('realtime_account_query');
  });

  it('requires LLM configuration for grounded product questions when no provider is injected', async () => {
    const service = createChatService({
      config: {
        answerProvider: 'openai',
        openAiApiKeyPresent: false,
        openAiModel: undefined,
      },
      index: createFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro 权益',
          sourceType: 'official_docs',
          text: 'XXYY Pro 支持更多提醒。',
        },
      ]),
    });

    await expect(
      service.ask({
        channel: 'cli',
        message: 'XXYY Pro 有哪些权益？',
      }),
    ).rejects.toThrow('OPENAI_API_KEY is required');
  });

  it('still returns fixed boundary responses without LLM configuration', async () => {
    const service = createChatService({
      config: {
        answerProvider: 'openai',
        openAiApiKeyPresent: false,
        openAiModel: undefined,
      },
      index: createFixtureIndex([]),
    });

    const response = await service.ask({
      channel: 'cli',
      message: '帮我查一下钱包余额',
    });

    expect(response.intent).toBe('realtime_account_query');
    expect(response.citations).toEqual([]);
  });

  it('keeps investment boundary when a profit promise is mixed into a product operation question', async () => {
    const answerProvider: AnswerProvider = {
      answer() {
        throw new Error('Answer provider should not be called for investment advice');
      },
    };
    const service = createChatService({
      answerProvider,
      index: createFixtureIndex([
        {
          id: 'official_docs:swap:chunk:0001',
          title: 'Swap 交易',
          sourceType: 'official_docs',
          text: 'XXYY 支持一键买卖代币。',
        },
      ]),
    });

    const response = await service.ask({
      channel: 'cli',
      message: '如何在 XXYY 买入能保证盈利的 token？',
    });

    expect(response.intent).toBe('investment_advice');
    expect(response.answer).not.toContain('一键买卖代币');
    expect(response.citations).toEqual([]);
  });
});
