export { chunkMarkdownDocument, chunkMarkdownDocuments } from './chunk-markdown.js';
export type { ChunkMarkdownOptions } from './chunk-markdown.js';
export {
  buildKnowledgeIndex,
  createLocalHashEmbedding,
  loadKnowledgeIndex,
  localHashEmbeddingProvider,
  prepareKnowledgeChunks,
  saveKnowledgeIndex,
} from './index-store.js';
export type { EmbeddingProvider, PreparedKnowledgeChunk } from './index-store.js';
export { loadProductDocuments } from './load-documents.js';
export type { LoadProductDocumentsOptions } from './load-documents.js';
export {
  createOpenAiEmbeddingProvider,
  EmbeddingConfigurationError,
} from './openai-embedding-provider.js';
export type {
  BatchEmbeddingProvider,
  OpenAiEmbeddingProviderOptions,
} from './openai-embedding-provider.js';
export { tokenize } from './tokenize.js';

export type {
  ChunkMetadata,
  IndexEntry,
  RagChunk,
  RagIndex,
  SourceDocument,
  SourceType,
} from '@xxyy/shared';

export const workspacePackageName = '@xxyy/knowledge';
