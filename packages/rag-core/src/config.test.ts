import { describe, expect, it } from 'vitest';

import { loadRagConfig } from './config.js';

describe('loadRagConfig', () => {
  it('returns deterministic defaults when no environment is provided', () => {
    expect(loadRagConfig({})).toEqual({
      topK: 6,
      answerProvider: 'openai',
      databaseUrl: undefined,
      openAiApiKey: undefined,
      openAiBaseUrl: 'https://api.openai.com/v1',
      openAiApiKeyPresent: false,
      openAiModel: undefined,
      openAiEmbeddingModel: 'text-embedding-3-small',
      embeddingDimension: 1536,
      openAiMaxRetries: 1,
      openAiRequestTimeoutMs: 30000,
    });
  });

  it('defaults to OpenAI small embedding model without exposing local mode', () => {
    const config = loadRagConfig({});

    expect(config).not.toHaveProperty('vectorStore');
    expect(config).not.toHaveProperty('indexPath');
    expect(config).not.toHaveProperty('embeddingProvider');
    expect(config.databaseUrl).toBeUndefined();
    expect(config.openAiEmbeddingModel).toBe('text-embedding-3-small');
  });

  it('accepts supported environment overrides without requiring OpenAI calls', () => {
    expect(
      loadRagConfig({
        OPENAI_API_KEY: 'sk-future-only',
        RAG_ANSWER_PROVIDER: 'future-provider',
        RAG_TOP_K: '3',
        OPENAI_BASE_URL: 'https://llm.example/v1',
        EMBEDDING_DIMENSION: '768',
        OPENAI_MAX_RETRIES: '2',
        OPENAI_MODEL: 'gpt-test',
        OPENAI_REQUEST_TIMEOUT_MS: '12000',
      }),
    ).toEqual({
      topK: 3,
      answerProvider: 'future-provider',
      databaseUrl: undefined,
      openAiApiKey: 'sk-future-only',
      openAiBaseUrl: 'https://llm.example/v1',
      openAiApiKeyPresent: true,
      openAiModel: 'gpt-test',
      openAiEmbeddingModel: 'text-embedding-3-small',
      embeddingDimension: 768,
      openAiMaxRetries: 2,
      openAiRequestTimeoutMs: 12000,
    });
  });

  it('loads database and embedding configuration from env', () => {
    const config = loadRagConfig({
      DATABASE_URL: 'postgres://xxyy:secret@localhost:5432/xxyy_ask',
      OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
    });

    expect(config.databaseUrl).toBe('postgres://xxyy:secret@localhost:5432/xxyy_ask');
    expect(config.openAiEmbeddingModel).toBe('text-embedding-3-large');
  });

  it('derives database URL from Postgres parts when DATABASE_URL is omitted', () => {
    const config = loadRagConfig({
      POSTGRES_DB: 'xxyy_ask',
      POSTGRES_HOST: 'db.internal',
      POSTGRES_PASSWORD: 'secret with symbols/@',
      POSTGRES_PORT: '15432',
      POSTGRES_USER: 'xxyy',
    });

    expect(config.databaseUrl).toBe(
      'postgres://xxyy:secret%20with%20symbols%2F%40@db.internal:15432/xxyy_ask',
    );
  });

  it('keeps a safe topK default for invalid numeric overrides', () => {
    expect(loadRagConfig({ RAG_TOP_K: 'not-a-number' }).topK).toBe(6);
    expect(loadRagConfig({ RAG_TOP_K: '0' }).topK).toBe(6);
  });

  it('keeps a safe embedding dimension default for invalid numeric overrides', () => {
    expect(loadRagConfig({ EMBEDDING_DIMENSION: 'not-a-number' }).embeddingDimension).toBe(1536);
    expect(loadRagConfig({ EMBEDDING_DIMENSION: '0' }).embeddingDimension).toBe(1536);
  });

  it('keeps safe OpenAI request defaults for invalid numeric overrides', () => {
    const config = loadRagConfig({
      OPENAI_MAX_RETRIES: '-1',
      OPENAI_REQUEST_TIMEOUT_MS: 'not-a-number',
    });

    expect(config.openAiMaxRetries).toBe(1);
    expect(config.openAiRequestTimeoutMs).toBe(30000);
  });
});
