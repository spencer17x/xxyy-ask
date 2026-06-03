import { describe, expect, it } from 'vitest';

import type { Classification } from '@xxyy/shared';

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
