export const workspacePackageName = '@xxyy/rag-core';

export {
  createAttachmentsFromChunks,
  createBoundaryAnswer,
  createCitationsFromChunks,
  createGroundedAnswer,
  selectGroundingChunks,
} from './answer.js';
export { classifyQuestion } from './classify.js';
export { loadRagConfig } from './config.js';
export { loadWorkspaceEnv, resolveWorkspaceCwd } from './env.js';
export { evaluateCases } from './evaluate.js';
export { createOpenAiAnswerProvider, LlmConfigurationError } from './openai-answer-provider.js';
export {
  createPgFeedbackStore,
  createPgPool,
  createPgVectorStore,
  toPgVectorLiteral,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from './pgvector-store.js';
export { retrieve } from './retrieve.js';
export { redactSensitiveSupportText } from './redaction.js';
export {
  createLazyRetriever,
  createLocalRetriever,
  createMetadataReranker,
  createRerankingRetriever,
} from './retriever.js';
export { createChatService } from './chat-service.js';

export type { AnswerProvider, AnswerProviderInput } from './answer-provider.js';
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
export type { Reranker, RerankingRetrieverOptions, Retriever } from './retriever.js';
