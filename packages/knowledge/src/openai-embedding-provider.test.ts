import { describe, expect, it } from 'vitest';

import { createOpenAiEmbeddingProvider } from './openai-embedding-provider.js';

describe('createOpenAiEmbeddingProvider', () => {
  it('embeds text batches through an OpenAI-compatible embeddings API', async () => {
    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected JSON request body');
      }
      requests.push(JSON.parse(init.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { embedding: [0.1, 0.2, 0.3], index: 0 },
              { embedding: [0.4, 0.5, 0.6], index: 1 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    };

    const provider = createOpenAiEmbeddingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'text-embedding-3-small',
    });

    const embeddings = await provider.embedTexts(['XXYY Pro', 'Telegram 钱包监控']);

    expect(embeddings).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(requests).toEqual([
      {
        input: ['XXYY Pro', 'Telegram 钱包监控'],
        model: 'text-embedding-3-small',
      },
    ]);
  });

  it('fails fast when embedding configuration is incomplete', () => {
    expect(() =>
      createOpenAiEmbeddingProvider({
        apiKey: undefined,
        baseUrl: 'https://llm.example/v1',
        model: 'text-embedding-3-small',
      }),
    ).toThrow('OPENAI_API_KEY is required for embedding generation');

    expect(() =>
      createOpenAiEmbeddingProvider({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example/v1',
        model: '',
      }),
    ).toThrow('OPENAI_EMBEDDING_MODEL is required for embedding generation');
  });
});
