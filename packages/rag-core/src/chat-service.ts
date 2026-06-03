import type { ChatRequest, ChatResponse, RagIndex } from '@xxyy/shared';

import { createBoundaryAnswer } from './answer.js';
import type { AnswerProvider } from './answer-provider.js';
import { classifyQuestion } from './classify.js';
import { loadRagConfig, type RagConfig } from './config.js';
import { createOpenAiAnswerProvider } from './openai-answer-provider.js';
import { retrieve } from './retrieve.js';

export interface ChatService {
  ask(request: ChatRequest): Promise<ChatResponse>;
}

export interface CreateChatServiceOptions {
  index: RagIndex;
  answerProvider?: AnswerProvider;
  config?: Partial<RagConfig>;
}

export function createChatService(options: CreateChatServiceOptions): ChatService {
  const config = {
    ...loadRagConfig(),
    ...options.config,
  };

  return {
    async ask(request: ChatRequest): Promise<ChatResponse> {
      const classification = classifyQuestion(request.message);
      if (!shouldRetrieve(classification.intent)) {
        return createBoundaryAnswer(classification);
      }

      const retrievedChunks = retrieve(request.message, options.index, { topK: config.topK });
      const answerProvider = options.answerProvider ?? createConfiguredAnswerProvider(config);

      return answerProvider.answer({
        classification,
        question: request.message,
        retrievedChunks,
      });
    },
  };
}

function shouldRetrieve(intent: ChatResponse['intent']): boolean {
  return intent === 'product_qa' || intent === 'how_to';
}

function createConfiguredAnswerProvider(config: RagConfig): AnswerProvider {
  if (config.answerProvider !== 'openai') {
    throw new Error(`Unsupported RAG_ANSWER_PROVIDER: ${config.answerProvider}`);
  }

  return createOpenAiAnswerProvider({
    apiKey: config.openAiApiKey,
    baseUrl: config.openAiBaseUrl,
    model: config.openAiModel,
  });
}
