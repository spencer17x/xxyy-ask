import { describe, expect, it } from 'vitest';

import {
  classifyQuestion,
  createBrowserTxAnalysisProvider,
  createChatService,
  createEvmBrowserTxChainAdapter,
  createFileTxAnalysisReportWriter,
  createGroundedAnswer,
  createLocalRetriever,
  createMockTxAnalysisProvider,
  createOpenAiAnswerProvider,
  createPlaywrightBrowserTxAnalysisDriver,
  createPgPool,
  createPgTxAnalysisReportStore,
  createPgVectorStore,
  createSolanaBrowserTxChainAdapter,
  createTxAnalysisAnswer,
  evaluateCases,
  analyzeSandwichWindow,
  findFileTxAnalysisReports,
  LlmConfigurationError,
  loadRagConfig,
  parseTransactionReference,
  retrieve,
  SANDWICH_ANALYZER_VERSION,
  toPgVectorLiteral,
  TxAnalysisProviderUnavailableError,
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
    expect(parseTransactionReference).toBeTypeOf('function');
    expect(createBrowserTxAnalysisProvider).toBeTypeOf('function');
    expect(createEvmBrowserTxChainAdapter).toBeTypeOf('function');
    expect(createFileTxAnalysisReportWriter).toBeTypeOf('function');
    expect(createPgTxAnalysisReportStore).toBeTypeOf('function');
    expect(findFileTxAnalysisReports).toBeTypeOf('function');
    expect(createSolanaBrowserTxChainAdapter).toBeTypeOf('function');
    expect(createPlaywrightBrowserTxAnalysisDriver).toBeTypeOf('function');
    expect(createMockTxAnalysisProvider).toBeTypeOf('function');
    expect(createTxAnalysisAnswer).toBeTypeOf('function');
    expect(analyzeSandwichWindow).toBeTypeOf('function');
    expect(SANDWICH_ANALYZER_VERSION).toBe('sandwich-window-rules-v1');
    expect(TxAnalysisProviderUnavailableError).toBeTypeOf('function');
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
