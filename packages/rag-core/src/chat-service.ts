import type { ChatRequest, ChatResponse, ChatStreamEvent, RagIndex } from '@xxyy/shared';

import { createBoundaryAnswer } from './answer.js';
import type { AnswerProvider } from './answer-provider.js';
import { classifyQuestion } from './classify.js';
import { loadRagConfig, type RagConfig } from './config.js';
import { createOpenAiAnswerProvider } from './openai-answer-provider.js';
import { createLocalRetriever, type Retriever } from './retriever.js';
import { createConfiguredTxAnalysisProvider } from './tx-analysis-runtime.js';
import {
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  TxAnalysisProviderUnavailableError,
  TxAnalysisUnsupportedChainError,
  type TxAnalysisProvider,
} from './tx-analysis.js';
import { parseTransactionReference } from './tx-hash.js';

export interface ChatService {
  ask(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export interface CreateChatServiceOptions {
  index?: RagIndex;
  retriever?: Retriever;
  answerProvider?: AnswerProvider;
  txAnalysisProvider?: TxAnalysisProvider;
  config?: Partial<RagConfig>;
}

export function createChatService(options: CreateChatServiceOptions): ChatService {
  const config = {
    ...loadRagConfig(),
    ...options.config,
  };
  const retriever = createRetriever(options);
  const txAnalysisProvider =
    options.txAnalysisProvider ?? createConfiguredTxAnalysisProvider(config);

  return {
    async ask(request: ChatRequest): Promise<ChatResponse> {
      const classification = classifyQuestion(request.message);
      if (classification.intent === 'tx_sandwich_detection') {
        return answerTxAnalysis(request.message, txAnalysisProvider);
      }

      if (!shouldRetrieve(classification.intent)) {
        return createBoundaryAnswer(classification);
      }

      const retrievedChunks = await retriever.retrieve(request.message, { topK: config.topK });
      const answerProvider = options.answerProvider ?? createConfiguredAnswerProvider(config);

      return answerProvider.answer({
        classification,
        question: request.message,
        retrievedChunks,
      });
    },

    async *stream(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
      const classification = classifyQuestion(request.message);
      if (classification.intent === 'tx_sandwich_detection') {
        yield* streamChatResponse(await answerTxAnalysis(request.message, txAnalysisProvider));
        return;
      }

      if (!shouldRetrieve(classification.intent)) {
        yield* streamChatResponse(createBoundaryAnswer(classification));
        return;
      }

      const retrievedChunks = await retriever.retrieve(request.message, { topK: config.topK });
      const answerProvider = options.answerProvider ?? createConfiguredAnswerProvider(config);
      const input = {
        classification,
        question: request.message,
        retrievedChunks,
      };

      if (answerProvider.stream !== undefined) {
        yield* answerProvider.stream(input);
        return;
      }

      yield* streamChatResponse(await answerProvider.answer(input));
    },
  };
}

function createRetriever(options: CreateChatServiceOptions): Retriever {
  if (options.retriever !== undefined) {
    return options.retriever;
  }

  if (options.index !== undefined) {
    return createLocalRetriever(options.index);
  }

  throw new Error('createChatService requires either index or retriever.');
}

function shouldRetrieve(intent: ChatResponse['intent']): boolean {
  return intent === 'product_qa' || intent === 'how_to';
}

async function answerTxAnalysis(
  question: string,
  provider: TxAnalysisProvider | undefined,
): Promise<ChatResponse> {
  const reference = parseTransactionReference(question);
  if (reference === undefined) {
    return createTxAnalysisUnavailableAnswer('invalid_reference');
  }

  if (
    reference.unsupportedExplorerHost !== undefined ||
    reference.unsupportedChainHint !== undefined
  ) {
    return createTxAnalysisUnavailableAnswer('unsupported_chain', {
      metadata: {
        ...(reference.unsupportedExplorerHost === undefined
          ? {}
          : { unsupportedExplorerHost: reference.unsupportedExplorerHost }),
        ...(reference.unsupportedChainHint === undefined
          ? {}
          : { unsupportedChainHint: reference.unsupportedChainHint }),
      },
    });
  }

  if (provider === undefined) {
    return createTxAnalysisUnavailableAnswer('not_configured');
  }

  try {
    return createTxAnalysisAnswer(await provider.analyze(reference));
  } catch (error) {
    if (error instanceof TxAnalysisProviderUnavailableError) {
      return createTxAnalysisUnavailableAnswer(error.reason, {
        ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
        ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
      });
    }
    if (error instanceof TxAnalysisUnsupportedChainError) {
      return createTxAnalysisUnavailableAnswer('unsupported_chain', {
        ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
        ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
      });
    }

    throw error;
  }
}

function createConfiguredAnswerProvider(config: RagConfig): AnswerProvider {
  if (config.answerProvider !== 'openai') {
    throw new Error(`Unsupported RAG_ANSWER_PROVIDER: ${config.answerProvider}`);
  }

  return createOpenAiAnswerProvider({
    apiKey: config.openAiApiKey,
    baseUrl: config.openAiBaseUrl,
    maxRetries: config.openAiMaxRetries,
    model: config.openAiModel,
    requestTimeoutMs: config.openAiRequestTimeoutMs,
  });
}

function streamChatResponse(response: ChatResponse): AsyncIterable<ChatStreamEvent> {
  return toAsyncIterable([
    ...(response.answer.length > 0
      ? [{ type: 'answer_delta' as const, delta: response.answer }]
      : []),
    {
      type: 'metadata',
      ...(response.attachments === undefined ? {} : { attachments: response.attachments }),
      citations: response.citations,
      confidence: response.confidence,
      intent: response.intent,
    },
  ]);
}

async function* toAsyncIterable<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}
