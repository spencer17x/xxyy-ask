export const workspacePackageName = '@xxyy/rag-core';

export { createGroundedAnswer } from './answer.js';
export {
  createBrowserTxAnalysisProvider,
  createEvmBrowserTxChainAdapter,
  createSolanaBrowserTxChainAdapter,
} from './browser-tx-analysis.js';
export { classifyQuestion } from './classify.js';
export { loadRagConfig } from './config.js';
export { loadWorkspaceEnv, resolveWorkspaceCwd } from './env.js';
export { evaluateCases } from './evaluate.js';
export { createOpenAiAnswerProvider, LlmConfigurationError } from './openai-answer-provider.js';
export { createOpenAiTxAnalysisReviewer } from './openai-tx-analysis-reviewer.js';
export { createPlaywrightBrowserTxAnalysisDriver } from './playwright-browser-tx-driver.js';
export {
  createFileTxAnalysisReportWriter,
  createPgTxAnalysisReportStore,
  findFileTxAnalysisReports,
  getFileTxAnalysisReportDocument,
  migratePgTxAnalysisReportStore,
  summarizeFileTxAnalysisReports,
  updateFileTxAnalysisReportReview,
} from './tx-analysis-report-store.js';
export {
  parseOptionalTxAnalysisChainInput,
  parseRequiredTxAnalysisChainInput,
  toTxAnalysisReferenceInput,
  TX_ANALYSIS_CHAIN_ERROR,
} from './tx-analysis-chain.js';
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
export { analyzeSandwichWindow, SANDWICH_ANALYZER_VERSION } from './sandwich-analyzer.js';
export { createChatService } from './chat-service.js';
export { analyzeTransaction, createConfiguredTxAnalysisProvider } from './tx-analysis-runtime.js';
export {
  createMockTxAnalysisProvider,
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  TxAnalysisProviderUnavailableError,
} from './tx-analysis.js';
export { parseTransactionReference } from './tx-hash.js';

export type { AnswerProvider, AnswerProviderInput } from './answer-provider.js';
export type {
  BrowserEvmChain,
  BrowserEvmTxAnalysisDriver,
  BrowserEvmTxSnapshot,
  BrowserSolanaTxSnapshot,
  BrowserTradeSide,
  BrowserTxAnalysisDriver,
  BrowserTxAnalysisProviderOptions,
  BrowserTxAnalysisReview,
  BrowserTxAnalysisReviewer,
  BrowserTxAnalysisReviewInput,
  BrowserTxAnalysisReportWriter,
  BrowserTxChainAdapter,
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
export type { OpenAiTxAnalysisReviewerOptions } from './openai-tx-analysis-reviewer.js';
export type { PlaywrightBrowserTxAnalysisDriverOptions } from './playwright-browser-tx-driver.js';
export type {
  FileTxAnalysisReportWriterOptions,
  GetFileTxAnalysisReportDocumentOptions,
  FindFileTxAnalysisReportsOptions,
  FindTxAnalysisReportsOptions,
  PgTxAnalysisReportStoreOptions,
  SummarizeTxAnalysisReportsOptions,
  TxAnalysisFailureReportDocument,
  TxAnalysisReportIndexEntry,
  TxAnalysisReportReview,
  TxAnalysisReportReviewStatus,
  TxAnalysisReportStore,
  TxAnalysisReportSummary,
  TxAnalysisReportDocument,
  TxAnalysisStoredReportDocument,
  UpdateFileTxAnalysisReportReviewInput,
  UpdateTxAnalysisReportReviewInput,
} from './tx-analysis-report-store.js';
export type { ParsedTxAnalysisChainInput, TxAnalysisReferenceInput } from './tx-analysis-chain.js';
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
  SandwichTrade,
  SandwichTradeSide,
  SandwichTradeWindow,
  SandwichWindowAnalysis,
  SandwichWindowAnalysisOptions,
} from './sandwich-analyzer.js';
export type {
  MockTxAnalysisProviderOptions,
  TxAnalysisProvider,
  TxAnalysisUnavailableReason,
} from './tx-analysis.js';
export type {
  AnalyzeTransactionInput,
  AnalyzeTransactionOptions,
  AnalyzeTransactionOutput,
} from './tx-analysis-runtime.js';
export type { TransactionReference } from './tx-hash.js';
