import type { ChatRequest, ChatResponse, RagIndex } from '@xxyy/shared';

import { createGroundedAnswer } from './answer.js';
import { classifyQuestion } from './classify.js';
import { loadRagConfig, type RagConfig } from './config.js';
import { retrieve } from './retrieve.js';

export interface ChatService {
  ask(request: ChatRequest): Promise<ChatResponse>;
}

export interface CreateChatServiceOptions {
  index: RagIndex;
  config?: Partial<RagConfig>;
}

export function createChatService(options: CreateChatServiceOptions): ChatService {
  const config = {
    ...loadRagConfig(),
    ...options.config,
  };

  return {
    ask(request: ChatRequest): Promise<ChatResponse> {
      const classification = classifyQuestion(request.message);
      const retrievedChunks = shouldRetrieve(classification.intent)
        ? retrieve(request.message, options.index, { topK: config.topK })
        : [];

      return Promise.resolve(
        createGroundedAnswer(request.message, classification, retrievedChunks),
      );
    },
  };
}

function shouldRetrieve(intent: ChatResponse['intent']): boolean {
  return intent === 'product_qa' || intent === 'how_to';
}
