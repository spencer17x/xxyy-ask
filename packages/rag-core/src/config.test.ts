import { describe, expect, it } from 'vitest';

import { loadRagConfig } from './config.js';

describe('loadRagConfig', () => {
  it('returns deterministic defaults when no environment is provided', () => {
    expect(loadRagConfig({})).toEqual({
      topK: 6,
      answerProvider: 'openai',
      embeddingProvider: 'local',
      indexPath: '.rag/index.json',
      vectorStore: 'local',
      databaseUrl: undefined,
      openAiApiKey: undefined,
      openAiBaseUrl: 'https://api.openai.com/v1',
      openAiApiKeyPresent: false,
      openAiModel: undefined,
      openAiEmbeddingModel: 'text-embedding-3-small',
    });
  });

  it('defaults to local vector store and OpenAI small embedding model', () => {
    const config = loadRagConfig({});

    expect(config.vectorStore).toBe('local');
    expect(config.databaseUrl).toBeUndefined();
    expect(config.openAiEmbeddingModel).toBe('text-embedding-3-small');
  });

  it('accepts supported environment overrides without requiring OpenAI calls', () => {
    expect(
      loadRagConfig({
        OPENAI_API_KEY: 'sk-future-only',
        RAG_ANSWER_PROVIDER: 'future-provider',
        RAG_EMBEDDING_PROVIDER: 'future-embeddings',
        RAG_INDEX_PATH: '/tmp/xxyy-index.json',
        RAG_TOP_K: '3',
        OPENAI_BASE_URL: 'https://llm.example/v1',
        OPENAI_MODEL: 'gpt-test',
      }),
    ).toEqual({
      topK: 3,
      answerProvider: 'future-provider',
      embeddingProvider: 'future-embeddings',
      indexPath: '/tmp/xxyy-index.json',
      vectorStore: 'local',
      databaseUrl: undefined,
      openAiApiKey: 'sk-future-only',
      openAiBaseUrl: 'https://llm.example/v1',
      openAiApiKeyPresent: true,
      openAiModel: 'gpt-test',
      openAiEmbeddingModel: 'text-embedding-3-small',
    });
  });

  it('loads pgvector and embedding configuration from env', () => {
    const config = loadRagConfig({
      DATABASE_URL: 'postgres://xxyy:secret@localhost:5432/xxyy_ask',
      OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
      RAG_VECTOR_STORE: 'pgvector',
    });

    expect(config.vectorStore).toBe('pgvector');
    expect(config.databaseUrl).toBe('postgres://xxyy:secret@localhost:5432/xxyy_ask');
    expect(config.openAiEmbeddingModel).toBe('text-embedding-3-large');
  });

  it('rejects unsupported vector store configuration', () => {
    expect(() => loadRagConfig({ RAG_VECTOR_STORE: 'pinecone' })).toThrow(
      'Unsupported RAG_VECTOR_STORE: pinecone',
    );
  });

  it('keeps a safe topK default for invalid numeric overrides', () => {
    expect(loadRagConfig({ RAG_TOP_K: 'not-a-number' }).topK).toBe(6);
    expect(loadRagConfig({ RAG_TOP_K: '0' }).topK).toBe(6);
  });
});
