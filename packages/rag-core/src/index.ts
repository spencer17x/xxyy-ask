export const workspacePackageName = '@xxyy/rag-core';

export { createGroundedAnswer } from './answer.js';
export { classifyQuestion } from './classify.js';
export { loadRagConfig } from './config.js';
export { evaluateCases } from './evaluate.js';
export { createOpenAiAnswerProvider, LlmConfigurationError } from './openai-answer-provider.js';
export {
  createPgPool,
  createPgVectorStore,
  toPgVectorLiteral,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from './pgvector-store.js';
export { retrieve } from './retrieve.js';
export { createLazyRetriever, createLocalRetriever } from './retriever.js';
export { createChatService } from './chat-service.js';

export type { AnswerProvider, AnswerProviderInput } from './answer-provider.js';
export type { ChatService, CreateChatServiceOptions } from './chat-service.js';
export type { RagConfig, RagEnv } from './config.js';
export type { EvaluationCase, EvaluationReport, EvaluationResult } from './evaluate.js';
export type { OpenAiAnswerProviderOptions } from './openai-answer-provider.js';
export type {
  EmbeddedKnowledgeChunk,
  PgClientLike,
  PgVectorStore,
  PgVectorStoreOptions,
} from './pgvector-store.js';
export type { RetrieveOptions, RetrievedChunk } from './retrieve.js';
export type { Retriever } from './retriever.js';
