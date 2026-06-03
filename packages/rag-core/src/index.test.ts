import { describe, expect, it } from 'vitest';

import {
  classifyQuestion,
  createChatService,
  createGroundedAnswer,
  createLocalRetriever,
  createOpenAiAnswerProvider,
  createPgPool,
  createPgVectorStore,
  evaluateCases,
  LlmConfigurationError,
  loadRagConfig,
  retrieve,
  toPgVectorLiteral,
  VectorStoreConfigurationError,
  workspacePackageName,
} from './index.js';

describe('rag-core public exports', () => {
  it('exports the deterministic RAG core API', () => {
    expect(workspacePackageName).toBe('@xxyy/rag-core');
    expect(loadRagConfig).toBeTypeOf('function');
    expect(classifyQuestion).toBeTypeOf('function');
    expect(retrieve).toBeTypeOf('function');
    expect(createLocalRetriever).toBeTypeOf('function');
    expect(createGroundedAnswer).toBeTypeOf('function');
    expect(createOpenAiAnswerProvider).toBeTypeOf('function');
    expect(LlmConfigurationError).toBeTypeOf('function');
    expect(createPgPool).toBeTypeOf('function');
    expect(createPgVectorStore).toBeTypeOf('function');
    expect(toPgVectorLiteral).toBeTypeOf('function');
    expect(VectorStoreConfigurationError).toBeTypeOf('function');
    expect(createChatService).toBeTypeOf('function');
    expect(evaluateCases).toBeTypeOf('function');
  });
});
