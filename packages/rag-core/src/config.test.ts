import { describe, expect, it } from 'vitest';

import { loadRagConfig } from './config.js';

describe('loadRagConfig', () => {
  it('returns deterministic defaults when no environment is provided', () => {
    expect(loadRagConfig({})).toEqual({
      topK: 6,
      answerProvider: 'extractive',
      embeddingProvider: 'local',
      indexPath: '.rag/index.json',
      openAiApiKeyPresent: false,
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
      }),
    ).toEqual({
      topK: 3,
      answerProvider: 'future-provider',
      embeddingProvider: 'future-embeddings',
      indexPath: '/tmp/xxyy-index.json',
      openAiApiKeyPresent: true,
    });
  });

  it('keeps a safe topK default for invalid numeric overrides', () => {
    expect(loadRagConfig({ RAG_TOP_K: 'not-a-number' }).topK).toBe(6);
    expect(loadRagConfig({ RAG_TOP_K: '0' }).topK).toBe(6);
  });
});
