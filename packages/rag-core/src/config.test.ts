import { describe, expect, it } from 'vitest';

import { loadRagConfig } from './config.js';

describe('loadRagConfig', () => {
  it('returns deterministic defaults when no environment is provided', () => {
    expect(loadRagConfig({})).toEqual({
      topK: 6,
      answerProvider: 'openai',
      embeddingProvider: 'local',
      indexPath: '.rag/index.json',
      openAiApiKey: undefined,
      openAiBaseUrl: 'https://api.openai.com/v1',
      openAiApiKeyPresent: false,
      openAiModel: undefined,
    });
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
      openAiApiKey: 'sk-future-only',
      openAiBaseUrl: 'https://llm.example/v1',
      openAiApiKeyPresent: true,
      openAiModel: 'gpt-test',
    });
  });

  it('keeps a safe topK default for invalid numeric overrides', () => {
    expect(loadRagConfig({ RAG_TOP_K: 'not-a-number' }).topK).toBe(6);
    expect(loadRagConfig({ RAG_TOP_K: '0' }).topK).toBe(6);
  });
});
