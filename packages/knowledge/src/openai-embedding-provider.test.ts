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
              { embedding: [0.4, 0.5, 0.6], index: 1 },
              { embedding: [0.1, 0.2, 0.3], index: 0 },
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

  it.each([
    {
      apiKey: undefined,
      expectedError: 'OPENAI_API_KEY is required for embedding generation',
      model: 'text-embedding-3-small',
    },
    {
      apiKey: '   ',
      expectedError: 'OPENAI_API_KEY is required for embedding generation',
      model: 'text-embedding-3-small',
    },
    {
      apiKey: 'test-key',
      expectedError: 'OPENAI_EMBEDDING_MODEL is required for embedding generation',
      model: '',
    },
    {
      apiKey: 'test-key',
      expectedError: 'OPENAI_EMBEDDING_MODEL is required for embedding generation',
      model: undefined,
    },
  ])('fails fast when embedding configuration is incomplete: $expectedError', (options) => {
    expect(() =>
      createOpenAiEmbeddingProvider({
        apiKey: options.apiKey,
        baseUrl: 'https://llm.example/v1',
        model: options.model,
      }),
    ).toThrow(options.expectedError);
  });

  it.each([
    {
      data: [
        { embedding: [0.1, 0.2, 0.3], index: 0 },
        { embedding: [0.4, 0.5, 0.6], index: 0 },
      ],
      name: 'duplicate index',
    },
    {
      data: [
        { embedding: [0.1, 0.2, 0.3], index: 0 },
        { embedding: [0.4, 0.5, 0.6], index: 2 },
      ],
      name: 'missing index',
    },
    {
      data: [
        { embedding: [0.1, 0.2, 0.3], index: 0 },
        { embedding: [0.4, '0.5', 0.6], index: 1 },
      ],
      name: 'non-numeric embedding',
    },
  ])('rejects embedding responses with a $name', async ({ data }) => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const provider = createOpenAiEmbeddingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'text-embedding-3-small',
    });

    await expect(provider.embedTexts(['XXYY Pro', 'Telegram 钱包监控'])).rejects.toThrow(
      'Embedding response did not include all embeddings.',
    );
  });
});
