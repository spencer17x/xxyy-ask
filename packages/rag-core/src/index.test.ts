import { describe, expect, it } from 'vitest';

import * as ragCore from './index.js';

describe('rag-core public exports', () => {
  it('exports only the knowledge-base RAG core API', () => {
    expect(ragCore.workspacePackageName).toBe('@xxyy/rag-core');
    expect(ragCore.loadRagConfig).toBeTypeOf('function');
    expect(ragCore.classifyQuestion).toBeTypeOf('function');
    expect(ragCore.retrieve).toBeTypeOf('function');
    expect(ragCore.createLocalRetriever).toBeTypeOf('function');
    expect(ragCore.createGroundedAnswer).toBeTypeOf('function');
    expect(ragCore.createOpenAiAnswerProvider).toBeTypeOf('function');
    expect(ragCore.LlmConfigurationError).toBeTypeOf('function');
    expect(ragCore.createPgPool).toBeTypeOf('function');
    expect(ragCore.createPgVectorStore).toBeTypeOf('function');
    expect(ragCore.toPgVectorLiteral).toBeTypeOf('function');
    expect(ragCore.VectorStoreConfigurationError).toBeTypeOf('function');
    expect(ragCore.createChatService).toBeTypeOf('function');
    expect(ragCore.evaluateCases).toBeTypeOf('function');
    expect(ragCore.createMetadataReranker).toBeTypeOf('function');
    expect(ragCore.createRerankingRetriever).toBeTypeOf('function');

    expect(Object.keys(ragCore).sort()).toEqual([
      'LlmConfigurationError',
      'VectorStoreConfigurationError',
      'VectorStoreUnavailableError',
      'classifyQuestion',
      'createBoundaryAnswer',
      'createChatService',
      'createGroundedAnswer',
      'createLazyRetriever',
      'createLocalRetriever',
      'createMetadataReranker',
      'createOpenAiAnswerProvider',
      'createPgFeedbackStore',
      'createPgPool',
      'createPgVectorStore',
      'createRerankingRetriever',
      'evaluateCases',
      'loadRagConfig',
      'loadWorkspaceEnv',
      'resolveWorkspaceCwd',
      'retrieve',
      'toPgVectorLiteral',
      'workspacePackageName',
    ]);
  });
});
