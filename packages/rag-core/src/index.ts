export const workspacePackageName = '@xxyy/rag-core';

export { createGroundedAnswer } from './answer.js';
export { createBrowserTxAnalysisProvider } from './browser-tx-analysis.js';
export { classifyQuestion } from './classify.js';
export { loadRagConfig } from './config.js';
export { loadWorkspaceEnv, resolveWorkspaceCwd } from './env.js';
export { evaluateCases } from './evaluate.js';
export { createOpenAiAnswerProvider, LlmConfigurationError } from './openai-answer-provider.js';
export { createPlaywrightBrowserTxAnalysisDriver } from './playwright-browser-tx-driver.js';
export {
  createPgFeedbackStore,
  createPgPool,
  createPgVectorStore,
  toPgVectorLiteral,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from './pgvector-store.js';
export { retrieve } from './retrieve.js';
export { createLazyRetriever, createLocalRetriever } from './retriever.js';
export { createChatService } from './chat-service.js';
export {
  createMockTxAnalysisProvider,
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  TxAnalysisProviderUnavailableError,
} from './tx-analysis.js';
export { parseTransactionReference } from './tx-hash.js';

export type { AnswerProvider, AnswerProviderInput } from './answer-provider.js';
export type {
  BrowserSolanaTxSnapshot,
  BrowserTradeSide,
  BrowserTxAnalysisDriver,
  BrowserTxAnalysisProviderOptions,
  BrowserTxTrade,
} from './browser-tx-analysis.js';
export type { ChatService, CreateChatServiceOptions } from './chat-service.js';
export type { RagConfig, RagEnv } from './config.js';
export type { EnvRecord, LoadWorkspaceEnvOptions, WorkspaceEnv } from './env.js';
export type {
  EvaluateCasesOptions,
  EvaluationCase,
  EvaluationReport,
  EvaluationResult,
} from './evaluate.js';
export type { OpenAiAnswerProviderOptions } from './openai-answer-provider.js';
export type { PlaywrightBrowserTxAnalysisDriverOptions } from './playwright-browser-tx-driver.js';
export type {
  EmbeddedKnowledgeChunk,
  FeedbackRecord,
  FeedbackRating,
  FeedbackStats,
  GetFeedbackStatsOptions,
  KnowledgeIngestionRun,
  KnowledgeSourceStats,
  KnowledgeStats,
  PgFeedbackStore,
  PgFeedbackStoreOptions,
  PgClientLike,
  PgVectorStore,
  PgVectorStoreOptions,
  RecordFeedbackInput,
  RecordIngestionRunInput,
} from './pgvector-store.js';
export type { RetrieveOptions, RetrievedChunk } from './retrieve.js';
export type { Retriever } from './retriever.js';
export type {
  MockTxAnalysisProviderOptions,
  TxAnalysisProvider,
  TxAnalysisUnavailableReason,
} from './tx-analysis.js';
export type { TransactionReference } from './tx-hash.js';
