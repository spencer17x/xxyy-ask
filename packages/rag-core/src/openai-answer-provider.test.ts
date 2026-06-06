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
    expect(response.citations[0]).toMatchObject({
      file: 'docs/swap.md',
      title: 'Swap 交易',
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('XXYY 支持一键买卖代币');
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
