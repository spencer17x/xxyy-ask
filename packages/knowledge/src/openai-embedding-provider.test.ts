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
      expectedError: 'EMBEDDING_API_KEY or OPENAI_API_KEY is required for embedding generation',
      model: 'text-embedding-3-small',
    },
    {
      apiKey: '   ',
      expectedError: 'EMBEDDING_API_KEY or OPENAI_API_KEY is required for embedding generation',
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

  it('includes provider error details when an embedding request fails', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: '模型 text-embedding-3-small 无可用渠道',
            },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const provider = createOpenAiEmbeddingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'text-embedding-3-small',
    });

    await expect(provider.embedTexts(['ping'])).rejects.toThrow(
      'Embedding request failed with status 503: 模型 text-embedding-3-small 无可用渠道',
    );
  });

  it('fails with a clear error when an embedding request times out', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted by test signal'));
        });
      });

    const provider = createOpenAiEmbeddingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'text-embedding-3-small',
      requestTimeoutMs: 1,
    });

    await expect(provider.embedTexts(['ping'])).rejects.toThrow(
      'Embedding request timed out after 1ms',
    );
  });

  it('retries a timed-out embedding request before failing', async () => {
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
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    };

    const provider = createOpenAiEmbeddingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      maxRetries: 1,
      model: 'text-embedding-3-small',
      requestTimeoutMs: 1,
    });

    const embeddings = await provider.embedTexts(['ping']);

    expect(attempts).toBe(2);
    expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);
  });

  it('retries a rate-limited embedding request', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    const provider = createOpenAiEmbeddingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      maxRetries: 1,
      model: 'text-embedding-3-small',
    });

    await expect(provider.embedTexts(['ping'])).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(attempts).toBe(2);
  });

  it('rejects non-JSON embedding responses with a configuration hint', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response('<!doctype html><title>New API</title>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
      );

    const provider = createOpenAiEmbeddingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example',
      fetchImpl,
      model: 'text-embedding-3-small',
    });

    await expect(provider.embedTexts(['ping'])).rejects.toThrow(
      'Embedding response was not JSON. Check OPENAI_BASE_URL',
    );
  });
});
