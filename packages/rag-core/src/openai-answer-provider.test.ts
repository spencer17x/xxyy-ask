import { describe, expect, it } from 'vitest';

import type { ChatStreamEvent, Classification } from '@xxyy/shared';

import { createOpenAiAnswerProvider } from './openai-answer-provider.js';
import { retrieve } from './retrieve.js';
import { createFixtureIndex } from './test-fixtures.js';

const classification: Classification = {
  confidence: 0.84,
  intent: 'how_to',
  reason: 'asks for product operation instructions',
};

describe('createOpenAiAnswerProvider', () => {
  it('generates a grounded answer through an OpenAI-compatible chat completion API', async () => {
    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected JSON string request body');
      }
      requests.push(JSON.parse(init.body));
      return Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                content: '可以在 Swap 交易页选择钱包、输入买入 SOL 数量，然后点击买入。',
              },
            },
          ],
          usage: {
            completion_tokens: 32,
            prompt_tokens: 128,
            total_tokens: 160,
          },
        }),
      );
    };
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:swap:chunk:0001',
        title: 'Swap 交易',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/swap',
        file: '/docs/swap.md',
        text: 'XXYY 支持一键买卖代币，交易金额可以自定义买入的 SOL 数量。',
      },
    ]);
    const retrieved = retrieve('如何在 XXYY 买入代币？', index);

    const response = await provider.answer({
      classification,
      question: '如何在 XXYY 买入代币？',
      retrievedChunks: retrieved,
    });

    expect(response.intent).toBe('how_to');
    expect(response.answer).toContain('Swap 交易页');
    expect(response.citations).toHaveLength(1);
    expect(response.tokenUsage).toEqual({
      completionTokens: 32,
      promptTokens: 128,
      totalTokens: 160,
    });
    expect(response.citations[0]).toMatchObject({
      file: 'docs/swap.md',
      title: 'Swap 交易',
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('XXYY 支持一键买卖代币');
  });

  it('asks the LLM to preserve relevant option lists deterministically', async () => {
    interface CapturedRequest {
      messages?: Array<{ content?: string }>;
      temperature?: number;
    }

    const requests: CapturedRequest[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected JSON string request body');
      }
      requests.push(JSON.parse(init.body) as CapturedRequest);
      return Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                content: '挂单支持价格上涨、价格下跌和有效时间。',
              },
            },
          ],
        }),
      );
    };
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:limit-order:chunk:0001',
        title: '挂单交易',
        sourceType: 'official_docs',
        file: '/docs/limit-order.md',
        text: '挂单设置包括价格上涨、价格下跌、市值上涨、市值下跌、价格到达和有效时间。',
      },
    ]);
    const retrieved = retrieve('如何设置挂单买入或卖出？', index);

    await provider.answer({
      classification,
      question: '如何设置挂单买入或卖出？',
      retrievedChunks: retrieved,
    });

    const request = requests[0];
    const prompt = request?.messages?.map((message) => message.content).join('\n') ?? '';
    expect(request?.temperature).toBe(0);
    expect(prompt).toContain('不要遗漏与用户问题直接相关的配置项、限制、数量、条件或步骤');
  });

  it('includes freshness metadata and conflict-resolution rules in the prompt context', async () => {
    interface CapturedRequest {
      messages?: Array<{ content?: string; role?: string }>;
    }

    const requests: CapturedRequest[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected JSON string request body');
      }
      requests.push(JSON.parse(init.body) as CapturedRequest);
      return Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                content: '当前每条链最多支持 5000 个钱包监控地址。',
              },
            },
          ],
        }),
      );
    };
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
    });
    const retrieved = [
      {
        documentId: 'x_updates:wallet-limit',
        embedding: [],
        id: 'x_updates:wallet-limit:chunk:0001',
        lexicalScore: 4,
        metadata: {
          effectiveAt: '2026-07-01T00:00:00.000Z',
          file: '/docs/product-features/xxyy-x-updates.md',
          headingPath: ['钱包监控上限更新'],
          module: 'X Updates',
          sourceType: 'x_updates' as const,
          status: 'current' as const,
          title: '钱包监控上限更新',
        },
        rank: 1,
        score: 10,
        sourceBoost: 0,
        text: '钱包监控每条链最多支持 5000 个地址。',
        tokens: [],
        vectorScore: 1,
      },
    ];

    await provider.answer({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: '现在钱包监控每条链最多支持多少地址？',
      retrievedChunks: retrieved,
    });

    const prompt = requests[0]?.messages?.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain('默认回答当前有效规则');
    expect(prompt).toContain('不要混合冲突的新旧事实');
    expect(prompt).toContain('来源类型：x_updates');
    expect(prompt).toContain('状态：current');
    expect(prompt).toContain('生效时间：2026-07-01T00:00:00.000Z');
  });

  it('returns video attachments discovered in retrieved context', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                content: 'XXYY 可以添加到桌面，体验和 App 差不多。',
              },
            },
          ],
        }),
      );
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:mobile-app:chunk:0001',
        title: '移动端桌面入口',
        sourceType: 'official_docs',
        file: '/docs/mobile-app.md',
        text: 'XXYY 可以添加到桌面，和 App 体验差不多。[添加到桌面演示](/assets/xxyy-add-to-home.mp4)',
      },
    ]);
    const retrieved = retrieve('XXYY 有 APP 吗？', index);

    const response = await provider.answer({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: 'XXYY 有 APP 吗？',
      retrievedChunks: retrieved,
    });

    expect(response.attachments).toEqual([
      {
        kind: 'video',
        mediaType: 'video/mp4',
        title: '添加到桌面演示',
        url: '/assets/xxyy-add-to-home.mp4',
      },
    ]);
  });

  it('falls back to grounded context when the LLM returns only a safety label', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                content: 'User Safety: safe',
              },
            },
          ],
        }),
      );
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        file: '/docs/pro.md',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 有哪些权益？', index);

    const response = await provider.answer({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: 'XXYY Pro 有哪些权益？',
      retrievedChunks: retrieved,
    });

    expect(response.answer).not.toContain('User Safety');
    expect(response.answer).toContain('独享服务器和节点');
    expect(response.answer).toContain('监控2000个钱包');
  });

  it('falls back to grounded context when the LLM request times out', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted by test signal'));
        });
      });
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1,
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        file: '/docs/pro.md',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 有哪些权益？', index);

    const response = await provider.answer({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: 'XXYY Pro 有哪些权益？',
      retrievedChunks: retrieved,
    });

    expect(response.answer).toContain('独享服务器和节点');
    expect(response.answer).toContain('监控2000个钱包');
  });

  it('retries a timed-out LLM request before falling back', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = (_input, init) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted by test signal'));
          });
        });
      }

      return Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                content: '第二次请求成功返回 Pro 权益。',
              },
            },
          ],
        }),
      );
    };
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      maxRetries: 1,
      model: 'gpt-test',
      requestTimeoutMs: 1,
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        file: '/docs/pro.md',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 有哪些权益？', index);

    const response = await provider.answer({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: 'XXYY Pro 有哪些权益？',
      retrievedChunks: retrieved,
    });

    expect(attempts).toBe(2);
    expect(response.answer).toBe('第二次请求成功返回 Pro 权益。');
  });

  it('falls back to grounded context when the LLM request is rate limited', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      maxRetries: 0,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        file: '/docs/pro.md',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 有哪些权益？', index);

    const response = await provider.answer({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: 'XXYY Pro 有哪些权益？',
      retrievedChunks: retrieved,
    });

    expect(response.answer).toContain('独享服务器和节点');
    expect(response.answer).toContain('监控2000个钱包');
  });

  it('falls back to grounded context when the LLM model route is unavailable', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'model not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      maxRetries: 0,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        file: '/docs/pro.md',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 有哪些权益？', index);

    const response = await provider.answer({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: 'XXYY Pro 有哪些权益？',
      retrievedChunks: retrieved,
    });

    expect(response.answer).toContain('独享服务器和节点');
    expect(response.answer).toContain('监控2000个钱包');
  });

  it('retries a retryable LLM status before falling back', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve(new Response('rate limited', { status: 429 }));
      }

      return Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                content: '第二次限流重试成功。',
              },
            },
          ],
        }),
      );
    };
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      maxRetries: 1,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        file: '/docs/pro.md',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 有哪些权益？', index);

    const response = await provider.answer({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: 'XXYY Pro 有哪些权益？',
      retrievedChunks: retrieved,
    });

    expect(attempts).toBe(2);
    expect(response.answer).toBe('第二次限流重试成功。');
  });

  it('streams grounded answer deltas through an OpenAI-compatible chat completion API', async () => {
    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected JSON string request body');
      }
      requests.push(JSON.parse(init.body));
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"可以在"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" Swap 页操作。"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    };
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:swap:chunk:0001',
        title: 'Swap 交易',
        sourceType: 'official_docs',
        file: '/docs/swap.md',
        text: 'XXYY 支持一键买卖代币。',
      },
    ]);
    const retrieved = retrieve('如何在 XXYY 买入代币？', index);

    if (provider.stream === undefined) {
      throw new Error('Expected provider to support streaming');
    }

    const events: ChatStreamEvent[] = [];
    for await (const event of provider.stream({
      classification,
      question: '如何在 XXYY 买入代币？',
      retrievedChunks: retrieved,
    })) {
      events.push(event);
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: 'gpt-test',
      stream: true,
    });
    expect(events.slice(0, 2)).toEqual([
      { type: 'answer_delta', delta: '可以在' },
      { type: 'answer_delta', delta: ' Swap 页操作。' },
    ]);
    const metadata = events[2];
    expect(metadata?.type).toBe('metadata');
    if (metadata?.type !== 'metadata') {
      throw new Error('Expected metadata event');
    }
    expect(metadata.citations).toHaveLength(1);
    expect(metadata.confidence).toBe(0.84);
    expect(metadata.intent).toBe('how_to');
  });

  it('yields streaming deltas before the provider response finishes', async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
          {
            headers: { 'Content-Type': 'text/event-stream' },
            status: 200,
          },
        ),
      );
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:swap:chunk:0001',
        title: 'Swap 交易',
        sourceType: 'official_docs',
        file: '/docs/swap.md',
        text: 'XXYY 支持一键买卖代币。',
      },
    ]);
    const retrieved = retrieve('如何在 XXYY 买入代币？', index);

    if (provider.stream === undefined) {
      throw new Error('Expected provider to support streaming');
    }

    const iterator = provider
      .stream({
        classification,
        question: '如何在 XXYY 买入代币？',
        retrievedChunks: retrieved,
      })
      [Symbol.asyncIterator]();

    const firstPromise = iterator.next();
    await Promise.resolve();
    if (streamController === undefined) {
      throw new Error('Expected streaming response body to be initialized');
    }
    streamController.enqueue(
      encoder.encode('data: {"choices":[{"delta":{"content":"可以在"}}]}\n\n'),
    );
    const first = await Promise.race([firstPromise, delay(25).then(() => ({ timeout: true }))]);

    expect(first).toEqual({
      done: false,
      value: { type: 'answer_delta', delta: '可以在' },
    });

    streamController?.close();
    await iterator.return?.();
  });

  it('falls back to grounded stream events when the streaming LLM returns only a safety label', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"User"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" Safety"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":": safe"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        file: '/docs/pro.md',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 有哪些权益？', index);

    if (provider.stream === undefined) {
      throw new Error('Expected provider to support streaming');
    }

    const events: ChatStreamEvent[] = [];
    for await (const event of provider.stream({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: 'XXYY Pro 有哪些权益？',
      retrievedChunks: retrieved,
    })) {
      events.push(event);
    }

    const answer = events
      .filter((event): event is Extract<ChatStreamEvent, { type: 'answer_delta' }> => {
        return event.type === 'answer_delta';
      })
      .map((event) => event.delta)
      .join('');

    expect(answer).not.toContain('User Safety');
    expect(answer).toContain('独享服务器和节点');
    expect(answer).toContain('监控2000个钱包');
    expect(events.at(-1)?.type).toBe('metadata');
  });

  it('falls back to grounded stream events when the streaming LLM request times out', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted by test signal'));
        });
      });
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1,
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        file: '/docs/pro.md',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 有哪些权益？', index);

    if (provider.stream === undefined) {
      throw new Error('Expected provider to support streaming');
    }

    const events: ChatStreamEvent[] = [];
    for await (const event of provider.stream({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: 'XXYY Pro 有哪些权益？',
      retrievedChunks: retrieved,
    })) {
      events.push(event);
    }

    const answer = events
      .filter((event): event is Extract<ChatStreamEvent, { type: 'answer_delta' }> => {
        return event.type === 'answer_delta';
      })
      .map((event) => event.delta)
      .join('');

    expect(answer).toContain('独享服务器和节点');
    expect(answer).toContain('监控2000个钱包');
    expect(events.at(-1)?.type).toBe('metadata');
  });

  it('falls back to grounded stream events when the streaming LLM request is rate limited', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('rate limited', { status: 429 }));
    const provider = createOpenAiAnswerProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      maxRetries: 0,
      model: 'gpt-test',
    });
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        file: '/docs/pro.md',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 有哪些权益？', index);

    if (provider.stream === undefined) {
      throw new Error('Expected provider to support streaming');
    }

    const events: ChatStreamEvent[] = [];
    for await (const event of provider.stream({
      classification: {
        confidence: 0.78,
        intent: 'product_qa',
        reason: 'product question',
      },
      question: 'XXYY Pro 有哪些权益？',
      retrievedChunks: retrieved,
    })) {
      events.push(event);
    }

    const answer = events
      .filter((event): event is Extract<ChatStreamEvent, { type: 'answer_delta' }> => {
        return event.type === 'answer_delta';
      })
      .map((event) => event.delta)
      .join('');

    expect(answer).toContain('独享服务器和节点');
    expect(answer).toContain('监控2000个钱包');
    expect(events.at(-1)?.type).toBe('metadata');
  });

  it('fails fast when LLM configuration is incomplete', () => {
    expect(() =>
      createOpenAiAnswerProvider({
        apiKey: undefined,
        baseUrl: 'https://llm.example/v1',
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse({
              choices: [
                {
                  message: {
                    content: 'unused',
                  },
                },
              ],
            }),
          ),
        model: 'gpt-test',
      }),
    ).toThrow('OPENAI_API_KEY is required');

    expect(() =>
      createOpenAiAnswerProvider({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example/v1',
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse({
              choices: [
                {
                  message: {
                    content: 'unused',
                  },
                },
              ],
            }),
          ),
        model: undefined,
      }),
    ).toThrow('OPENAI_MODEL is required');
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      headers: { 'Content-Type': 'text/event-stream' },
      status: 200,
    },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
