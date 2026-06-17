import type { ChatResponse } from '@xxyy/shared';
import type { AnswerProvider, RagConfig, RetrievedChunk, Retriever } from '@xxyy/rag-core';
import {
  PRODUCT_TOOL_NAMES,
  createProductTools,
  createToolRegistry,
  type CreateProductToolsOptions,
} from '@xxyy/agent-core';

export interface ProductQaToolHandlersOptions {
  answerProvider?: AnswerProvider;
  config?: Partial<RagConfig>;
  retriever: Retriever;
}

export interface ProductQaToolHandlers {
  searchProductDocs(input: { query: string; topK?: number }): Promise<{
    chunks: Array<Omit<RetrievedChunk, 'embedding' | 'tokens'>>;
    citations: ChatResponse['citations'];
    confidence: number;
  }>;
  answerProductQuestion(input: {
    channel?: 'agent' | 'cli' | 'telegram' | 'web';
    question: string;
  }): Promise<ChatResponse>;
}

export function createProductQaToolHandlers(
  options: ProductQaToolHandlersOptions,
): ProductQaToolHandlers {
  const registry = createToolRegistry();
  const toolOptions: CreateProductToolsOptions = {
    retriever: options.retriever,
    ...(options.answerProvider === undefined ? {} : { answerProvider: options.answerProvider }),
    ...(options.config === undefined ? {} : { config: options.config }),
  };
  for (const tool of createProductTools(toolOptions)) {
    registry.register(tool);
  }

  return {
    searchProductDocs(input) {
      return registry.execute(PRODUCT_TOOL_NAMES[0], input) as Promise<{
        chunks: Array<Omit<RetrievedChunk, 'embedding' | 'tokens'>>;
        citations: ChatResponse['citations'];
        confidence: number;
      }>;
    },
    answerProductQuestion(input) {
      return registry.execute(PRODUCT_TOOL_NAMES[1], input) as Promise<ChatResponse>;
    },
  };
}
