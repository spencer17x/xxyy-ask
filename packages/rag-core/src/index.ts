export {
  AnswerJudgeConfigurationError,
  createOpenAiAnswerQualityJudge,
} from './answer-quality-judge.js';
export type { AnswerQualityJudge } from './answer-quality-judge.js';
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
export type { AnswerProvider } from './answer-provider.js';
export { createChatService } from './chat-service.js';
export type { ChatService } from './chat-service.js';
export { classifyQuestion, hasProductDomainSignal } from './classify.js';
export { loadRagConfig } from './config.js';
export type { RagConfig, RagEnv } from './config.js';
export { loadWorkspaceEnv, resolveWorkspaceCwd } from './env.js';
export { evaluateCases } from './evaluate.js';
export type { EvaluationCase, EvaluationReport, EvaluationResult } from './evaluate.js';
export { formatEvaluationFailureJsonl } from './evaluation-failures.js';
export {
  createPgKnowledgeCandidateStore,
  sanitizeKnowledgeCandidateText,
} from './knowledge-candidates.js';
export type {
  CreateKnowledgeCandidateInput,
  KnowledgeAuthorVerification,
  KnowledgeCandidate,
  KnowledgeCandidateExtractionMethod,
  KnowledgeCandidateHistory,
  KnowledgeCandidateRevision,
  KnowledgeCandidateReviewRecord,
  KnowledgeCandidateStatus,
  KnowledgeGovernanceAuditEvent,
  ReviseKnowledgeCandidateInput,
} from './knowledge-candidates.js';
export {
  createKnowledgeMatchInspector,
  createPgKnowledgeMatchInspector,
  createOpenAiKnowledgeCuratorModel,
  runKnowledgeCurator,
} from './knowledge-curator.js';
export {
  createKnowledgeGovernanceService,
  UnverifiedTelegramKnowledgeAuthorError,
} from './knowledge-governance-service.js';
export type {
  ImportTelegramKnowledgeInput,
  ImportTelegramKnowledgeResult,
  KnowledgeGovernanceService,
  KnowledgeGovernanceServiceOptions,
} from './knowledge-governance-service.js';
export type {
  CuratorThreadInput,
  CuratorThreadMessage,
  KnowledgeCuratorModel,
  KnowledgeCuratorProposal,
  KnowledgeCuratorRunResult,
  KnowledgeMatchInspection,
  KnowledgeMatchInspector,
  KnowledgeMatchInspectorOptions,
  OpenAiKnowledgeCuratorModelOptions,
  PgKnowledgeMatchInspectorOptions,
  RunKnowledgeCuratorInput,
} from './knowledge-curator.js';
export {
  createQualityTracerFromEnv,
  QualityTracingConfigurationError,
} from './langsmith-quality-trace.js';
export { createOpenAiAnswerProvider, LlmConfigurationError } from './openai-answer-provider.js';
export {
  createPgFeedbackStore,
  createPgPool,
  createPgVectorStore,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from './pgvector-store.js';
export type {
  EmbeddedKnowledgeChunk,
  FeedbackRating,
  FeedbackRecord,
  KnowledgeStats,
  PgClientLike,
  RecordFeedbackInput,
  ReplaceChunksOptions,
} from './pgvector-store.js';
export {
  composeQualityTracers,
  createInMemoryQualityTracer,
  noopQualityTracer,
} from './quality-trace.js';
export type { QualityTraceRecord, QualityTracer } from './quality-trace.js';
export { redactSensitiveSupportText } from './redaction.js';
export { aggregateRetrievalResults, evaluateRetrievalRanking } from './retrieval-evaluate.js';
export { reciprocalRankFusionScore } from './hybrid-rank.js';
export type { RetrievedChunk } from './retrieve.js';
export {
  createLazyRetriever,
  createLocalRetriever,
  createMetadataReranker,
  createRerankingRetriever,
} from './retriever.js';
export type { Retriever } from './retriever.js';
export { fetchTelegramCurrentAdministratorIds } from './telegram-admin-api.js';
export type { FetchTelegramAdministratorsOptions } from './telegram-admin-api.js';
export {
  extractTelegramKnowledgeCandidates,
  readTelegramKnowledgeExport,
  reconstructTelegramConversationThreads,
} from './telegram-knowledge.js';
export type {
  ExtractTelegramCandidateOptions,
  ExtractTelegramCandidateResult,
  TelegramConversationThread,
  TelegramKnowledgeExport,
  TelegramKnowledgeMessage,
} from './telegram-knowledge.js';
export { formatRetrievedChunksDebug } from './support-entity.js';
export {
  createPgTrustedAuthorStore,
  migrateTrustedAuthors,
  normalizeTelegramUserId,
} from './trusted-authors.js';
export type {
  ListTrustedAuthorsOptions,
  PgTrustedAuthorStore,
  ResolveTrustedAuthorInput,
  TrustedAuthor,
  TrustedAuthorRole,
  TrustedAuthorVerificationSource,
  TrustAuthorInput,
} from './trusted-authors.js';
