export const workspacePackageName = '@xxyy/rag-core';

export {
  AnswerJudgeConfigurationError,
  AnswerJudgeResponseError,
  createOpenAiAnswerQualityJudge,
} from './answer-quality-judge.js';
export {
  createAttachmentsFromChunks,
  createBoundaryAnswer,
  createCitationsFromChunks,
  createGroundedAnswer,
  createInsufficientKnowledgeAnswer,
  createSupportConclusionFromEvidence,
  selectGroundingChunks,
  shouldUseDeterministicSupportAnswer,
} from './answer.js';
export { classifyQuestion, hasProductDomainSignal } from './classify.js';
export { loadRagConfig } from './config.js';
export { loadWorkspaceEnv, resolveWorkspaceCwd } from './env.js';
export { evaluateCases } from './evaluate.js';
export { formatEvaluationFailureJsonl } from './evaluation-failures.js';
export { createOpenAiAnswerProvider, LlmConfigurationError } from './openai-answer-provider.js';
export {
  composeQualityTracers,
  createInMemoryQualityTracer,
  noopQualityTracer,
} from './quality-trace.js';
export {
  createPgFeedbackStore,
  createPgPool,
  createPgVectorStore,
  toPgVectorLiteral,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from './pgvector-store.js';
export { retrieve } from './retrieve.js';
export { aggregateRetrievalResults, evaluateRetrievalRanking } from './retrieval-evaluate.js';
export { redactSensitiveSupportText } from './redaction.js';
export {
  createLazyRetriever,
  createLocalRetriever,
  createMetadataReranker,
  createRerankingRetriever,
} from './retriever.js';
export {
  extractSupportEntityTokens,
  formatRetrievedChunksDebug,
  isSupportQuestionText,
} from './support-entity.js';
export { createChatService } from './chat-service.js';

export type { AnswerProvider, AnswerProviderInput } from './answer-provider.js';
export type {
  AnswerQualityJudge,
  AnswerQualityJudgeInput,
  AnswerQualityScores,
  OpenAiAnswerQualityJudgeOptions,
} from './answer-quality-judge.js';
export type { ChatService, CreateChatServiceOptions } from './chat-service.js';
export type { RagConfig, RagEnv } from './config.js';
export type { EnvRecord, LoadWorkspaceEnvOptions, WorkspaceEnv } from './env.js';
export type {
  AnswerQualityEvaluationSummary,
  EvaluateCasesOptions,
  EvaluationCase,
  EvaluationObservation,
  EvaluationReport,
  EvaluationResult,
} from './evaluate.js';
export type { OpenAiAnswerProviderOptions } from './openai-answer-provider.js';
export type {
  QualityRunType,
  QualitySpanInput,
  QualityStreamSpanInput,
  QualityTraceRecord,
  QualityTraceStatus,
  QualityTracer,
} from './quality-trace.js';
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
  PgTransactionClientLike,
  PgVectorMigrationOptions,
  PgVectorStore,
  PgVectorStoreOptions,
  RecordFeedbackInput,
  RecordIngestionRunInput,
  ReplaceChunksOptions,
} from './pgvector-store.js';
export type { RetrieveOptions, RetrievedChunk } from './retrieve.js';
export type {
  RetrievalEvaluationInput,
  RetrievalEvaluationResult,
  RetrievalEvaluationSummary,
} from './retrieval-evaluate.js';
export type { Reranker, RerankingRetrieverOptions, Retriever } from './retriever.js';
