import { createCustomerAgentChatService } from '@xxyy/agent-core';
import { createOpenAiEmbeddingProvider } from '@xxyy/knowledge';
import {
  createLazyRetriever,
  createOpenAiAnswerProvider,
  createPgPool,
  createPgVectorStore,
  noopQualityTracer,
  type AnswerProvider,
  type ChatService,
  type RagConfig,
  type QualityTracer,
} from '@xxyy/rag-core';

export interface TelegramChatRuntime {
  close(): Promise<void>;
  service: ChatService;
}

export function createTelegramChatRuntime(
  config: RagConfig,
  tracer: QualityTracer = noopQualityTracer,
): TelegramChatRuntime {
  let vectorPool: ReturnType<typeof createPgPool> | undefined;

  const retriever = createLazyRetriever(async () => {
    const nextPool = createPgPool(config.databaseUrl);

    try {
      const embeddingProvider = createOpenAiEmbeddingProvider({
        apiKey: config.embeddingApiKey,
        baseUrl: config.embeddingBaseUrl,
        maxRetries: config.openAiMaxRetries,
        model: config.openAiEmbeddingModel,
        requestTimeoutMs: config.openAiRequestTimeoutMs,
      });
      vectorPool = nextPool;
      return createPgVectorStore({
        client: nextPool,
        embeddingDimension: config.embeddingDimension,
        embeddingProvider,
        tracer,
      });
    } catch (error) {
      await nextPool.end();
      throw error;
    }
  });

  return {
    async close() {
      const pool = vectorPool;
      vectorPool = undefined;
      await pool?.end();
    },
    service: createCustomerAgentChatService({
      answerProvider: createLazyAnswerProvider(config, tracer),
      config,
      retriever,
      tracer,
    }),
  };
}

function createLazyAnswerProvider(config: RagConfig, tracer: QualityTracer): AnswerProvider {
  let cachedProvider: AnswerProvider | undefined;

  function getProvider(): AnswerProvider {
    cachedProvider ??= createOpenAiAnswerProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
      tracer,
    });
    return cachedProvider;
  }

  return {
    answer(input) {
      return getProvider().answer(input);
    },
    stream(input) {
      const provider = getProvider();
      if (provider.stream === undefined) {
        throw new Error('Answer provider does not support streaming.');
      }
      return provider.stream(input);
    },
  };
}
